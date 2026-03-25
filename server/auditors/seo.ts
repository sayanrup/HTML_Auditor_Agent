import { evaluateWithLlm, type AuditScore } from "../services/llmEvaluator";

export type { AuditScore };

export async function analyzeSEO(html: string): Promise<AuditScore> {
  return evaluateWithLlm({
    criterionId: "seo",
    criterionName: "SEO",
    html,
    rubric: [
      "Evaluate on-page SEO based on HTML markup and content.",
      "Consider: title tag quality, meta description, canonical, robots, Open Graph / Twitter cards, heading structure, alt text for images, internal/external linking patterns, structured data (JSON-LD), and whether visible content seems thin.",
      "Do not require site-wide signals (backlinks, performance) since they are not provided; focus only on what the HTML shows.",
    ].join("\n"),
  });
}
