import { evaluateAllWithLlm } from "../services/llmEvaluator";

export type { AuditScore, AllAuditScore } from "../services/llmEvaluator";

export async function analyzeAll(html: string, llm_api_key: string, llm_model: string) {
  return evaluateAllWithLlm(html, llm_api_key, llm_model);
}
