import { analyzeAll } from "../auditors/auditors";

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
    docSize,
  };
}