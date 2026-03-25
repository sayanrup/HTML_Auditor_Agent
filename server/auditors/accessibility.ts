import { evaluateWithLlm, type AuditScore } from "../services/llmEvaluator";

export type { AuditScore };

export async function analyzeAccessibility(html: string): Promise<AuditScore> {
  return evaluateWithLlm({
    criterionId: "accessibility",
    criterionName: "Accessibility (WCAG-oriented)",
    html,
    rubric: [
      "Evaluate WCAG-relevant accessibility for typical web pages using only the provided HTML (assume CSS/JS may exist but is unknown).",
      "Consider: language and title presence, headings structure, form labels, image alt text, link/button accessible names, ARIA misuse, landmark structure, interactive element nesting, and common accessibility pitfalls visible from markup.",
      "If something depends on computed styles (e.g., contrast), mention as info/warning rather than error unless the HTML clearly violates the rule.",
    ].join("\n"),
  });
}
