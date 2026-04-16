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

let intermeshHitCount = 0;

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

export async function llmCompleteJson(
  llm_api_key: string,
  llm_model: string,
  messages: LlmChatMessage[]
) {
  const cfg = getLlmConfig();
  const key = llm_api_key.trim();
  /** Audits use the key from app settings; server .env is optional and mainly supplies default base URL / validation. */
  const hasUserKey = key.length > 0;

  if (!cfg && !hasUserKey) {
    throw new LlmConfigError(
      "LLM not configured. Add your API key and model in the app Settings, or set LLM_PROVIDER, LLM_API_KEY (and optionally LLM_MODEL / LLM_BASE_URL) on the server."
    );
  }

  const url =
    (cfg?.baseUrl || ENV.llm.baseUrl || "").trim() ||
    "https://imllm.intermesh.net/v1/chat/completions";
  const model = llm_model.trim() || ENV.llm.model || "openai/gpt-4.1-mini";
  console.log("url ", url);
  console.log("model ", model);
  intermeshHitCount++;
  console.log(
    `[imllm.intermesh.net] hit #${intermeshHitCount} — model: ${model}`
  );
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
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

