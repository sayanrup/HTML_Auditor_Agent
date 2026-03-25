import { evaluateWithLlm, type AuditScore } from "../services/llmEvaluator";

export type { AuditScore };

export async function analyzeSemanticHtml(html: string): Promise<AuditScore> {
  return evaluateWithLlm({
    criterionId: "semanticHtml",
    criterionName: "Semantic HTML",
    html,
    rubric: [
      "Evaluate semantic HTML usage and document structure quality.",
      "Consider: use of semantic layout elements (header/nav/main/article/section/aside/footer), appropriate headings, lists, figure/figcaption, table semantics, form semantics, and avoidance of div/span soup when semantic elements apply.",
      "Flag clear structural mistakes (e.g., multiple main, orphaned li, missing main for content-heavy pages) as errors; softer opportunities as warning/info.",
    ].join("\n"),
  });
}
