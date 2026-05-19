import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { fetchPageHtml } from "./services/urlFetcher";
import {
  performAudit,
  type AuditReport,
} from "./services/auditOrchestrator";
import { performRuleBasedAudit } from "./services/ruleBasedAuditor";
import { addFeedback, listFeedback } from "./services/feedbackStore";
import { applyAuditRecommendationsToDir } from "./services/dirRepoFixes";
import { z } from "zod";

/** Initial attempt plus this many retries (5 total attempts). */
const HTML_AUDIT_RETRY_COUNT = 4;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const appRouter = router({
  system: systemRouter,
  feedback: router({
    list: publicProcedure.query(async () => listFeedback()),
    submit: publicProcedure
      .input(
        z.object({
          message: z.string().min(1).max(4000),
        })
      )
      .mutation(async ({ input }) => {
        const entry = await addFeedback(input.message);
        return entry;
      }),
  }),
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

        // Fetch the page (retry on failure: 1 try + HTML_AUDIT_RETRY_COUNT retries)
        let fetchResult = await fetchPageHtml(url);
        for (let attempt = 0; attempt < HTML_AUDIT_RETRY_COUNT; attempt++) {
          if (fetchResult.success && fetchResult.html) break;
          await delay(100 * (attempt + 1));
          fetchResult = await fetchPageHtml(url);
        }
        if (!fetchResult.success || !fetchResult.html) {
          throw new Error(fetchResult.error || "Failed to fetch page");
        }

        // Perform audit (same retry policy when LLM / analysis throws)
        let report: AuditReport | undefined;
        let lastAuditError: Error | undefined;
        for (let attempt = 0; attempt <= HTML_AUDIT_RETRY_COUNT; attempt++) {
          try {
            report = await performAudit(
              fetchResult.html,
              llm_api_key,
              llm_model
            );
            break;
          } catch (e) {
            lastAuditError =
              e instanceof Error ? e : new Error(String(e));
            if (attempt < HTML_AUDIT_RETRY_COUNT) {
              await delay(400 * (attempt + 1));
            }
          }
        }
        if (!report) {
          throw lastAuditError ?? new Error("Audit failed after retries");
        }

        return report;
      }),
    performRuleBasedAudit: publicProcedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async ({ input }) => {
        const { url } = input;

        let fetchResult = await fetchPageHtml(url);
        for (let attempt = 0; attempt < HTML_AUDIT_RETRY_COUNT; attempt++) {
          if (fetchResult.success && fetchResult.html) break;
          await delay(100 * (attempt + 1));
          fetchResult = await fetchPageHtml(url);
        }
        if (!fetchResult.success || !fetchResult.html) {
          throw new Error(fetchResult.error || "Failed to fetch page");
        }

        return performRuleBasedAudit(fetchResult.html);
      }),
    applyRecommendationsToDir: publicProcedure
      .input(
        z.object({
          report: z.any(),
          llm_api_key: z.string().min(1),
          llm_model: z.string().min(1),
          branchName: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .default("html-audit-suggestion"),
          /** Page URL that was audited — helps pick the right source file when needles match many files. */
          auditedPageUrl: z.string().min(1).max(4096).optional(),
          /** Force a specific sibling repo target instead of URL-based selection. */
          repoTarget: z.enum(["dir", "pdp", "mobile"]).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const result = await applyAuditRecommendationsToDir({
          report: input.report as AuditReport,
          branchName: input.branchName,
          llm_api_key: input.llm_api_key,
          llm_model: input.llm_model,
          auditedPageUrl: input.auditedPageUrl,
          repoTarget: input.repoTarget,
        });
        console.log("[audit.applyRecommendationsToDir]", {
          pushed: result.pushed,
          branch: result.branch,
          repoRoot: result.repoRoot,
          repoTarget: result.repoTarget,
          repoLabel: result.repoLabel,
          issuesApplied: result.issuesApplied,
          issuesAttempted: result.issuesAttempted,
          filesTouched: result.filesTouched,
        });
        if (result.locationSummary) {
          console.log(
            "[audit.applyRecommendationsToDir] locationSummary:\n" +
              result.locationSummary
          );
        }
        if (result.skipped.length > 0) {
          console.log(
            "[audit.applyRecommendationsToDir] skipped:",
            result.skipped
          );
        }
        if (result.issueTrace?.length) {
          console.log(
            "[audit.applyRecommendationsToDir] issueTrace:",
            JSON.stringify(result.issueTrace, null, 2)
          );
        }
        return result;
      }),
  }),
});

export type AppRouter = typeof appRouter;
