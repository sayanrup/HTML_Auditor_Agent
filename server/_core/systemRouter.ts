import { z } from "zod";
import { publicProcedure, router } from "./trpc";
import { ENV } from "./env";

async function repoIsReady(repoPath: string): Promise<boolean> {
  const fs = await import("fs/promises");
  try {
    const st = await fs.stat(repoPath);
    if (!st.isDirectory()) return false;
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoPath,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export const systemRouter = router({
  publicInfo: publicProcedure.query(async () => {
    const targets = ENV.repoTargets;
    const [dirReady, pdpReady, mobileReady] = await Promise.all([
      repoIsReady(targets.dir.path),
      repoIsReady(targets.pdp.path),
      repoIsReady(targets.mobile.path),
    ]);
    return {
      scmRepoUrl: ENV.scmRepoUrl || null,
      dirRepoPath: ENV.dirRepoPath,
      dirRepoReady: dirReady,
      repos: {
        dir: { label: targets.dir.label, path: targets.dir.path, ready: dirReady },
        pdp: { label: targets.pdp.label, path: targets.pdp.path, ready: pdpReady },
        mobile: {
          label: targets.mobile.label,
          path: targets.mobile.path,
          ready: mobileReady,
        },
      },
    };
  }),
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
