import { z } from "zod";
import { llmCompleteJson, LlmConfigError } from "./llmClient";
import { countOpenTags } from "./htmlAuditFacts";
import { chunkHtmlForLlm, DEFAULT_MAX_PAYLOAD_BYTES } from "./htmlForLlm";
import { computeHtmlTextMetrics } from "./htmlTextMetrics";

const AuditIssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  issue: z.string().min(1),
  recommendation: z.string().min(1),
  htmlSnippet: z.string().min(1),
});

const AuditScoreSchema = z.object({
  score: z.number().min(0).max(100),
  issues: z.array(AuditIssueSchema),
});

export type AuditScore = z.infer<typeof AuditScoreSchema>;

const DocAudit = z.object({
  size: z.number().min(0),
  recommendation: z.string().min(1),
});

export type AuditDocSchema = z.infer<typeof DocAudit>;

const AllAuditScoreSchema = z.object({
  llmFriendly: AuditScoreSchema,
  w3cCompliance: AuditScoreSchema,
  seo: AuditScoreSchema,
  semanticHtml: AuditScoreSchema,
  accessibility: AuditScoreSchema,
  docSize: DocAudit,
});

export type AllAuditScore = z.infer<typeof AllAuditScoreSchema>;

const RUBRICS = {
  llmFriendly: `HTML reviewer for machine+human readers; assume no-JS crawling. Flag: wrong/skipped/duplicate heading levels, weak landmark coverage (<main>, nav), layout tables, schema/microdata gaps, duplicate blocks, deep wrapper nesting, hidden text, JS-only content. Every avoidable wrapper is a finding. Prefer many specific issues over a high score.`,

  w3cCompliance: `Parser-level HTML validator. Detect: invalid parent-child nesting, malformed table/list/form structure, nested interactives, bad label associations, heading order errors, duplicate IDs, deprecated tags/attrs, block elements in prohibited parents. Enforce direct-child rules for: dl, ul, ol, table, tr, thead, tbody, select, picture, ruby. VALID: <div><p>…</p></div>, block inside <div>, valid nested sectioning. Never invent invalid rules. Repeated violations must cut score.`,

  seo: `SEO pre-launch audit. Check: title/meta-description length, canonical, robots, hreflang, title/desc consistency, heading keyword fit (no stuffing), internal link anchor quality, JSON-LD presence+entity correctness, FAQ/HowTo/Product schema misuse, pagination, mobile meta. Flag every defensible gap. Out of scope: site authority, og:* tags (never report).`,

  semanticHtml: `Parser-level semantic HTML validator. Enforce: landmarks, heading hierarchy, lists, tables, forms, button-vs-link, figure/figcaption, minimal div/span. Flag: div/span soup; missing/redundant landmarks; section/article without heading; wrong heading order; style-only headings; layout tables; misused article/section/nav/aside/main/header/footer; visual lists/nav without semantic markup; ARIA-vs-native conflicts; invalid parent-child. Enforce content-model: dl→dt/dd only; ul/ol→li only; valid select/table children; no block inside p; no nested interactives; valid label association; valid figure. Inspect each element individually — distinct DOM nodes = separate findings; group only when same structural pattern. VALID: <div><p>…</p></div>. Weakness→warning; content-model violation→error. Never invent invalid rules.`,

  accessibility: `WCAG 2.1 A/AA (HTML-inferable only). Flag: missing/wrong html[lang], heading hierarchy breaks, missing/empty image alt, unlabelled form controls, new-window links without text warning, skip link absent on complex layouts, keyboard-trap markup, tabindex misuse, wrong/redundant ARIA roles, aria-hidden on important content, missing radio fieldset, missing table headers, positive-tabindex focus risks. error=rule break; warning=likely issue; info=best practice. More findings over benefit of the doubt.`,

  docSize: `Payload + markup bloat. HTML-to-text ratio is pre-computed and provided — cite it in recommendation. Flag: inline styles, inlined JSON-LD/data blobs, redundant script/link tags, duplicate CSS, deep wrapper nesting. Recommendation: 3–6 concrete tactics (semicolons or numbered steps).`,
};

type GroundTruth = { h1Count: number; mainCount: number; html: string };

const OG_RE = /\bopen\s*graph\b|\bog:[a-z_-]+/i;
const H1_PROXIMITY_RE = /(\bh1\b|<h1|h1\s+(?:tag|element|heading))/i;
const MAIN_PROXIMITY_RE = /(<main\b|\bmain\s+(?:landmark|tag|element|content|region)\b)/i;
const MISSING_RE = /\b(?:missing|absent|lack(?:ing|s)?|without|no|none)\b/i;
const DUPLICATE_RE = /\b(?:multiple|duplicate|several|more\s+than\s+one|two\s+or\s+more)\b/i;

const SEMANTIC_WRAP_TARGETS = [
  "article",
  "section",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "figure",
];

const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Walk forward from byte 0 to `position`, counting open vs close tags per name.
 * Names whose running balance is > 0 at `position` are open ancestors of that
 * position. Self-closing and void elements are excluded.
 */
function ancestorOpenTagsAt(html: string, position: number): Set<string> {
  const open = new Set<string>();
  if (!html || position <= 0) return open;
  const counts = new Map<string, number>();
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index >= position) break;
    const isClose = m[1] === "/";
    const name = m[2]!.toLowerCase();
    const selfClose = m[3] === "/";
    if (selfClose) continue;
    if (HTML_VOID_ELEMENTS.has(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + (isClose ? -1 : 1));
  }
  counts.forEach((v, k) => {
    if (v > 0) open.add(k);
  });
  return open;
}

/** Extract semantic element names that the issue/recommendation is suggesting to use. */
function detectSuggestedSemanticElements(text: string): string[] {
  const found = new Set<string>();
  for (const tag of SEMANTIC_WRAP_TARGETS) {
    const re = new RegExp(
      `(?:<${tag}\\b)` + // explicit `<article>` / `<section ...>`
        `|(?:wrap[a-z]*\\s+(?:in|with|inside)\\s+(?:an?\\s+)?<?${tag}\\b)` + // "wrap in <article>"
        `|(?:use\\s+(?:an?\\s+)?<?${tag}\\b)` + // "use <article>"
        `|(?:replace[\\s\\S]{0,60}with\\s+<?${tag}\\b)`, // "replace ... with <article>"
      "i"
    );
    if (re.test(text)) found.add(tag);
  }
  return Array.from(found);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type SnippetIdents = {
  ids: string[];
  classSets: string[][];
  dataAttrs: { name: string; value: string }[];
};

function extractSnippetIdentifiers(snippet: string): SnippetIdents {
  const ids = Array.from(snippet.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi))
    .map((m) => m[1]!.trim())
    .filter(Boolean);
  const classSets: string[][] = [];
  for (const m of Array.from(
    snippet.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)
  )) {
    const tokens = m[1]!.split(/\s+/).filter(Boolean);
    if (tokens.length > 0) classSets.push(tokens);
  }
  const dataAttrs = Array.from(
    snippet.matchAll(/\b(data-[a-zA-Z0-9-]+)\s*=\s*["']([^"']+)["']/gi)
  ).map((m) => ({ name: m[1]!, value: m[2]! }));
  return { ids, classSets, dataAttrs };
}

function attrsMatchAny(attrsString: string, idents: SnippetIdents): boolean {
  for (const id of idents.ids) {
    const re = new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(id)}["']`, "i");
    if (re.test(attrsString)) return true;
  }
  if (idents.classSets.length > 0) {
    const cm = attrsString.match(/\bclass\s*=\s*["']([^"']+)["']/i);
    if (cm) {
      const present = new Set(cm[1]!.split(/\s+/).filter(Boolean));
      for (const tokens of idents.classSets) {
        if (tokens.every((t) => present.has(t))) return true;
      }
    }
  }
  for (const d of idents.dataAttrs) {
    const re = new RegExp(
      `\\b${escapeRegExp(d.name)}\\s*=\\s*["']${escapeRegExp(d.value)}["']`,
      "i"
    );
    if (re.test(attrsString)) return true;
  }
  return false;
}

/** Walk all element open tags in `html` and return the ones whose attributes match any identifier in `idents`. */
function findCandidateElementsByIdentifiers(
  html: string,
  idents: SnippetIdents,
  max = 32
): { index: number; tagName: string }[] {
  const out: { index: number; tagName: string }[] = [];
  if (
    !html ||
    (idents.ids.length === 0 &&
      idents.classSets.length === 0 &&
      idents.dataAttrs.length === 0)
  ) {
    return out;
  }
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tagName = m[1]!.toLowerCase();
    const attrs = m[2] || "";
    if (attrsMatchAny(attrs, idents)) {
      out.push({ index: m.index, tagName });
      if (out.length >= max) break;
    }
  }
  return out;
}

function allOccurrenceIndices(
  haystack: string,
  needle: string,
  max = 32
): number[] {
  const out: number[] = [];
  if (!needle || !haystack) return out;
  let from = 0;
  while (out.length < max) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/**
 * True iff every candidate element matching the snippet (by literal string OR by
 * id/class/data identifier — covering LLM tag-name hallucinations) is ALREADY
 * either of the suggested semantic elements itself, or has one as an ancestor.
 */
function isAlreadySatisfiedBySuggestion(
  fullHtml: string,
  htmlSnippet: string,
  suggested: string[]
): boolean {
  if (!fullHtml || !htmlSnippet || suggested.length === 0) return false;

  const candidates: { index: number; tagName: string }[] = [];
  const literalTagMatch = htmlSnippet.match(/<([a-zA-Z][a-zA-Z0-9-]*)/);
  const literalTag = literalTagMatch?.[1]?.toLowerCase() ?? "";
  for (const idx of allOccurrenceIndices(fullHtml, htmlSnippet)) {
    candidates.push({ index: idx, tagName: literalTag });
  }
  if (candidates.length === 0) {
    const idents = extractSnippetIdentifiers(htmlSnippet);
    candidates.push(...findCandidateElementsByIdentifiers(fullHtml, idents));
  }
  if (candidates.length === 0) return false;

  return candidates.every(({ index, tagName }) => {
    if (suggested.includes(tagName)) return true;
    const ancestors = ancestorOpenTagsAt(fullHtml, index);
    return suggested.some((t) => ancestors.has(t));
  });
}

/**
 * Drop issues that contradict our static ground-truth counts (so the LLM cannot
 * report "missing <h1>" when the page has one) or that touch out-of-scope
 * subjects (Open Graph). Runs after the LLM, before merge dedup.
 */
export function filterIssuesAgainstGroundTruth(
  issues: AuditScore["issues"],
  gt: GroundTruth
): { kept: AuditScore["issues"]; dropped: number } {
  let dropped = 0;
  const kept: AuditScore["issues"] = [];
  for (const iss of issues) {
    const subject = `${iss.issue} ${iss.recommendation || ""}`;
    if (OG_RE.test(subject)) {
      dropped++;
      continue;
    }
    if (H1_PROXIMITY_RE.test(iss.issue)) {
      if (gt.h1Count >= 1 && MISSING_RE.test(iss.issue)) {
        dropped++;
        continue;
      }
      if (gt.h1Count <= 1 && DUPLICATE_RE.test(iss.issue)) {
        dropped++;
        continue;
      }
    }
    if (MAIN_PROXIMITY_RE.test(iss.issue)) {
      if (gt.mainCount >= 1 && MISSING_RE.test(iss.issue)) {
        dropped++;
        continue;
      }
      if (gt.mainCount <= 1 && DUPLICATE_RE.test(iss.issue)) {
        dropped++;
        continue;
      }
    }
    const suggested = detectSuggestedSemanticElements(subject);
    if (
      suggested.length > 0 &&
      iss.htmlSnippet &&
      isAlreadySatisfiedBySuggestion(gt.html, iss.htmlSnippet, suggested)
    ) {
      dropped++;
      continue;
    }
    kept.push(iss);
  }
  return { kept, dropped };
}

/**
 * Merge per-chunk scores into a single AllAuditScore.
 * - Per criterion score: rounded mean across chunks.
 * - Per criterion issues: filtered against ground truth (static h1/main counts,
 *   Open Graph exclusion), concatenated, deduped (severity + lowercased issue
 *   head), capped at 30.
 * - docSize.size is taken from the original `htmlSize`; recommendation is the first
 *   non-empty per-chunk recommendation.
 */
function mergeAllAuditScores(
  perChunk: AllAuditScore[],
  htmlSize: number,
  gt: GroundTruth,
  deterministicSemanticIssues: AuditScore["issues"] = []
): AllAuditScore {
  let totalDropped = 0;
  const mergeOne = (key: keyof Omit<AllAuditScore, "docSize">): AuditScore => {
    const scores = perChunk.map((c) => c[key]);
    if (scores.length === 0) return { score: 0, issues: [] };
    const llmScore = Math.round(
      scores.reduce((a, s) => a + s.score, 0) / scores.length
    );
    const seen = new Set<string>();
    const issues: AuditScore["issues"] = [];
    let droppedHere = 0;
    for (const s of scores) {
      const { kept, dropped } = filterIssuesAgainstGroundTruth(s.issues, gt);
      droppedHere += dropped;
      totalDropped += dropped;
      for (const iss of kept) {
        const normalizedSnippet = iss.htmlSnippet
          ?.replace(/\s+/g, " ")
          ?.slice(0, 120);

        const k =
          key === "semanticHtml" || key === "w3cCompliance"
            ? `${iss.severity}|${iss.issue}|${normalizedSnippet}`
            : `${iss.severity}|${iss.issue.toLowerCase().trim().slice(0, 100)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        issues.push(iss);
      }
    }
    // The LLM's score reflects the issues IT saw. If our filter removed all of
    // them as false positives, refund credit per filtered issue (cap 100) so a
    // criterion that lost 1 false positive doesn't end up at the same place as
    // one that lost 5. No fixed floor: the LLM's overall assessment may still
    // warrant a low score for reasons beyond the filtered issues. We only apply
    // when no issues remain — otherwise raising the score next to a visible
    // issue list would feel inconsistent.
    let finalScore = llmScore;
    if (droppedHere > 0 && issues.length === 0) {
      const REFUND_PER_DROPPED = 4;
      finalScore = Math.min(100, llmScore + droppedHere * REFUND_PER_DROPPED);
    }
      const ISSUE_CAPS: Record<string, number> = {
        semanticHtml: 120,
        w3cCompliance: 80,
        accessibility: 60,
        seo: 40,
        llmFriendly: 40,
      };

      return {
        score: finalScore,
        issues: issues.slice(0, ISSUE_CAPS[key] ?? 40),
      };
  };

  const firstRec =
    perChunk.find((c) => c.docSize.recommendation?.trim().length)
      ?.docSize.recommendation ?? "";

  const merged = {
    llmFriendly: mergeOne("llmFriendly"),
    w3cCompliance: mergeOne("w3cCompliance"),
    seo: mergeOne("seo"),
    semanticHtml: (() => {
  const mergedSemantic = mergeOne("semanticHtml");

  const normalizeSnippet = (s: string) =>
  s
    ?.replace(/\s+/g, " ")
    ?.replace(/>\s+</g, "><")
    ?.trim()
    ?.slice(0, 300);

const existing = new Set(
  mergedSemantic.issues.map(
    (x) => `${x.issue}|${normalizeSnippet(x.htmlSnippet)}`
  )
)

  for (const issue of deterministicSemanticIssues) {
    const k = `${issue.issue}|${normalizeSnippet(issue.htmlSnippet)}`;

    if (!existing.has(k)) {
      mergedSemantic.issues.unshift(issue);
    }
  }

  mergedSemantic.score = Math.max(
    0,
    mergedSemantic.score - deterministicSemanticIssues.length * 2
  );

  return mergedSemantic;
})(),
    accessibility: mergeOne("accessibility"),
    docSize: { size: htmlSize, recommendation: firstRec },
  };

  if (totalDropped > 0) {
    console.log(
      `[evaluateAllWithLlm] filtered ${totalDropped} issue(s) by ground-truth (h1=${gt.h1Count}, main=${gt.mainCount}, OG out-of-scope)`
    );
  }
  return merged;
}

function makeFallbackAllResult(issue: string, recommendation: string): AllAuditScore {
  const entry: AuditScore = {
    score: 0,
    issues: [{ severity: "error", issue, recommendation, htmlSnippet: "Page not accessed" }],
  };

  return {
    llmFriendly: entry,
    w3cCompliance: entry,
    seo: entry,
    semanticHtml: entry,
    accessibility: entry,
    docSize: {
      size: 0,
      recommendation,
    },
  };
}

export function runDeterministicSemanticChecks(html: string): AuditScore["issues"] {
  const issues: AuditScore["issues"] = [];
  const seen = new Set<string>();
  const directChildRules: Record<string, string[]> = {
    dl: ["dt", "dd", "script", "template"],
    ul: ["li", "script", "template"],
    ol: ["li", "script", "template"],
    select: ["option", "optgroup", "script", "template"],
    thead: ["tr", "script", "template"],
    tbody: ["tr", "script", "template"],
    tfoot: ["tr", "script", "template"],
    tr: ["td", "th", "script", "template"],
  };

  for (const [parentTag, allowedChildren] of Object.entries(
    directChildRules
  )) {
    const parentRegex = new RegExp(
      `<${parentTag}\\b[^>]*>([\\s\\S]*?)<\\/${parentTag}>`,
      "gi"
    );

    let parentMatch: RegExpExecArray | null;

    while ((parentMatch = parentRegex.exec(html)) !== null) {
      const parentHtml = parentMatch[0];
      const innerHtml = parentMatch[1];

      let depth = 0;

      const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;

      let tagMatch: RegExpExecArray | null;

      while ((tagMatch = tagRegex.exec(innerHtml)) !== null) {
        const fullTag = tagMatch[0];
        const tagName = tagMatch[1].toLowerCase();
        const isClosing = fullTag.startsWith("</");
        const selfClosing = fullTag.endsWith("/>");

        if (!isClosing) {
          if (depth === 0) {
            if (!allowedChildren.includes(tagName)) {
              const dedupKey =
                `${parentTag}|${tagName}|` +
                parentHtml.replace(/\s+/g, " ").slice(0, 300);

              if (seen.has(dedupKey)) {
                continue;
              }

              seen.add(dedupKey);
              issues.push({
                severity: "error",
                issue: `<${parentTag}> has invalid direct child <${tagName}>`,
                recommendation: `Replace <${tagName}> with a valid direct child for <${parentTag}> or move it outside the <${parentTag}>.`,
                htmlSnippet: parentHtml.slice(0, 400),
              });
            }
          }

          if (!selfClosing) {
            depth++;
          }
        } else {
          depth = Math.max(0, depth - 1);
        }
      }
    }
  }

  return issues;
}

export async function evaluateAllWithLlm(
  html: string, llm_api_key: string, llm_model: string
): Promise<{ allAuditScore: AllAuditScore }> {
  const combinedRubric = [
    "--- LLM-Friendly HTML (llmFriendly) ---",
    RUBRICS.llmFriendly,
    "",
    "--- W3C / HTML Validity (w3cCompliance) ---",
    RUBRICS.w3cCompliance,
    "",
    "--- SEO (seo) ---",
    RUBRICS.seo,
    "",
    "--- Semantic HTML (semanticHtml) ---",
    RUBRICS.semanticHtml,
    "",
    "--- Accessibility / WCAG (accessibility) ---",
    RUBRICS.accessibility,
  ].join("\n");

  try {
    const htmlSize = Buffer.byteLength(html, "utf8");
    const h1Count = countOpenTags(html, "h1");
    const mainCount = countOpenTags(html, "main");
    const { htmlToTextRatio } = computeHtmlTextMetrics(html);
    const deterministicSemanticIssues =
  runDeterministicSemanticChecks(html);

    const { chunks, originalBytes, preparedBytes, totalChunkBytes, chunked } =
      chunkHtmlForLlm(html, DEFAULT_MAX_PAYLOAD_BYTES);
    console.log(
      `[evaluateAllWithLlm] originalBytes=${originalBytes} preparedBytes=${preparedBytes} totalChunkBytes=${totalChunkBytes} chunks=${chunks.length} chunked=${chunked}`
    );

    const systemPrompt =
      "Strict parser-level HTML validator and semantic engine, not a design reviewer. " +
      "Inspect each DOM element individually; validate parent-child relationships, content-model rules, landmark usage, and structural correctness. " +
      "Prefer false positives downgraded to warning/info over missed violations. Never invent invalid HTML rules. " +
      "Input is preprocessed: scripts, JSON-LD, styles, and inline style= removed; HTML may be chunked — do not flag absent scripts/styles/JSON. " +
      "Distinct structural violations on separate DOM nodes must be reported separately. " +
      "Return ONLY valid JSON (no markdown). Recommendations must name elements, attributes, or show example patterns.";

    const buildUserPrompt = (chunk: string, idx: number, total: number): string =>
      [
        total > 1
          ? `Evaluate HTML CHUNK ${idx + 1}/${total} across all five criteria; return a JSON object covering only what is visible in this chunk.`
          : "Evaluate the HTML across all five criteria; return a single JSON object.",
        "",
        "Schema:",
        '{ "llmFriendly":{"score":0-100,"issues":[...]}, "w3cCompliance":{"score":0-100,"issues":[...]}, "seo":{"score":0-100,"issues":[...]}, "semanticHtml":{"score":0-100,"issues":[...]}, "accessibility":{"score":0-100,"issues":[...]}, "docSize":{"size":number,"recommendation":""} }',
        'Issue: { "severity":"error"|"warning"|"info", "issue":string, "recommendation":string, "htmlSnippet":string }',
        "htmlSnippet: smallest real DOM fragment from the source HTML; exact tag names/attrs; include invalid parent-child for content-model violations.",
        "",
        "Scores: 95–100 near-perfect; 80–94 solid with fixable gaps; 60–79 typical production gaps; 40–59 release-blocking; 0–39 severe. Be skeptical — complex/long HTML skews lower.",
        "Issues: 15–40+ distinct evidence-backed findings per criterion (severity→importance). Separate DOM nodes = separate findings; group only when same structural pattern. semanticHtml/w3cCompliance: validator mode. Repeated violations cut score.",
        "",
        `- HTML-to-text ratio: ${htmlToTextRatio.toFixed(2)} (markup bytes incl. tags ÷ visible text chars; scripts/CSS/JSON excluded). ≤5 lean; 5–15 normal; 15–30 bloat; >30 heavy. Cite in docSize recommendation.`,
        `- <h1> count: ${h1Count}. ${h1Count >= 1 ? "MUST NOT report missing h1 (hierarchy/wording critique OK)." : "May report missing h1."} ${h1Count <= 1 ? "MUST NOT report duplicate h1." : `Duplicate h1 flaggable (count=${h1Count}).`}`,
        `- <main> count: ${mainCount}. ${mainCount >= 1 ? "MUST NOT report missing main." : "May report missing main."} ${mainCount <= 1 ? "MUST NOT report multiple main." : `Multiple main flaggable (count=${mainCount}).`}`,
        "- OUT OF SCOPE: og:* / Open Graph tags — never report.",
        "",
        "Semantic-wrapper rule: before suggesting wrap/replace with article/section/main/header/footer/nav/aside/figure — verify element is not already that tag and has no ancestor of that tag in the HTML. Copy exact opening tag from source into htmlSnippet. Skip if already satisfied.",
        "",
        total > 1
          ? "Chunked page: chunk 1 has <head> (SEO/meta/lang/canonical findings). Skip cross-chunk uniqueness checks — report only what is visible in this chunk."
          : "",
        "",
        combinedRubric,
        "",
        "HTML to audit:",
        chunk,
      ]
        .filter(Boolean)
        .join("\n");

    const TRANSIENT_ERR_RE =
      /upstream\s*(?:request|response)?\s*timeout|upload\s*stream\s*timeout|gateway\s*timeout|service\s*unavailable|temporarily\s*unavailable|read\s*timed?\s*out|aborted|abort\s*err|fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket\s+hang/i;

    /**
     * Run a chunk through the LLM. On transient failure (upstream timeout,
     * gateway timeout, network error), recursively split the chunk in half and
     * retry each half. This is a safety net on top of the per-call retries in
     * llmClient.ts: if a chunk is just too big/slow for the gateway, halving it
     * usually succeeds.
     */
    const evaluateChunk = async (
      content: string,
      idx: number,
      total: number,
      depth: number
    ): Promise<AllAuditScore[]> => {
      const tag = `${idx + 1}/${total}${depth > 0 ? ` d${depth}` : ""}`;
      try {
        const raw = await llmCompleteJson(llm_api_key, llm_model, [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildUserPrompt(content, idx, total) },
        ]);
        const json = JSON.parse(raw);
        const parsed = AllAuditScoreSchema.safeParse(json);
        if (parsed.success) return [parsed.data];
        console.warn(
          `[evaluateAllWithLlm] chunk ${tag} returned invalid JSON shape; skipping`
        );
        return [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = TRANSIENT_ERR_RE.test(msg);
        const MIN_SHRINK_BYTES = 8 * 1024;
        const MAX_SHRINK_DEPTH = 3;
        if (
          transient &&
          depth < MAX_SHRINK_DEPTH &&
          Buffer.byteLength(content, "utf8") > MIN_SHRINK_BYTES
        ) {
          const half = Math.floor(content.length / 2);
          const a = content.slice(0, half);
          const b = content.slice(half);
          console.warn(
            `[evaluateAllWithLlm] chunk ${tag} transient failure; shrink-and-retry. err: ${msg.slice(0, 160)}`
          );
          const [ra, rb] = await Promise.all([
            evaluateChunk(a, idx, total, depth + 1),
            evaluateChunk(b, idx, total, depth + 1),
          ]);
          return [...ra, ...rb];
        }
        console.warn(
          `[evaluateAllWithLlm] chunk ${tag} gave up (depth=${depth}, transient=${transient}): ${msg.slice(0, 240)}`
        );
        return [];
      }
    };

    /** Bounded-parallel runner: keeps `concurrency` chunks in flight at any time. */
    const runWithConcurrency = async <R,>(
      items: string[],
      concurrency: number,
      task: (item: string, idx: number) => Promise<R>
    ): Promise<R[]> => {
      const results: R[] = new Array(items.length);
      let cursor = 0;
      const workers = Array.from(
        { length: Math.max(1, Math.min(concurrency, items.length)) },
        async () => {
          while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await task(items[i]!, i);
          }
        }
      );
      await Promise.all(workers);
      return results;
    };

    const CHUNK_CONCURRENCY = 3;
    const perChunkArrays = await runWithConcurrency(
      chunks,
      CHUNK_CONCURRENCY,
      (chunkContent, i) => evaluateChunk(chunkContent, i, chunks.length, 0)
    );
    const perChunk: AllAuditScore[] = perChunkArrays.flat();
    console.log(
      `[evaluateAllWithLlm] perChunk results=${perChunk.length} (from ${chunks.length} top-level chunks, concurrency=${CHUNK_CONCURRENCY})`
    );

    if (perChunk.length === 0) {
      return {
        allAuditScore: makeFallbackAllResult(
          "LLM returned invalid audit JSON",
          "Adjust LLM_MODEL or provider settings; ensure the model can follow strict JSON instructions."
        ),
      };
    }

    const merged = mergeAllAuditScores(perChunk, htmlSize, {
      h1Count,
      mainCount,
      html,
    },deterministicSemanticIssues
  );
    return { allAuditScore: merged };
  } catch (e) {
    if (e instanceof LlmConfigError) {
      return {
        allAuditScore: makeFallbackAllResult(
          "LLM not configured for runtime auditing",
          "Add an API key and model in the app Settings, or set LLM_PROVIDER, LLM_API_KEY, and optional LLM_MODEL / LLM_BASE_URL on the server."
        ),
      };
    }

    return {
      allAuditScore: makeFallbackAllResult(
        "LLM audit failed at runtime",
        e instanceof Error ? e.message : "Check server logs and LLM provider connectivity/credentials."
      ),
    };
  }
}