import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { fetchPageHtml } from "./services/urlFetcher";
import { performAudit } from "./services/auditOrchestrator";
import { z } from "zod";

export const appRouter = router({
  system: systemRouter,
  audit: router({
    performAudit: publicProcedure
      .input(
        z.object({
          url: z.string().url(),
          llm_api_key: z.string(),
          llm_model: z.string(),
        })
      )
      .mutation(async ({ input }) => {
        const { url, llm_api_key, llm_model } = input;

        // Extra safety (even if frontend enforces)
        if (!llm_api_key.trim()) {
          throw new Error("LLM API key is required");
        }

        if (!llm_model.trim()) {
          throw new Error("LLM model is required");
        }

        // Fetch the page
        const fetchResult = await fetchPageHtml(url);
        if (!fetchResult.success || !fetchResult.html) {
          throw new Error(fetchResult.error || "Failed to fetch page");
        }

        // Perform audit
        const report = await performAudit(
          fetchResult.html,
          llm_api_key,
          llm_model
        );

        return report;
      }),
  }),
});

export type AppRouter = typeof appRouter;
