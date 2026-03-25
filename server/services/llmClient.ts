import { z } from "zod";
import { ENV } from "../_core/env";

export type LlmProvider = "openai" | "anthropic" | "google";

export interface LlmChatMessage {
  role: "system" | "user";
  content: string;
}

const LlmConfigSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
});

function getLlmConfig() {
  const parsed = LlmConfigSchema.safeParse({
    provider: ENV.llm.provider,
    apiKey: ENV.llm.apiKey,
    model: ENV.llm.model || undefined,
    baseUrl: ENV.llm.baseUrl || undefined,
  });
  if (!parsed.success) return null;

  const provider = parsed.data.provider as LlmProvider;
  if (provider !== "openai" && provider !== "anthropic" && provider !== "google") {
    return null;
  }
  return { ...parsed.data, provider };
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

export async function llmCompleteJson(messages: LlmChatMessage[]) {
  const cfg = getLlmConfig();
  if (!cfg) {
    throw new LlmConfigError(
      "LLM not configured. Set LLM_PROVIDER (openai|anthropic|google), LLM_API_KEY, and optionally LLM_MODEL / LLM_BASE_URL."
    );
  }

  if (cfg.provider === "openai") {
    const url = cfg.baseUrl || 'https://imllm.intermesh.net/v1/chat/completions';
    const model = cfg.model || "openai/gpt-4.1-mini";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI request failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("OpenAI returned empty content");
    }
    return content;
  }

  if (cfg.provider === "anthropic") {
    const url = "https://api.anthropic.com/v1/messages";
    const model = cfg.model || "claude-3-5-sonnet-latest";
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        temperature: 0.2,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic request failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    const content = data?.content?.[0]?.text;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("Anthropic returned empty content");
    }
    return content;
  }

  // google
  const model = cfg.model || "gemini-1.5-flash";
  const url =
    (cfg.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, "") +
    `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${system}\n\n${user}`.trim() }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google request failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Google returned empty content");
  }
  return content;
}

