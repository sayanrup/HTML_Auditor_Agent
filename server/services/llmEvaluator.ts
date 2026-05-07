import { z } from "zod";
import { llmCompleteJson, LlmConfigError } from "./llmClient";
import { countOpenTags } from "./htmlAuditFacts";
import { chunkHtmlForLlm, DEFAULT_MAX_PAYLOAD_BYTES } from "./htmlForLlm";

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
  llmFriendly: `Act as a harsh senior reviewer optimizing HTML for machine and human readers. Assume the page will be crawled, archived, and parsed by tools with no JavaScript.
Be exhaustive: heading order and count (missing, duplicate, or skipped levels), one clear topical <h1>, landmark coverage (<main>, nav regions), link and button text quality (avoid "click here", empty anchors, icon-only controls without accessible names in markup), media and embed noise, tables used for layout, microdata/schema gaps that hurt extraction, duplicate or boilerplate blocks, deep wrapper chains, meaningless class/id soup, hidden text tricks, and reliance on client-only rendering.
Treat "good enough" marketing HTML as mediocre: every avoidable div wrapper, unclear section boundary, or weak list/table structure is a finding. Prefer many specific issues with actionable recommendations over a high score.`,

  w3cCompliance: `Apply a strict, checklist-driven HTML5 review. Penalize heavily for: missing or wrong doctype, missing charset or viewport, malformed or duplicate attributes, unquoted attribute edge cases, obsolete elements (font, center, marquee, etc.), deprecated attributes, bad nesting (e.g. <p> wrapping block-level interactive content), duplicate id values, void elements written incorrectly, inconsistent quoting, and any pattern that would likely fail validation or confuse parsers.
Also flag probable spec violations when the markup strongly suggests them (e.g. interactive inside interactive, invalid label associations). Do not invent arbitrary line numbers, but do infer from the snippet what is wrong. When unsure between error vs warning, prefer warning with a clear caveat.`,
  seo: `Audit like an SEO lead before launch. Scrutinize: title length and uniqueness, meta description length and duplication, canonical and robots directives, hreflang hints if present, Twitter Card completeness and consistency with title/description, heading keyword alignment without stuffing, image alts for meaningful images, internal link quality (generic anchor text, nofollow misuse), thin or duplicate body copy signals, JSON-LD presence, correctness and entity coverage, FAQ/HowTo/Product misuse, pagination/meta robots, and mobile-oriented meta.
List every defensible improvement (missing tags, weak copy, missing structured data for obvious product/article/listing pages, etc.). Site-wide authority is out of scope; Open Graph (og:*) tags are explicitly out of scope and must NOT be reported. Everything else in the HTML is fair game.`,
  semanticHtml: `Judge semantic structure harshly. Expect appropriate use of header/nav/main/footer/article/section/aside, lists for lists, buttons vs links used correctly, figure/figcaption for meaningful images, table thead/tbody/th scope, forms with fieldset/legend where helpful, and minimal div-only layout.
Flag: div/span soup where a semantic element exists, multiple mains, missing main on content-heavy pages, section without heading, incorrect heading order, orphaned list items, tables for non-tabular data, misuse of headings for styling, and landmark redundancy or absence. Err on the side of more warnings when semantics are weak even if the page "works".`,

  accessibility: `Use a WCAG 2.1 mindset (A/AA where inferable from HTML only). Aggressively flag: missing or wrong lang on html, missing document title, heading hierarchy breaks, images missing or useless alt, decorative images not marked, form controls without labels or with poor label association, placeholder-only labels, links opening in new windows without warning in text, skip link absence on complex layouts, keyboard traps suggested by markup, tabindex abuse, redundant or wrong ARIA roles, aria-hidden on important content, missing fieldset for radio groups, table headers missing, and focus order risks from tabindex or positive tabindex.
Use severity: error when the HTML clearly breaks a rule; warning when likely problematic; info for best-practice upgrades. Prefer more findings with concrete markup fixes over giving the benefit of the doubt.`,

  docSize: `Assess payload weight and markup bloat. Call out inline styles, large JSON-LD or data blobs in HTML, redundant third-party script/link tags, duplicate CSS links, and opportunities to defer, bundle, or move config off the critical HTML path. The recommendation string must list 3–6 concrete, prioritized tactics (short clauses separated by semicolons or numbered steps).`,
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
  gt: GroundTruth
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
        const k = `${iss.severity}|${iss.issue.toLowerCase().trim().slice(0, 100)}`;
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
    return { score: finalScore, issues: issues.slice(0, 30) };
  };

  const firstRec =
    perChunk.find((c) => c.docSize.recommendation?.trim().length)
      ?.docSize.recommendation ?? "";

  const merged = {
    llmFriendly: mergeOne("llmFriendly"),
    w3cCompliance: mergeOne("w3cCompliance"),
    seo: mergeOne("seo"),
    semanticHtml: mergeOne("semanticHtml"),
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

    const { chunks, originalBytes, preparedBytes, totalChunkBytes, chunked } =
      chunkHtmlForLlm(html, DEFAULT_MAX_PAYLOAD_BYTES);
    console.log(
      `[evaluateAllWithLlm] originalBytes=${originalBytes} preparedBytes=${preparedBytes} totalChunkBytes=${totalChunkBytes} chunks=${chunks.length} chunked=${chunked}`
    );

    const systemPrompt =
      "You are a strict, adversarial HTML auditing engine used before production release. " +
      "Your job is to maximize useful defects found: prefer false positives downgraded to info over false negatives, " +
      "but never contradict the verified structural counts in the GROUND TRUTH block (those are machine-counted). " +
      "Inputs may be a stripped/reduced version of the page (scripts, JSON-LD, styles and inline style= are removed) and may be split into chunks; do not flag missing scripts, styles, or JSON when those were stripped. " +
      "Return ONLY valid JSON (no markdown fences, no commentary). " +
      "Every recommendation must be specific enough that a developer could apply it without guessing (name elements/attributes, suggest replacement tags or patterns).";

    const buildUserPrompt = (chunk: string, idx: number, total: number): string =>
      [
        total > 1
          ? `Evaluate the provided HTML CHUNK ${idx + 1} of ${total} across all five scored criteria below and return a single JSON object covering only what is visible in this chunk.`
          : "Evaluate the provided HTML across all five scored criteria below and return a single JSON object.",
        "",
        "Return JSON with this exact schema:",
        '{ "llmFriendly": { "score": number(0-100), "issues": [...] }, "w3cCompliance": { "score": number(0-100), "issues": [...] }, "seo": { "score": number(0-100), "issues": [...] }, "semanticHtml": { "score": number(0-100), "issues": [...] }, "accessibility": { "score": number(0-100), "issues": [...] }, "docSize":{"size": number, "recommendation":""} }',
        "",
        'Each issue: { "severity": "error"|"warning"|"info", "issue": string, "recommendation": string (required: at least one concrete fix — element name, attribute, or example snippet), "htmlSnippet": string }',
        "",
        "htmlSnippet: smallest meaningful DOM fragment; always prefer id=, class=, data-testid=, href=, or data-* from the real HTML so issues can be traced to source later.",
        "",
        "Scoring calibration (apply to every criterion):",
        "- 95–100: exceptionally rare; essentially no meaningful defects under this rubric.",
        "- 80–94: strong but still has several minor or moderate issues worth fixing.",
        "- 60–79: typical production marketing/content pages with multiple clear gaps.",
        "- 40–59: serious problems; would block a strict release review.",
        "- 0–39: severe or pervasive failures.",
        "- Default skeptical: if the HTML is long or complex, scores should skew lower unless evidence supports high quality.",
        "",
        "Issue volume:",
        "- Emit as many DISTINCT, evidence-backed issues as you can per criterion (cap 20 per criterion), ordered by severity then importance.",
        "- Do not duplicate the same finding; split overlapping concerns into separate issues only when each has a distinct fix.",
        "- For large documents, aim for double-digit issues per criterion when the markup provides enough surface area.",
        "",
        "GROUND TRUTH (static parse of the FULL document, not just this chunk; script/style/template/noscript/comments removed). These counts are authoritative — TRUST them even if the current chunk does not show the element:",
        `- Literal <h1> opening tags in the FULL document: ${h1Count}.`,
        h1Count >= 1
          ? `  * Because <h1> count >= 1, you MUST NOT emit any issue claiming "missing <h1>", "no <h1>", "absent <h1>", "lacking a primary <h1>", or "missing a clear/unique <h1>". Heading hierarchy or wording critique is fine.`
          : `  * Because <h1> count is 0, you may report a missing primary <h1>.`,
        h1Count <= 1
          ? `  * You MUST NOT report duplicate/multiple <h1> elements (count <= 1).`
          : `  * Multiple <h1> elements detected (count = ${h1Count}); flagging duplicates is appropriate.`,
        `- Literal <main> opening tags in the FULL document: ${mainCount}.`,
        mainCount >= 1
          ? `  * Because <main> count >= 1, do NOT emit "missing <main>" / "no <main>" / "lacking <main>" issues.`
          : `  * Because <main> count is 0, you may report a missing <main> landmark.`,
        mainCount <= 1
          ? `  * Do NOT report multiple <main> elements (count <= 1).`
          : `  * Multiple <main> elements detected (count = ${mainCount}); flagging duplicates is appropriate.`,
        "",
        "OUT OF SCOPE — do NOT emit these issues:",
        "- Open Graph / og:* meta tags (any issue about og:title, og:description, og:image, og:type, og:url, missing/incorrect Open Graph, etc.).",
        "",
        "Semantic-wrapper caveat: before suggesting that an element be wrapped in or replaced with <article>, <section>, <main>, <header>, <footer>, <nav>, <aside>, or <figure>:",
        "  * Locate the ACTUAL element in the provided HTML by its id, class, or data-attribute. Do NOT guess or change the tag name. If the real element is already <article class=\"x\"> in the HTML, do not write <div class=\"x\"> in your htmlSnippet — copy the exact opening tag from the source.",
        "  * Verify the element is not already that semantic tag itself, and that none of its ancestors in the actual HTML are that tag. If either is true, skip the issue.",
        "  * For example: if the HTML contains <article class=\"slider-card\">..</article>, do NOT recommend wrapping product cards in <article> — it is already an <article>.",
        "",
        total > 1
          ? "Note: the page was split into chunks for size. The first chunk contains <head> (use it for SEO/meta/title/lang/canonical findings). Skip cross-chunk uniqueness checks (e.g. duplicate IDs page-wide) — report only what you can see in this chunk."
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
    });
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