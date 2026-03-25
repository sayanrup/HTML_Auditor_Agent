import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { fetchPageHtml } from "./services/urlFetcher";
import { performAudit } from "./services/auditOrchestrator";
import { z } from "zod";

export const appRouter = router({
  system: systemRouter,
  audit: router({
    performAudit: publicProcedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async ({ input }) => {
        // Fetch the page
        const fetchResult = await fetchPageHtml(input.url);
        if (!fetchResult.success || !fetchResult.html) {
          throw new Error(fetchResult.error || "Failed to fetch page");
        }

        // Perform audit
        const report = await performAudit(fetchResult.html);

        return report;
      }),
  }),
});

export type AppRouter = typeof appRouter;
