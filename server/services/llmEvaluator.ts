import { z } from "zod";
import { llmCompleteJson, LlmConfigError } from "./llmClient";

const AuditIssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  issue: z.string().min(1),
  recommendation: z.string().min(1),
  htmlSnippet: z.string().min(1),
});

const AuditScoreSchema = z.object({
  score: z.number().min(0).max(100),
  issues: z.array(AuditIssueSchema),
});

export type AuditScore = z.infer<typeof AuditScoreSchema>;

function clampHtmlForPrompt(html: string) {
  const maxChars = 22000;
  if (html.length <= maxChars) return html;
  return html.slice(0, maxChars) + "\n<!-- ... truncated ... -->";
}

export async function evaluateWithLlm(args: {
  criterionId:
    | "accessibility"
    | "seo"
    | "semanticHtml"
    | "w3cCompliance"
    | "llmFriendly";
  criterionName: string;
  html: string;
  rubric: string;
}): Promise<AuditScore> {
  try {
    const raw = await llmCompleteJson([
      {
        role: "system",
        content:
          "You are a strict HTML auditing engine. Return ONLY valid JSON. Do not include markdown fences.",
      },
      {
        role: "user",
        content: [
          `Criterion: ${args.criterionName} (${args.criterionId})`,
          "",
          "Return JSON with this schema:",
          '{ "score": number(0-100), "issues": [ { "severity": "error"|"warning"|"info", "issue": string, "recommendation": "Concrete fix with html correction", "htmlSnippet": "<HTML code with all relevant code to identify issue>"} ] }',
          "",
          "Scoring rules:",
          "- Score 100 means best-practice compliant for this criterion.",
          "- Be consistent and conservative.",
          "- Include the most important issues first.",
          "",
          "Rubric:",
          args.rubric.trim(),
          "",
          "HTML to audit:",
          clampHtmlForPrompt(args.html),
        ].join("\n"),
      },
    ]);

    const json = JSON.parse(raw);
    const parsed = AuditScoreSchema.safeParse(json);
    if (!parsed.success) {
      return {
        score: 0,
        issues: [
          {
            severity: "error",
            issue: "LLM returned invalid audit JSON",
            recommendation:
              "Adjust LLM_MODEL or provider settings; ensure the model can follow strict JSON instructions.",
            htmlSnippet : "Page not accesssed"
          },
        ],
      };
    }

    return {
      score: Math.round(parsed.data.score),
      issues: parsed.data.issues.slice(0, 12),
    };
  } catch (e) {
    if (e instanceof LlmConfigError) {
      return {
        score: 0,
        issues: [
          {
            severity: "error",
            issue: "LLM not configured for runtime auditing",
            recommendation:
              "Set env vars: LLM_PROVIDER=openai|anthropic|google, LLM_API_KEY=..., optional LLM_MODEL=..., optional LLM_BASE_URL=...",
            htmlSnippet : "Page not accesssed"
          },
        ],
      };
    }
    return {
      score: 0,
      issues: [
        {
          severity: "error",
          issue: "LLM audit failed at runtime",
          recommendation:
            e instanceof Error ? e.message : "Check server logs and LLM provider connectivity/credentials.",
          htmlSnippet : "Page not accesssed"
        },
      ],
    };
  }
}

