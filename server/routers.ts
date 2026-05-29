import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { fetchPageHtml } from "./services/urlFetcher";
import {
  performAudit,
  type AuditReport,
} from "./services/auditOrchestrator";
import { performRuleBasedAudit } from "./services/ruleBasedAuditor";
import { analyzeJsFiles } from "./services/playwrightJsAnalyzer";
import { addFeedback, listFeedback } from "./services/feedbackStore";
import { applyAuditRecommendationsToDir } from "./services/dirRepoFixes";
import { createJob, getJob, updateJob } from "./services/jobStore";
import { z } from "zod";

/** Initial attempt plus this many retries (5 total attempts). */
const HTML_AUDIT_RETRY_COUNT = 4;

async function enrichWithJsAnalysis(
  report: AuditReport,
  url: string,
  html: string
): Promise<AuditReport> {
  try {
    const result = await analyzeJsFiles(url, html, report.docSize.visibleTextChars);
    const vtc = Math.max(report.docSize.visibleTextChars, 1);
    // cssChars in the report is inline-only at this point; combine with Playwright external
    const inlineCssChars = report.docSize.cssChars;
    const cssChars    = result.cssCharsExt    + inlineCssChars;
    const cssCharsApp = result.cssCharsExtApp + inlineCssChars;
    return {
      ...report,
      docSize: {
        ...report.docSize,
        jsChars:          result.jsChars,
        jsCharsApp:       result.jsCharsApp,
        jsFilesTotal:     result.jsFilesTotal,
        jsFilesPackage:   result.jsFilesPackage,
        jsToTextRatio:    result.jsToTextRatio,
        jsToTextRatioApp: result.jsToTextRatioApp,
        cssChars,
        cssCharsApp,
        cssExtCount:      result.cssExtCount,
        cssExtPackage:    result.cssExtPackage,
        cssToTextRatio:    Math.round((cssChars    / vtc) * 100) / 100,
        cssToTextRatioApp: Math.round((cssCharsApp / vtc) * 100) / 100,
        unusedJs:  result.unusedJs,
        unusedCss: result.unusedCss,
      },
    };
  } catch (e) {
    console.error("[resource-analysis]", e);
    return report;
  }
}

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

        return await enrichWithJsAnalysis(report, url, fetchResult.html);
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

        const report = await performRuleBasedAudit(fetchResult.html);
        return await enrichWithJsAnalysis(report, url, fetchResult.html);
      }),
    /** Fire-and-forget AI audit — returns a jobId immediately; poll with pollJob. */
    startAudit: publicProcedure
      .input(
        z.object({
          url: z.string().url(),
          llm_api_key: z.string(),
          llm_model: z.string(),
        })
      )
      .mutation(async ({ input }) => {
        const { url, llm_api_key, llm_model } = input;

        if (!llm_api_key.trim()) throw new Error("LLM API key is required");
        if (!llm_model.trim()) throw new Error("LLM model is required");

        const job = createJob();

        // Run the full audit in the background — never awaited here so the
        // HTTP response is sent immediately (no gateway timeout possible).
        (async () => {
          try {
            updateJob(job.id, { status: "running", progress: "Fetching page…" });

            let fetchResult = await fetchPageHtml(url);
            for (let i = 0; i < HTML_AUDIT_RETRY_COUNT; i++) {
              if (fetchResult.success && fetchResult.html) break;
              await delay(100 * (i + 1));
              fetchResult = await fetchPageHtml(url);
            }
            if (!fetchResult.success || !fetchResult.html) {
              throw new Error(fetchResult.error || "Failed to fetch page");
            }

            updateJob(job.id, { progress: "Running AI audit…" });

            let report: AuditReport | undefined;
            let lastErr: Error | undefined;
            for (let attempt = 0; attempt <= HTML_AUDIT_RETRY_COUNT; attempt++) {
              try {
                report = await performAudit(fetchResult.html, llm_api_key, llm_model);
                break;
              } catch (e) {
                lastErr = e instanceof Error ? e : new Error(String(e));
                if (attempt < HTML_AUDIT_RETRY_COUNT) await delay(400 * (attempt + 1));
              }
            }
            if (!report) throw lastErr ?? new Error("Audit failed after retries");

            updateJob(job.id, { progress: "Analysing JS/CSS resources…" });
            const enriched = await enrichWithJsAnalysis(report, url, fetchResult.html);
            updateJob(job.id, { status: "done", result: enriched, progress: undefined });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            updateJob(job.id, { status: "failed", error: msg, progress: undefined });
          }
        })();

        return { jobId: job.id };
      }),

    /** Fire-and-forget rule-based audit — returns a jobId immediately; poll with pollJob. */
    startRuleBasedAudit: publicProcedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async ({ input }) => {
        const { url } = input;
        const job = createJob();

        (async () => {
          try {
            updateJob(job.id, { status: "running", progress: "Fetching page…" });

            let fetchResult = await fetchPageHtml(url);
            for (let i = 0; i < HTML_AUDIT_RETRY_COUNT; i++) {
              if (fetchResult.success && fetchResult.html) break;
              await delay(100 * (i + 1));
              fetchResult = await fetchPageHtml(url);
            }
            if (!fetchResult.success || !fetchResult.html) {
              throw new Error(fetchResult.error || "Failed to fetch page");
            }

            updateJob(job.id, { progress: "Running rule-based audit…" });
            const report = await performRuleBasedAudit(fetchResult.html);

            updateJob(job.id, { progress: "Analysing JS/CSS resources…" });
            const enriched = await enrichWithJsAnalysis(report, url, fetchResult.html);
            updateJob(job.id, { status: "done", result: enriched, progress: undefined });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            updateJob(job.id, { status: "failed", error: msg, progress: undefined });
          }
        })();

        return { jobId: job.id };
      }),

    /** Poll the status of a running audit job. */
    pollJob: publicProcedure
      .input(z.object({ jobId: z.string().uuid() }))
      .query(({ input }) => {
        const job = getJob(input.jobId);
        if (!job) throw new Error(`Job not found: ${input.jobId}`);
        return {
          status: job.status,
          progress: job.progress ?? null,
          result: job.status === "done" ? job.result : null,
          error: job.status === "failed" ? job.error : null,
        };
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
