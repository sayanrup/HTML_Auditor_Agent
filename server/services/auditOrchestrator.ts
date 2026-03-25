import { analyzeLLMFriendly } from "../auditors/llmFriendly";
import { analyzeW3CCompliance } from "../auditors/w3cCompliance";
import { analyzeSEO } from "../auditors/seo";
import { analyzeSemanticHtml } from "../auditors/semanticHtml";
import { analyzeAccessibility } from "../auditors/accessibility";

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

export interface AuditReport {
  overallScore: number;
  llmFriendly: CriterionResult;
  w3cCompliance: CriterionResult;
  seo: CriterionResult;
  semanticHtml: CriterionResult;
  accessibility: CriterionResult;
}

/**
 * Orchestrates all audit analyzers and produces a comprehensive audit report.
 */
export async function performAudit(html: string): Promise<AuditReport> {
  const [llmFriendly, w3cCompliance, seo, semanticHtml, accessibility] =
    await Promise.all([
      analyzeLLMFriendly(html),
      analyzeW3CCompliance(html),
      analyzeSEO(html),
      analyzeSemanticHtml(html),
      analyzeAccessibility(html),
    ]);

  // Calculate overall score as average of all criteria
  const overallScore = Math.round(
    (llmFriendly.score +
      w3cCompliance.score +
      seo.score +
      semanticHtml.score +
      accessibility.score) /
      5
  );

  return {
    overallScore,
    llmFriendly,
    w3cCompliance,
    seo,
    semanticHtml,
    accessibility,
  };
}
