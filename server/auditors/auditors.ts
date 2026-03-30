import { evaluateAllWithLlm } from "../services/llmEvaluator";

export type { AuditScore, AllAuditScore } from "../services/llmEvaluator";

export async function analyzeAll(html: string) {
  return evaluateAllWithLlm(html);
}
