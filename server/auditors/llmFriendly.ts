import { evaluateWithLlm, type AuditScore } from "../services/llmEvaluator";

export type { AuditScore };

export async function analyzeLLMFriendly(html: string): Promise<AuditScore> {
  return evaluateWithLlm({
    criterionId: "llmFriendly",
    criterionName: "LLM-friendly HTML",
    html,
    rubric: [
      // "Evaluate whether the HTML is easy for an LLM to understand and extract meaning from.",
      // "Consider: strong information hierarchy (single clear H1, sensible H2/H3), semantic structure, descriptive link/button text, explicit labels, minimal noise, and content that is not hidden behind excessive scripts.",
      // "Focus on markup-level signals. If the page is mostly empty shell markup, score lower and explain what content structure would help.",
      `
      You are an expert in analyzing HTML for Large Language Model (LLM) readability and extractability. Evaluate how well this HTML can be understood, parsed, and meaningfully interpreted by an LLM. Focus on information hierarchy such as the presence of a single clear <h1> and properly structured <h2>/<h3> tags, semantic HTML usage including elements like <main>, <article>, <section>, and avoidance of excessive non-semantic <div> nesting, clarity of content ensuring that meaningful text is directly present in the HTML and not hidden behind JavaScript rendering, and reduction of noise such as boilerplate markup, repeated components, ads, or trackers. Also evaluate descriptive elements such as meaningful link and button text, presence of alt attributes on images, and proper labeling of inputs, forms, and interactive elements. Identify patterns that block or degrade LLM understanding such as content rendered only via JavaScript, empty shell markup (e.g. <div id="root"></div>), excessive DOM nesting, obfuscated structure, or repeated irrelevant sections.
      `
    ].join("\n"),
  });
}
