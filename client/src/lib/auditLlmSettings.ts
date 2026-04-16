export type AuditLlmConfig = {
  llm_api_key: string;
  llm_model: string;
};

const STORAGE_KEY = "page-audit-agent:llm-settings";

export function loadAuditLlmSettings(): AuditLlmConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as AuditLlmConfig).llm_api_key === "string" &&
      typeof (parsed as AuditLlmConfig).llm_model === "string"
    ) {
      return {
        llm_api_key: (parsed as AuditLlmConfig).llm_api_key,
        llm_model: (parsed as AuditLlmConfig).llm_model,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveAuditLlmSettings(cfg: AuditLlmConfig): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}
