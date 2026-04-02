import { z } from "zod";
import { llmCompleteJson, LlmConfigError } from "./llmClient";

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
  llmFriendly: `You are an expert in analyzing HTML for Large Language Model (LLM) readability and extractability. Evaluate how well this HTML can be understood, parsed, and meaningfully interpreted by an LLM. Focus on information hierarchy such as the presence of a single clear <h1> and properly structured <h2>/<h3> tags, semantic HTML usage including elements like <main>, <article>, <section>, and avoidance of excessive non-semantic <div> nesting, clarity of content ensuring that meaningful text is directly present in the HTML and not hidden behind JavaScript rendering, and reduction of noise such as boilerplate markup, repeated components, ads, or trackers. Also evaluate descriptive elements such as meaningful link and button text, presence of alt attributes on images, and proper labeling of inputs, forms, and interactive elements. Identify patterns that block or degrade LLM understanding such as content rendered only via JavaScript, empty shell markup (e.g. <div id="root"></div>), excessive DOM nesting, obfuscated structure, or repeated irrelevant sections.`,

  w3cCompliance: `Evaluate HTML validity and W3C-oriented compliance based on markup.
Consider: presence of HTML5 doctype, required head elements, charset/viewport, deprecated/obsolete elements, invalid nesting of interactive elements, missing required attributes where clearly applicable, and obvious structural validity problems visible in markup.
Do not invent validation errors you cannot see; stick to issues strongly supported by the HTML.`,

  seo: `Evaluate on-page SEO based on HTML markup and content.
Consider: title tag quality, meta description, canonical, robots, Open Graph / Twitter cards, heading structure, alt text for images, internal/external linking patterns, structured data (JSON-LD), and whether visible content seems thin.
Do not require site-wide signals (backlinks, performance) since they are not provided; focus only on what the HTML shows.`,

  semanticHtml: `Evaluate semantic HTML usage and document structure quality.
Consider: use of semantic layout elements (header/nav/main/article/section/aside/footer), appropriate headings, lists, figure/figcaption, table semantics, form semantics, and avoidance of div/span soup when semantic elements apply.
Flag clear structural mistakes (e.g., multiple main, orphaned li, missing main for content-heavy pages) as errors; softer opportunities as warning/info.`,

  accessibility: `Evaluate WCAG-relevant accessibility for typical web pages using only the provided HTML (assume CSS/JS may exist but is unknown).
Consider: language and title presence, headings structure, form labels, image alt text, link/button accessible names, ARIA misuse, landmark structure, interactive element nesting, and common accessibility pitfalls visible from markup.
If something depends on computed styles (e.g., contrast), mention as info/warning rather than error unless the HTML clearly violates the rule.`,

  docSize: `Check document size and recommendation to reduce the html size of the page`,
};

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
    const htmlSize = Buffer.byteLength(html, 'utf8');

    const raw = await llmCompleteJson(llm_api_key, llm_model, [
      {
        role: "system",
        content: "You are a strict HTML auditing engine. Return ONLY valid JSON. Do not include markdown fences.",
      },
      {
        role: "user",
        content: [
          "Evaluate the provided HTML across all five criteria below and return a single JSON object.",
          "",
          "Return JSON with this exact schema:",
          '{ "llmFriendly": { "score": number(0-100), "issues": [...] }, "w3cCompliance": { "score": number(0-100), "issues": [...] }, "seo": { "score": number(0-100), "issues": [...] }, "semanticHtml": { "score": number(0-100), "issues": [...] }, "accessibility": { "score": number(0-100), "issues": [...] }, "docSize":{"size": number, "recommendation":""} }',
          "",
          'Each issue: { "severity": "error"|"warning"|"info", "issue": string, "recommendation": "Concrete fix with html correction", "htmlSnippet": "<HTML code with all relevant code to identify issue>" }',
          "",
          "Scoring rules:",
          "- Score 100 means best-practice compliant for this criterion.",
          "- Be consistent and conservative.",
          "- Include the most important issues first (up to 12 per criterion).",
          "",
          combinedRubric,
          "",
          "HTML to audit:",
          html,
        ].join("\n"),
      },
    ]);

    const json = JSON.parse(raw);
    const parsed = AllAuditScoreSchema.safeParse(json);

    if (!parsed.success) {
      return {
        allAuditScore: makeFallbackAllResult(
          "LLM returned invalid audit JSON",
          "Adjust LLM_MODEL or provider settings; ensure the model can follow strict JSON instructions."
        ),
      };
    }

    const trim = (s: AuditScore): AuditScore => ({
      score: Math.round(s.score),
      issues: s.issues.slice(0, 12),
    });

    return {
      allAuditScore: {
        llmFriendly: trim(parsed.data.llmFriendly),
        w3cCompliance: trim(parsed.data.w3cCompliance),
        seo: trim(parsed.data.seo),
        semanticHtml: trim(parsed.data.semanticHtml),
        accessibility: trim(parsed.data.accessibility),
        docSize: { size: htmlSize, recommendation: parsed.data.docSize.recommendation },
      },
    };
  } catch (e) {
    if (e instanceof LlmConfigError) {
      return {
        allAuditScore: makeFallbackAllResult(
          "LLM not configured for runtime auditing",
          "Set env vars: LLM_PROVIDER=openai|anthropic|google, LLM_API_KEY=..., optional LLM_MODEL=..., optional LLM_BASE_URL=..."
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