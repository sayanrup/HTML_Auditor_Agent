import { analyzeAll } from "../auditors/auditors";
import { computeHtmlTextMetrics, computeJsCssMetrics, findTopBloatedSegments, type HtmlSegmentRatio } from "./htmlTextMetrics";
export type { HtmlSegmentRatio };

export interface AuditIssue {
  severity: "error" | "warning" | "info";
  issue: string;
  recommendation: string;
  htmlSnippet?: string;
}

export interface CriterionResult {
  score: number;
  issues: AuditIssue[];
}

export interface docResult {
  size: number;
  recommendation: string;
  htmlBytes: number;
  markupHtmlBytes: number;
  visibleTextChars: number;
  htmlToTextRatio: number;
  topBloatedSegments: HtmlSegmentRatio[];
  // CSS metrics — inline always present; external fields populated by Playwright after audit
  cssChars: number;       // inline chars initially; combined (inline+ext) after Playwright
  cssExtCount: number;
  cssInlineCount: number;
  cssToTextRatio: number;
  cssCharsApp?: number;       // combined (inline + ext app) — after Playwright
  cssExtPackage?: number;
  cssToTextRatioApp?: number;
  // JS metrics (populated by Playwright after audit returns)
  jsChars?: number;
  jsCharsApp?: number;
  jsFilesTotal?: number;
  jsFilesPackage?: number;
  jsToTextRatio?: number;
  jsToTextRatioApp?: number;
  // Unused resource coverage (from Playwright — both audits)
  unusedJs?: Array<{ url: string; totalChars: number; unusedChars: number; unusedPct: number }>;
  unusedCss?: Array<{ url: string; totalChars: number; unusedChars: number; unusedPct: number }>;
}

export interface AuditReport {
  overallScore: number;
  llmFriendly: CriterionResult;
  w3cCompliance: CriterionResult;
  seo: CriterionResult;
  semanticHtml: CriterionResult;
  accessibility: CriterionResult;
  docSize: docResult;
}

export async function performAudit(html: string, llm_api_key: string, llm_model: string): Promise<AuditReport> {
  const { allAuditScore } = await analyzeAll(html, llm_api_key, llm_model);
  const textMetrics = computeHtmlTextMetrics(html);
  const jsCssMetrics = await computeJsCssMetrics(html, textMetrics.visibleTextChars);
  const topBloatedSegments = findTopBloatedSegments(html, 5);

  const {
    llmFriendly,
    w3cCompliance,
    seo,
    semanticHtml,
    accessibility,
    docSize,
  } = allAuditScore;

  const overallScore = Math.round(
    (
      llmFriendly.score +
      w3cCompliance.score +
      seo.score +
      semanticHtml.score +
      accessibility.score
    ) / 5
  );

  return {
    overallScore,
    llmFriendly,
    w3cCompliance,
    seo,
    semanticHtml,
    accessibility,
    docSize: {
      ...docSize,
      size: textMetrics.htmlBytes,
      htmlBytes: textMetrics.htmlBytes,
      markupHtmlBytes: textMetrics.markupHtmlBytes,
      visibleTextChars: textMetrics.visibleTextChars,
      htmlToTextRatio: textMetrics.htmlToTextRatio,
      topBloatedSegments,
      ...jsCssMetrics,
    },
  };
}