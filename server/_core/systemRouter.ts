import { z } from "zod";
import { publicProcedure, router } from "./trpc";
import { ENV } from "./env";

export const systemRouter = router({
  publicInfo: publicProcedure.query(() => ({
    scmRepoUrl: ENV.scmRepoUrl || null,
  })),
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),
});
