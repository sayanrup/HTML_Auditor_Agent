export const ENV = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** Public source-control URL shown in the app info dialog (e.g. GitHub repo). */
  scmRepoUrl: (process.env.SCM_REPO_URL ?? "").trim(),
  isProduction: process.env.NODE_ENV === "production",
  llm: {
    provider: (process.env.LLM_PROVIDER ?? "").toLowerCase(),
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "",
    baseUrl: process.env.LLM_BASE_URL ?? "",
  },
};
