import { evaluateWithLlm, type AuditScore } from "../services/llmEvaluator";

export type { AuditScore };

export async function analyzeW3CCompliance(html: string): Promise<AuditScore> {
  return evaluateWithLlm({
    criterionId: "w3cCompliance",
    criterionName: "W3C / HTML validity (best-effort)",
    html,
    rubric: [
      "Evaluate HTML validity and W3C-oriented compliance based on markup.",
      "Consider: presence of HTML5 doctype, required head elements, charset/viewport, deprecated/obsolete elements, invalid nesting of interactive elements, missing required attributes where clearly applicable, and obvious structural validity problems visible in markup.",
      "Do not invent validation errors you cannot see; stick to issues strongly supported by the HTML.",
    ].join("\n"),
  });
}
