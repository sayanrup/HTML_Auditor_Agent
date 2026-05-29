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

/** Hard per-call timeout. The gateway already has its own upstream timeout; this
 *  guards against requests that never come back at all. */
const LLM_REQUEST_TIMEOUT_MS = 120_000;

/** HTTP statuses that justify a retry (model overloads, gateway timeouts, rate limits). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Strings in error bodies that signal a transient gateway/model condition. */
const RETRYABLE_BODY_RE =
  /upstream\s*(?:request|response)?\s*timeout|upload\s*stream\s*timeout|gateway\s*timeout|service\s*unavailable|temporarily\s*unavailable|read\s*timed?\s*out/i;

/** Backoff between retries (ms); also controls retry count via array length. */
const RETRY_BACKOFF_MS = [1000, 3000, 7000];

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  intermeshHitCount++;
  const hitId = intermeshHitCount;
  const body = JSON.stringify({
    model,
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" },
  });
  const payloadBytes = Buffer.byteLength(body, "utf8");
  const messagesChars = messages.reduce((a, m) => a + m.content.length, 0);
  console.log(
    `[imllm.intermesh.net] hit #${hitId} — model: ${model} payloadBytes=${payloadBytes} messagesChars=${messagesChars}`
  );

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      LLM_REQUEST_TIMEOUT_MS
    );
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const text = await res.text();
      if (!res.ok) {
        const transient =
          RETRYABLE_STATUS.has(res.status) || RETRYABLE_BODY_RE.test(text);
        const elapsed = Date.now() - startedAt;
        if (transient && attempt < RETRY_BACKOFF_MS.length) {
          const wait = RETRY_BACKOFF_MS[attempt]!;
          console.warn(
            `[imllm.intermesh.net] hit #${hitId} attempt ${attempt + 1} status=${res.status} elapsed=${elapsed}ms — transient, retrying in ${wait}ms. body: ${text.slice(0, 200)}`
          );
          lastError = new Error(
            `LLM gateway ${res.status}: ${text.slice(0, 300)}`
          );
          await delay(wait);
          continue;
        }
        throw new Error(
          `LLM request failed (${res.status} after ${elapsed}ms): ${text.slice(0, 500)}`
        );
      }

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        if (
          RETRYABLE_BODY_RE.test(text) &&
          attempt < RETRY_BACKOFF_MS.length
        ) {
          const wait = RETRY_BACKOFF_MS[attempt]!;
          console.warn(
            `[imllm.intermesh.net] hit #${hitId} attempt ${attempt + 1} non-JSON transient body, retrying in ${wait}ms: ${text.slice(0, 200)}`
          );
          lastError = new Error(
            `LLM returned non-JSON: ${text.slice(0, 300)}`
          );
          await delay(wait);
          continue;
        }
        throw new Error(
          `LLM returned non-JSON response: ${text.slice(0, 500)}`
        );
      }

      const content = (data as { choices?: { message?: { content?: unknown } }[] })
        ?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("LLM returned empty content");
      }
      return content;
    } catch (err) {
      clearTimeout(timeoutId);
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || /aborted/i.test(err.message));
      const isNetwork =
        err instanceof Error &&
        /fetch|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket\s+hang/i.test(
          err.message
        );
      if ((isAbort || isNetwork) && attempt < RETRY_BACKOFF_MS.length) {
        const wait = RETRY_BACKOFF_MS[attempt]!;
        console.warn(
          `[imllm.intermesh.net] hit #${hitId} attempt ${attempt + 1} ${isAbort ? "client timeout" : "network error"}: ${(err as Error).message} — retrying in ${wait}ms`
        );
        lastError = err as Error;
        await delay(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error("LLM request failed after retries");
}

