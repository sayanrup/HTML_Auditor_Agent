import path from "path";

const repoRoot = process.cwd();
const sibling = (name: string) => path.resolve(repoRoot, "..", name);

const defaultDirRepo = sibling("dir-impcat-nodejs");
const defaultPdpRepo = sibling("pdp_next");
const defaultMobileRepo = sibling("mobile-im-pw");

export type RepoTargetKey = "dir" | "pdp" | "mobile";

export type RepoTarget = {
  key: RepoTargetKey;
  /** Display name for logs/UI. */
  label: string;
  /** Local working tree to apply changes in. */
  path: string;
  /** Git remote (default origin). */
  remote: string;
  /** Branch the audit feature branch is forked from. */
  baseBranch: string;
  /** When true, retry push with --force-with-lease on non-fast-forward. */
  pushForceWithLease: boolean;
  /**
   * Repo-relative paths or basenames to ignore during file matching.
   * Configure via `<KEY>_SKIP_FILES` env (comma/semicolon separated). Matching is case-insensitive
   * and accepts either a basename (e.g. `index.html`) or a posix-style relative path (e.g. `public/index.html`).
   */
  skipFiles: string[];
};

function parseSkipFiles(raw: string | undefined, fallback: string[]): string[] {
  if (raw == null) return fallback;
  const parts = raw
    .split(/[;,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length > 0 ? parts : [];
}

const dirGitRemote = (process.env.DIR_GIT_REMOTE ?? "origin").trim() || "origin";
const dirBaseBranch = (process.env.DIR_BASE_BRANCH ?? "stage").trim() || "stage";
const dirPushForceWithLease =
  (process.env.DIR_PUSH_FORCE_WITH_LEASE ?? "true").toLowerCase() !== "false";

const dirRepoPath = (process.env.DIR_REPO_PATH ?? "").trim() || defaultDirRepo;
const pdpRepoPath = (process.env.PDP_REPO_PATH ?? "").trim() || defaultPdpRepo;
const mobileRepoPath =
  (process.env.MOBILE_REPO_PATH ?? "").trim() || defaultMobileRepo;

export const REPO_TARGETS: Record<RepoTargetKey, RepoTarget> = {
  dir: {
    key: "dir",
    label: "dir-impcat-nodejs",
    path: dirRepoPath,
    remote: (process.env.DIR_GIT_REMOTE ?? "").trim() || dirGitRemote,
    baseBranch: (process.env.DIR_BASE_BRANCH ?? "").trim() || dirBaseBranch,
    pushForceWithLease: dirPushForceWithLease,
    /**
     * `index.html` is a build/SSR shell in dir-impcat-nodejs; runtime markup is produced from `index.js`,
     * so applying audit recommendations there has no effect on the live page.
     */
    skipFiles: parseSkipFiles(process.env.DIR_SKIP_FILES, ["index.html"]),
  },
  pdp: {
    key: "pdp",
    label: "pdp_next",
    path: pdpRepoPath,
    remote: (process.env.PDP_GIT_REMOTE ?? "").trim() || dirGitRemote,
    baseBranch: (process.env.PDP_BASE_BRANCH ?? "").trim() || dirBaseBranch,
    pushForceWithLease:
      (process.env.PDP_PUSH_FORCE_WITH_LEASE ?? `${dirPushForceWithLease}`)
        .toLowerCase() !== "false",
    skipFiles: parseSkipFiles(process.env.PDP_SKIP_FILES, []),
  },
  mobile: {
    key: "mobile",
    label: "mobile-im-pw",
    path: mobileRepoPath,
    remote: (process.env.MOBILE_GIT_REMOTE ?? "").trim() || dirGitRemote,
    baseBranch: (process.env.MOBILE_BASE_BRANCH ?? "").trim() || dirBaseBranch,
    pushForceWithLease:
      (process.env.MOBILE_PUSH_FORCE_WITH_LEASE ?? `${dirPushForceWithLease}`)
        .toLowerCase() !== "false",
    skipFiles: parseSkipFiles(process.env.MOBILE_SKIP_FILES, []),
  },
};

export const ENV = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** Public source-control URL shown in the app info dialog (e.g. GitHub repo). */
  scmRepoUrl: (process.env.SCM_REPO_URL ?? "").trim(),
  /** Local clone to apply audit HTML fixes (default: sibling ../dir-impcat-nodejs). */
  dirRepoPath,
  /** Git remote name for `git push` after applying DIR fixes. */
  dirGitRemote,
  /** Branch to fork the audit feature branch from (default: stage). */
  dirBaseBranch,
  /**
   * If true (default), when `git push` fails with non-fast-forward, retry with
   * `git push --force-with-lease` so a reused branch name (e.g. html-audit-suggestion) can update the remote.
   * Set DIR_PUSH_FORCE_WITH_LEASE=false to never overwrite remote (you must pull/merge first).
   */
  dirPushForceWithLease,
  /** All known sibling repo targets (URL-based selection happens in dirRepoFixes). */
  repoTargets: REPO_TARGETS,
  isProduction: process.env.NODE_ENV === "production",
  llm: {
    provider: (process.env.LLM_PROVIDER ?? "").toLowerCase(),
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "",
    baseUrl: process.env.LLM_BASE_URL ?? "",
  },
};
