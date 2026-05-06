import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { ENV } from "../_core/env";
import type { RepoTarget, RepoTargetKey } from "../_core/env";
import type { AuditIssue, AuditReport } from "./auditOrchestrator";
import { llmCompleteJson } from "./llmClient";

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
]);

const TEXT_EXT = new Set([
  ".html",
  ".htm",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".vue",
  ".php",
  ".mdx",
]);

const ReplacementSchema = z.object({
  action: z.enum(["replace", "skip"]),
  replacementHtml: z.string().optional(),
});

const SourcePatchSchema = z.object({
  action: z.enum(["replace", "skip"]),
  oldSource: z.string().optional(),
  newSource: z.string().optional(),
});

const AdaptedRecommendationSchema = z.object({
  adaptedRecommendation: z.string().min(1),
});

function resolveDirRepoRoot(): string {
  return path.resolve(ENV.dirRepoPath.trim());
}

/** URL-driven repo selection. Falls back to the `dir` target when no rule matches. */
export function pickRepoTargetForUrl(
  auditedPageUrl: string | undefined
): RepoTarget {
  const targets = ENV.repoTargets;
  const fallback = targets.dir;
  if (!auditedPageUrl) return fallback;
  let host = "";
  let pathname = "";
  let full = auditedPageUrl.toLowerCase();
  try {
    const u = new URL(auditedPageUrl);
    host = u.hostname.toLowerCase();
    pathname = u.pathname.toLowerCase();
    full = u.href.toLowerCase();
  } catch {
    full = auditedPageUrl.toLowerCase();
  }

  const matches = (h: string, p: string, all: string) => {
    if (h.startsWith("m.indiamart.") || h.includes(".m.indiamart."))
      return targets.mobile;
    if (all.includes("/proddetail") || p.includes("/proddetail"))
      return targets.pdp;
    if (h.startsWith("dir.indiamart.") || h.endsWith(".dir.indiamart"))
      return targets.dir;
    return null;
  };

  return matches(host, pathname, full) ?? fallback;
}

function resolveRepoRoot(target: RepoTarget): string {
  return path.resolve(target.path.trim());
}

/** True when `filePath` is excluded for `target` (basename or repo-relative posix path match). */
function isFileSkippedForTarget(
  repoRoot: string,
  filePath: string,
  target: RepoTarget
): boolean {
  if (!target.skipFiles?.length) return false;
  const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/").toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  for (const pat of target.skipFiles) {
    const p = pat.replace(/\\/g, "/").toLowerCase();
    if (!p) continue;
    if (p === base) return true;
    if (p === rel) return true;
    if (rel.endsWith("/" + p)) return true;
  }
  return false;
}

/** Strip optional ```json fences and parse LLM output. */
function parseLlmJsonObject(raw: string): unknown {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/im.exec(s);
  if (fence) s = fence[1]!.trim();
  return JSON.parse(s);
}

/** Path segments from audited URL to prefer matching source files (e.g. /pcd/catalog → pcd, catalog). */
function pathTokensFromAuditedUrl(urlStr: string | undefined): Set<string> | undefined {
  if (!urlStr?.trim()) return undefined;
  try {
    const u = new URL(urlStr);
    const parts = u.pathname
      .split("/")
      .map((p) => decodeURIComponent(p).toLowerCase())
      .filter((p) => p.length > 2);
    const skip = new Set([
      "en",
      "us",
      "in",
      "www",
      "html",
      "htm",
      "page",
      "index",
      "static",
      "assets",
      "api",
      "v1",
      "v2",
    ]);
    const out = new Set<string>();
    for (const p of parts) {
      if (skip.has(p)) continue;
      out.add(p);
      const kebab = p.replace(/[-_]+/g, "");
      if (kebab.length > 3 && kebab !== p) out.add(kebab);
    }
    return out.size > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function pathSegmentsForBoost(relLower: string): string[] {
  return relLower
    .split(/[/\\]+/)
    .flatMap((p) => p.split(/[.\-_]+/g))
    .map((s) => s.replace(/\.(tsx|ts|jsx|js|html|vue)$/i, ""))
    .filter((s) => s.length >= 3);
}

/** URL path token matches folder/file names (handles impcat vs Mcat, etc.). */
function pathBoostScore(repoRoot: string, filePath: string, tokens?: Set<string>): number {
  if (!tokens?.size) return 0;
  const rel = path.relative(repoRoot, filePath).toLowerCase();
  const segs = pathSegmentsForBoost(rel);
  let n = 0;
  for (const t of Array.from(tokens)) {
    if (t.length > 2 && rel.includes(t)) n += 2;
    for (const s of segs) {
      if (s.length < 4) continue;
      if (s === t || s.includes(t) || t.includes(s)) n += 1;
    }
  }
  return n;
}

/** When multiple files match the same needle, pick one if URL path clearly points at one file. */
function pickFileByPathBoost(
  repoRoot: string,
  hits: string[],
  tokens?: Set<string>
): string | null {
  if (hits.length <= 1 || !tokens?.size) return null;
  let best: string | null = null;
  let bestScore = -1;
  for (const f of hits) {
    const s = pathBoostScore(repoRoot, f, tokens);
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }
  if (bestScore <= 0 || !best) return null;
  const winners = hits.filter((f) => pathBoostScore(repoRoot, f, tokens) === bestScore);
  return winners.length === 1 ? winners[0]! : null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout?.toString() ?? "";
}

function execErrText(e: unknown): string {
  if (e && typeof e === "object" && "stderr" in e && (e as { stderr?: unknown }).stderr) {
    return String((e as { stderr: unknown }).stderr);
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Push branch; on non-fast-forward (remote already has this branch), retry with --force-with-lease when enabled. */
async function gitPushBranch(
  repoRoot: string,
  target: RepoTarget,
  branch: string
): Promise<void> {
  const remote = target.remote || "origin";
  try {
    await git(repoRoot, ["push", "-u", remote, branch]);
    return;
  } catch (e) {
    const text = execErrText(e);
    const nonFf =
      /non-fast-forward|failed to push|rejected|!\s*\[rejected\]/i.test(text);
    if (nonFf && target.pushForceWithLease) {
      console.log(
        `[dirRepoFixes] push rejected (non-fast-forward); retrying with --force-with-lease ${remote}/${branch}`
      );
      await git(repoRoot, ["push", "--force-with-lease", "-u", remote, branch]);
      return;
    }
    if (nonFf && !target.pushForceWithLease) {
      throw new Error(
        `git push: non-fast-forward for "${branch}". Pull/merge the remote branch first, or set ${target.key.toUpperCase()}_PUSH_FORCE_WITH_LEASE=true to retry with --force-with-lease. ${text.trim()}`
      );
    }
    throw e;
  }
}

/** Checkout target.baseBranch, then create feature `branch` from it. */
async function checkoutBaseBranch(
  repoRoot: string,
  target: RepoTarget
): Promise<string> {
  const name = target.baseBranch.trim() || "stage";
  const remote = target.remote.trim() || "origin";
  await git(repoRoot, ["fetch", remote]).catch(() => {});
  try {
    await git(repoRoot, ["checkout", name]);
  } catch {
    try {
      await git(repoRoot, ["checkout", "-b", name, `${remote}/${name}`]);
    } catch {
      throw new Error(
        `Could not checkout base branch "${name}" in ${target.label}. Create it locally or ensure ${remote}/${name} exists.`
      );
    }
  }
  await git(repoRoot, ["pull", "--ff-only", remote, name]).catch(() => {});
  return name;
}

async function prepareFeatureBranch(
  repoRoot: string,
  target: RepoTarget,
  branch: string
): Promise<string> {
  const baseBranch = await checkoutBaseBranch(repoRoot, target);
  const listed = await git(repoRoot, ["branch", "--list", branch]);
  if (listed.trim()) {
    await git(repoRoot, ["checkout", baseBranch]);
    await git(repoRoot, ["branch", "-D", branch]);
  }
  await git(repoRoot, ["checkout", "-b", branch]);
  return baseBranch;
}

export async function assertRepoReady(target: RepoTarget): Promise<string> {
  const root = resolveRepoRoot(target);
  const st = await fs.stat(root).catch(() => null);
  if (!st?.isDirectory()) {
    throw new Error(
      `${target.label} repo path is not a directory: ${root}. Set ${target.key.toUpperCase()}_REPO_PATH or place ${target.label} next to this project.`
    );
  }
  await git(root, ["rev-parse", "--is-inside-work-tree"]);
  return root;
}

/** Backwards-compatible wrapper kept for callers that did not select a target. */
export async function assertDirRepoReady(): Promise<string> {
  return assertRepoReady(ENV.repoTargets.dir);
}

function sanitizeBranch(name: string): string {
  const base = name
    .trim()
    .replace(/[^a-zA-Z0-9/_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\/+|\/+$/g, "");
  const safe = base.slice(0, 180);
  return safe.length > 0 ? safe : `audit-fix-${Date.now()}`;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (TEXT_EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

/** Long strings from meta/title/description for shell files (SSR), not short tag names. */
function extractShellContentNeedles(snippet: string): string[] {
  const out: string[] = [];
  const title = snippet.match(/<title[^>]*>([^<]{8,500})<\/title>/i);
  if (title?.[1]) out.push(title[1].trim().slice(0, 200));
  const md = snippet.match(
    /<meta[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']{12,800})["']/i
  );
  if (md?.[1]) out.push(md[1].trim().slice(0, 220));
  const ogd = snippet.match(
    /<meta[^>]*\bproperty\s*=\s*["']og:description["'][^>]*\bcontent\s*=\s*["']([^"']{12,800})["']/i
  );
  if (ogd?.[1]) out.push(ogd[1].trim().slice(0, 220));
  const ogt = snippet.match(
    /<meta[^>]*\bproperty\s*=\s*["']og:title["'][^>]*\bcontent\s*=\s*["']([^"']{8,400})["']/i
  );
  if (ogt?.[1]) out.push(ogt[1].trim().slice(0, 160));
  const twt = snippet.match(
    /<meta[^>]*\bname\s*=\s*["']twitter:title["'][^>]*\bcontent\s*=\s*["']([^"']{8,400})["']/i
  );
  if (twt?.[1]) out.push(twt[1].trim().slice(0, 160));
  return out;
}

/** Short document / landmark tags — audits often emit `<html>` / `<title>` shorter than raw minLen. */
function documentTagNeedles(snippet: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (t.length < 4 || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const m of Array.from(
    snippet.matchAll(/<\s*(html|head|body|main|title|h1|h2|h3)\b[^>]*/gi)
  )) {
    const frag = m[0]!.replace(/\s+/g, " ").trim();
    add(frag);
    add(frag.slice(0, Math.min(frag.length, 80)));
  }
  add("<!doctype html");
  add("<!DOCTYPE html");
  for (const m of Array.from(snippet.matchAll(/<meta\b[^>]{10,500}>/gi))) {
    const full = m[0]!.replace(/\s+/g, " ").trim();
    if (full.length >= 14) add(full.slice(0, 120));
  }
  return out;
}

/**
 * Needles to locate source files when DOM is dynamic: try stable **id** and **class**
 * (DOM `class=` + TSX `className`) before raw HTML / free text.
 * Order is important — `findUniqueFileForSnippet` uses first needle with exactly one file hit.
 */
function buildSearchNeedles(snippet: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (s: string, minLen = 1) => {
    const t = s.trim();
    if (t.length < minLen || seen.has(t)) return;
    seen.add(t);
    ordered.push(t);
  };

  const raw = snippet.trim();
  if (!raw) return [];

  for (const n of extractShellContentNeedles(raw)) push(n, 8);
  for (const n of documentTagNeedles(raw)) push(n, 4);

  // --- 1) id=… (DOM) and JSX id forms (best for dynamic content) ---
  for (const m of Array.from(raw.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi))) {
    const id = m[1]!.trim();
    if (!id) continue;
    push(`id="${id}"`, 2);
    push(`id='${id}'`, 2);
    push(`id={"${id}"}`, 4);
    push(`id={'${id}'}`, 4);
    push(`id={\`${id}\`}`, 4);
    push(`htmlFor="${id}"`, 6);
    push(`htmlFor='${id}'`, 6);
    push(`htmlFor={"${id}"}`, 8);
    push(`aria-labelledby="${id}"`, 8);
    push(`aria-controls="${id}"`, 8);
    if (id.length >= 3) push(id, 3);
  }

  // --- 2) class="…" from rendered DOM + className / per-token (Tailwind, BEM, etc.) ---
  for (const m of Array.from(raw.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi))) {
    const fullAttr = m[0]!.trim();
    const c = m[1]!.trim();
    if (fullAttr.length >= 7) push(fullAttr, 7);
    if (c.length >= 5) {
      push(`className="${c}"`, 8);
      push(`className='${c}'`, 8);
      push(`className={"${c}"}`, 10);
      push(`className={'${c}'}`, 10);
      push(`className={\`${c}\`}`, 10);
      const tokens = Array.from(new Set(c.split(/\s+/).filter(Boolean))).sort(
        (a, b) => b.length - a.length
      );
      for (const tok of tokens) {
        if (tok.length >= 4) push(tok, 4);
        if (tok.length >= 4) push(`"${tok}"`, 4);
        if (tok.length >= 4) push(`'${tok}'`, 4);
      }
    }
  }

  // className="…" or className={'…'} if snippet already looks like JSX
  for (const m of Array.from(
    raw.matchAll(/\bclassName\s*=\s*(?:["']([^"']+)["']|\{["']([^"']+)["']\})/gi)
  )) {
    const c = (m[1] || m[2] || "").trim();
    if (c.length < 4) continue;
    const tokens = Array.from(new Set(c.split(/\s+/).filter(Boolean))).sort(
      (a, b) => b.length - a.length
    );
    for (const tok of tokens) {
      if (tok.length >= 4) push(tok, 4);
    }
  }

  // --- 3) data-* (stable hooks) ---
  for (const m of Array.from(
    raw.matchAll(/\bdata-[a-zA-Z0-9-]+\s*=\s*["']([^"']+)["']/gi)
  )) {
    const full = m[0]!.trim();
    if (full.length >= 8) push(full, 8);
    const v = m[1]!.trim();
    if (v.length >= 4) push(v, 4);
  }

  // --- 4) href ---
  for (const m of Array.from(raw.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi))) {
    const h = m[1]!.trim();
    if (h.length >= 8) push(h, 8);
  }

  // --- cn("…") / cn(`…`) (Tailwind helpers in source) ---
  for (const m of Array.from(raw.matchAll(/\bcn\s*\(\s*["']([^"']{4,})["']/gi))) {
    push(m[1]!, 4);
  }
  for (const m of Array.from(raw.matchAll(/\bcn\s*\(\s*`([^`]{4,})`/gi))) {
    push(m[1]!, 4);
  }

  // --- Opening tag fragment ---
  const tagM = raw.match(/<\s*[\w.-]+\b[^>]{0,400}/);
  if (tagM) {
    const frag = tagM[0].replace(/\s+/g, " ").trim();
    if (frag.length >= 10) push(frag, 10);
    if (frag.length >= 24) push(frag.slice(0, 90), 20);
  }

  // --- 5) full fragment / collapsed (last resort for static-ish HTML in repo) ---
  if (raw.startsWith("<") && raw.length <= 800) push(raw, 4);
  push(raw, 8);
  push(raw.replace(/\s+/g, " "), 8);
  push(raw.replace(/>\s+</g, "><").replace(/\s+/g, " "), 8);
  push(raw.replace(/\s+/g, ""), 12);

  // --- 6) visible text tokens ---
  const textOnly = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const t of textOnly.split(/\s+/).filter((w) => w.length >= 12)) {
    push(t, 12);
  }
  if (textOnly.length >= 18) {
    for (let n = Math.min(140, textOnly.length); n >= 18; n -= 12) {
      push(textOnly.slice(0, n), 18);
    }
  }

  return ordered;
}

function fileContainsInsensitive(content: string, needle: string): boolean {
  if (!needle) return false;
  if (content.includes(needle)) return true;
  return content.toLowerCase().includes(needle.toLowerCase());
}

function indexOfNeedle(content: string, needle: string): number {
  let i = content.indexOf(needle);
  if (i >= 0) return i;
  const nl = needle.toLowerCase();
  const cl = content.toLowerCase();
  i = cl.indexOf(nl);
  return i;
}

/** Class tokens from DOM snippet `class="a b-c"` (min length filter applied by caller). */
function snippetClassTokensFromDom(snippet: string): string[] {
  const tokens: string[] = [];
  for (const m of Array.from(snippet.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi))) {
    for (const p of m[1]!.split(/\s+/).filter(Boolean)) {
      tokens.push(p);
    }
  }
  return Array.from(new Set(tokens)).sort((a, b) => b.length - a.length);
}

function scoreClassValueAgainstWant(value: string, want: string[]): number {
  const set = new Set(
    value
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase())
  );
  let score = 0;
  for (const w of want) {
    if (set.has(w)) score += Math.min(w.length + 2, 24);
    else {
      for (const s of Array.from(set)) {
        if (s.length < 4 || w.length < 4) continue;
        if (s.includes(w) || w.includes(s)) {
          score += Math.min(s.length, w.length, 12);
          break;
        }
      }
    }
  }
  return score;
}

/**
 * Best start index of a `class="..."` / `class='...'` in `content` overlapping snippet class tokens
 * (order-independent; partial token overlap for BEM/Tailwind-style names).
 */
function findBestClassAttrAnchorIndex(content: string, snippet: string): number | null {
  const want = snippetClassTokensFromDom(snippet)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);
  if (want.length === 0) return null;
  let bestIdx: number | null = null;
  let bestScore = 0;
  for (const re of [/class\s*=\s*"([^"]*)"/gi, /class\s*=\s*'([^']*)'/gi]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const sc = scoreClassValueAgainstWant(m[1]!, want);
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = m.index ?? null;
      }
    }
  }
  return bestScore > 0 ? bestIdx : null;
}

/** Indices to center the source-patch LLM (id, data-*, class overlap, needle, strong class tokens). */
function collectPatchAnchorCandidates(
  before: string,
  snippet: string,
  needle: string,
  needleIdx: number
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const add = (i: number | null | undefined) => {
    if (i == null || i < 0) return;
    const r = Math.round(i);
    if (seen.has(r)) return;
    seen.add(r);
    out.push(r);
  };

  for (const id of Array.from(snippet.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi))
    .map((x) => x[1]!.trim())
    .filter(Boolean)) {
    for (const p of [
      `id="${id}"`,
      `id='${id}'`,
      `id={"${id}"}`,
      `id={'${id}'}`,
      `id={\`${id}\`}`,
    ]) {
      add(indexOfNeedle(before, p));
    }
  }

  for (const dm of Array.from(
    snippet.matchAll(/\b(data-[a-zA-Z0-9-]+)\s*=\s*["']([^"']+)["']/gi)
  )) {
    const name = dm[1]!;
    const val = dm[2]!.trim();
    if (val.length < 1) continue;
    add(indexOfNeedle(before, `${name}="${val}"`));
    add(indexOfNeedle(before, `${name}='${val}'`));
  }

  add(findBestClassAttrAnchorIndex(before, snippet));
  add(needleIdx >= 0 ? needleIdx : null);

  for (const tok of snippetClassTokensFromDom(snippet)) {
    if (tok.length < 4) continue;
    add(indexOfNeedle(before, tok));
    if (tok.length >= 6) {
      add(indexOfNeedle(before, `"${tok}"`));
      add(indexOfNeedle(before, `'${tok}'`));
    }
  }

  return out;
}

async function filesMatchingNeedle(
  allFiles: string[],
  needle: string
): Promise<string[]> {
  const hits: string[] = [];
  for (const file of allFiles) {
    const content = await fs.readFile(file, "utf8");
    if (fileContainsInsensitive(content, needle)) hits.push(file);
  }
  return hits;
}

/**
 * Prefer id + class **intersection** when id alone hits many files (dynamic layouts).
 * Matching is case-insensitive for class tokens and paths.
 */
async function findUniqueFileForSnippet(
  repoRoot: string,
  allFiles: string[],
  snippet: string,
  urlPathTokens?: Set<string>
): Promise<{ file: string; needle: string } | null> {
  const resolveHits = async (
    hits: string[],
    needle: string
  ): Promise<{ file: string; needle: string } | null> => {
    if (hits.length === 1) return { file: hits[0]!, needle };
    const boosted = pickFileByPathBoost(repoRoot, hits, urlPathTokens);
    if (boosted) return { file: boosted, needle };
    return null;
  };

  const ids = Array.from(
    snippet.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)
  )
    .map((m) => m[1]!.trim())
    .filter(Boolean);

  const classTokens: string[] = [];
  for (const m of Array.from(snippet.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi))) {
    const parts = m[1]!.split(/\s+/).filter(Boolean);
    for (const p of parts) {
      if (p.length >= 4) classTokens.push(p);
    }
  }
  classTokens.sort((a, b) => b.length - a.length);
  const uniqueTokens = Array.from(new Set(classTokens));

  for (const id of ids) {
    const idPatterns = [
      `id="${id}"`,
      `id='${id}'`,
      `id={"${id}"}`,
      `id={'${id}'}`,
      `id={\`${id}\`}`,
    ];
    for (const idPat of idPatterns) {
      let hits = await filesMatchingNeedle(allFiles, idPat);
      if (hits.length > 1 && uniqueTokens.length > 0) {
        for (const tok of uniqueTokens) {
          const next: string[] = [];
          for (const f of hits) {
            const c = await fs.readFile(f, "utf8");
            if (fileContainsInsensitive(c, tok)) next.push(f);
          }
          hits = next;
          if (hits.length <= 1) break;
        }
      }
      const r = await resolveHits(hits, idPat);
      if (r) return r;
    }
  }

  if (uniqueTokens.length >= 2) {
    const t0 = uniqueTokens[0]!;
    const t1 = uniqueTokens[1]!;
    if (t0.length >= 4 && t1.length >= 4 && t0 !== t1) {
      let hits = await filesMatchingNeedle(allFiles, t0);
      const narrowed: string[] = [];
      for (const f of hits) {
        const c = await fs.readFile(f, "utf8");
        if (fileContainsInsensitive(c, t1)) narrowed.push(f);
      }
      const r = await resolveHits(narrowed, t0);
      if (r) return r;
    }
  }
  for (const tok of uniqueTokens) {
    if (tok.length < 4) continue;
    const hits = await filesMatchingNeedle(allFiles, tok);
    const r = await resolveHits(hits, tok);
    if (r) return r;
  }

  for (const needle of buildSearchNeedles(snippet)) {
    const hits = await filesMatchingNeedle(allFiles, needle);
    const r = await resolveHits(hits, needle);
    if (r) return r;
  }
  return null;
}

type CandidateFile = { file: string; needle: string; how: string };

const IMPORT_RE_ES =
  /(?:^|[^\w$])(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g;
const REQUIRE_RE = /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const DYN_IMPORT_RE = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const IMPORT_EXTS = [".js", ".jsx", ".ts", ".tsx", ".vue", ".mdx", ".html", ".htm"];

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function resolveLocalImport(
  repoRoot: string,
  fromFile: string,
  spec: string
): Promise<string | null> {
  if (!spec) return null;
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const fromDir = path.dirname(fromFile);
  const startBase = spec.startsWith("/")
    ? path.join(repoRoot, spec)
    : path.join(fromDir, spec);
  const base = path.resolve(startBase);
  const rootLow = repoRoot.toLowerCase();
  if (!base.toLowerCase().startsWith(rootLow)) return null;

  if (await fileExists(base)) {
    const ext = path.extname(base).toLowerCase();
    if (TEXT_EXT.has(ext)) return base;
    return null;
  }
  for (const e of IMPORT_EXTS) {
    const candidate = base + e;
    if (await fileExists(candidate) && TEXT_EXT.has(e)) return candidate;
  }
  for (const e of IMPORT_EXTS) {
    const candidate = path.join(base, "index" + e);
    if (await fileExists(candidate) && TEXT_EXT.has(e)) return candidate;
  }
  return null;
}

async function readImportSpecs(content: string): Promise<string[]> {
  const out = new Set<string>();
  for (const m of Array.from(content.matchAll(IMPORT_RE_ES))) out.add(m[1]!);
  for (const m of Array.from(content.matchAll(REQUIRE_RE))) out.add(m[1]!);
  for (const m of Array.from(content.matchAll(DYN_IMPORT_RE))) out.add(m[1]!);
  return Array.from(out);
}

/** Recursively follow local imports/requires from `root` (depth-limited, capped). Returns resolved files only. */
async function collectImportedFiles(
  repoRoot: string,
  root: string,
  isAllowed: (file: string) => boolean,
  depth = 2,
  maxFiles = 12
): Promise<string[]> {
  const visited = new Set<string>([root]);
  const out: string[] = [];
  let frontier: string[] = [root];
  for (let d = 0; d < depth && out.length < maxFiles; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      let content = "";
      try {
        content = await fs.readFile(f, "utf8");
      } catch {
        continue;
      }
      const specs = await readImportSpecs(content);
      for (const s of specs) {
        const r = await resolveLocalImport(repoRoot, f, s);
        if (!r) continue;
        if (visited.has(r) || !isAllowed(r)) continue;
        visited.add(r);
        out.push(r);
        next.push(r);
        if (out.length >= maxFiles) break;
      }
      if (out.length >= maxFiles) break;
    }
    frontier = next;
  }
  return out;
}

function buildSnippetProbes(snippet: string): string[] {
  const probes: string[] = [];
  for (const m of Array.from(snippet.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi))) {
    probes.push(m[1]!);
  }
  for (const tok of snippetClassTokensFromDom(snippet)) {
    if (tok.length >= 4) probes.push(tok);
  }
  for (const m of Array.from(
    snippet.matchAll(/\b(data-[a-zA-Z0-9-]+)\s*=\s*["']([^"']+)["']/gi)
  )) {
    probes.push(`${m[1]}="${m[2]}"`);
  }
  const textOnly = snippet
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const w of textOnly.split(/\s+/)) {
    if (w.length >= 12) probes.push(w);
  }
  if (textOnly.length >= 20) probes.push(textOnly.slice(0, Math.min(120, textOnly.length)));

  const titleM = snippet.match(/<title[^>]*>([^<]{8,500})<\/title>/i);
  if (titleM?.[1]) probes.push(titleM[1].trim().slice(0, 200));
  const descM = snippet.match(
    /<meta[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']{12,800})["']/i
  );
  if (descM?.[1]) probes.push(descM[1].trim().slice(0, 220));
  return probes;
}

/**
 * Build a one-shot reverse-import index for `allFiles`: for each resolvable local import
 * spec found in a file, record that file as an importer of the resolved target.
 */
async function buildReverseImportIndex(
  repoRoot: string,
  allFiles: string[],
  isAllowed: (file: string) => boolean
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const concurrency = 8;
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= allFiles.length) return;
        const f = allFiles[idx]!;
        if (!isAllowed(f)) continue;
        let content = "";
        try {
          content = await fs.readFile(f, "utf8");
        } catch {
          continue;
        }
        if (!content) continue;
        const specs = await readImportSpecs(content);
        for (const s of specs) {
          const r = await resolveLocalImport(repoRoot, f, s);
          if (!r) continue;
          let arr = map.get(r);
          if (!arr) {
            arr = [];
            map.set(r, arr);
          }
          if (!arr.includes(f)) arr.push(f);
        }
      }
    })
  );
  return map;
}

/** Walk reverse importers up to a small depth (e.g. router files that call AppShell). */
function collectReverseImporters(
  reverseIndex: Map<string, string[]>,
  root: string,
  isAllowed: (file: string) => boolean,
  depth = 1,
  maxFiles = 6
): string[] {
  const visited = new Set<string>([root]);
  const out: string[] = [];
  let frontier: string[] = [root];
  for (let d = 0; d < depth && out.length < maxFiles; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      const importers = reverseIndex.get(f) || [];
      for (const r of importers) {
        if (visited.has(r) || !isAllowed(r)) continue;
        visited.add(r);
        out.push(r);
        next.push(r);
        if (out.length >= maxFiles) break;
      }
      if (out.length >= maxFiles) break;
    }
    frontier = next;
  }
  return out;
}

/**
 * Expand the initial candidate list using the import graph, in two directions:
 *  - Forward: files imported by each candidate (recursively, depth-limited) — covers
 *    helpers/components a template uses.
 *  - Reverse + sibling hop: files that import the candidate, plus the other forward
 *    imports of those importers — covers callback/dispatch patterns where the actual
 *    content owner is a sibling shell wired via a router (e.g. mcatShell, subcatShell,
 *    sidShell, dirHomeShell, groupShell, cityIndexShell calling AppShell through routes.js).
 *
 * Files are added only if their content matches a snippet-derived probe (id, class
 * token, data-*, long word, page text head, <title>, meta description).
 */
async function expandCandidatesViaImportGraph(
  repoRoot: string,
  candidates: CandidateFile[],
  snippet: string,
  isFileAllowed: (file: string) => boolean,
  reverseIndex: Map<string, string[]> | null,
  urlPathTokens: Set<string> | undefined,
  maxCandidates: number
): Promise<CandidateFile[]> {
  if (candidates.length === 0 || candidates.length >= maxCandidates) return candidates;

  const probes = buildSnippetProbes(snippet);
  const seen = new Set(candidates.map((c) => c.file));
  const acc: CandidateFile[] = [...candidates];

  const tryAdd = async (file: string, how: string) => {
    if (acc.length >= maxCandidates) return;
    if (seen.has(file)) return;
    if (!isFileAllowed(file)) return;
    let content = "";
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      return;
    }
    if (!content) return;
    const hit = probes.find((p) => p && fileContainsInsensitive(content, p));
    if (hit) {
      seen.add(file);
      acc.push({ file, needle: hit, how });
    }
  };

  /** Sort URL-relevant files to the front so the candidate cap doesn't get burned on irrelevant branches. */
  const sortByUrl = (files: string[]): string[] => {
    if (!urlPathTokens?.size) return files;
    return files
      .map((f) => ({ f, s: pathBoostScore(repoRoot, f, urlPathTokens) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.f);
  };

  for (const cand of candidates) {
    if (acc.length >= maxCandidates) break;
    const imports = await collectImportedFiles(
      repoRoot,
      cand.file,
      isFileAllowed,
      2,
      14
    );
    for (const imp of sortByUrl(imports)) {
      await tryAdd(imp, `imported by ${path.relative(repoRoot, cand.file)}`);
      if (acc.length >= maxCandidates) break;
    }
  }

  if (reverseIndex && acc.length < maxCandidates) {
    for (const cand of candidates) {
      if (acc.length >= maxCandidates) break;
      const importers = collectReverseImporters(
        reverseIndex,
        cand.file,
        isFileAllowed,
        1,
        6
      );
      for (const importer of sortByUrl(importers)) {
        await tryAdd(importer, `imports ${path.relative(repoRoot, cand.file)}`);
        if (acc.length >= maxCandidates) break;

        // Sibling hop: depth-1 forward from the importer (e.g. routes.js → *Shell.js).
        const siblings = await collectImportedFiles(
          repoRoot,
          importer,
          isFileAllowed,
          1,
          24
        );
        const sortedSiblings = sortByUrl(siblings.filter((s) => s !== cand.file));
        for (const sib of sortedSiblings) {
          if (acc.length >= maxCandidates) break;
          await tryAdd(sib, `callback via ${path.relative(repoRoot, importer)}`);

          // Inner hop: walk the sibling's own forward imports (depth 2, e.g.
          // mcatShell.js → McatApp.js → headers/components) so the actual content
          // owners get a chance to match the snippet probes.
          const inner = await collectImportedFiles(
            repoRoot,
            sib,
            isFileAllowed,
            2,
            18
          );
          const sortedInner = sortByUrl(
            inner.filter((i) => i !== cand.file && i !== sib && i !== importer)
          );
          for (const innerFile of sortedInner) {
            if (acc.length >= maxCandidates) break;
            await tryAdd(
              innerFile,
              `via ${path.relative(repoRoot, sib)} (callback through ${path.relative(repoRoot, importer)})`
            );
          }
        }
      }
    }
  }
  return acc;
}

/** Ranked candidate files (id → 2-token class → single class → general needles); first 3 are tried in order. */
async function findCandidateFilesForSnippet(
  repoRoot: string,
  allFiles: string[],
  snippet: string,
  urlPathTokens?: Set<string>,
  maxCandidates = 3
): Promise<CandidateFile[]> {
  const out: CandidateFile[] = [];
  const seen = new Set<string>();
  const add = (file: string, needle: string, how: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push({ file, needle, how });
  };
  const resolveAndCollect = (
    hits: string[],
    needle: string,
    how: string
  ): void => {
    if (hits.length === 0) return;
    if (hits.length === 1) {
      add(hits[0]!, needle, how);
      return;
    }
    const boosted = pickFileByPathBoost(repoRoot, hits, urlPathTokens);
    if (boosted) {
      add(boosted, needle, `${how} + url-boost`);
      return;
    }
    if (urlPathTokens?.size) {
      const ranked = hits
        .map((f) => ({ f, s: pathBoostScore(repoRoot, f, urlPathTokens) }))
        .sort((a, b) => b.s - a.s);
      for (const { f, s } of ranked.slice(0, maxCandidates)) {
        if (s <= 0) break;
        add(f, needle, `${how} + url-rank`);
      }
    }
  };

  const ids = Array.from(snippet.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi))
    .map((m) => m[1]!.trim())
    .filter(Boolean);
  const classTokensRaw: string[] = [];
  for (const m of Array.from(
    snippet.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)
  )) {
    for (const p of m[1]!.split(/\s+/).filter(Boolean)) {
      if (p.length >= 4) classTokensRaw.push(p);
    }
  }
  const uniqueTokens = Array.from(new Set(classTokensRaw)).sort(
    (a, b) => b.length - a.length
  );

  for (const id of ids) {
    if (out.length >= maxCandidates) break;
    for (const idPat of [
      `id="${id}"`,
      `id='${id}'`,
      `id={"${id}"}`,
      `id={'${id}'}`,
      `id={\`${id}\`}`,
    ]) {
      let hits = await filesMatchingNeedle(allFiles, idPat);
      if (hits.length > 1 && uniqueTokens.length > 0) {
        for (const tok of uniqueTokens) {
          const next: string[] = [];
          for (const f of hits) {
            const c = await fs.readFile(f, "utf8");
            if (fileContainsInsensitive(c, tok)) next.push(f);
          }
          if (next.length > 0 && next.length < hits.length) hits = next;
          if (hits.length <= 1) break;
        }
      }
      resolveAndCollect(hits, idPat, `id ${id}`);
      if (out.length >= maxCandidates) break;
    }
  }

  if (out.length < maxCandidates && uniqueTokens.length >= 2) {
    const t0 = uniqueTokens[0]!;
    const t1 = uniqueTokens[1]!;
    const hitsA = await filesMatchingNeedle(allFiles, t0);
    const both: string[] = [];
    for (const f of hitsA) {
      const c = await fs.readFile(f, "utf8");
      if (fileContainsInsensitive(c, t1)) both.push(f);
    }
    resolveAndCollect(both, t0, `class ${t0}+${t1}`);
  }

  for (const tok of uniqueTokens) {
    if (out.length >= maxCandidates) break;
    if (tok.length < 4) continue;
    const hits = await filesMatchingNeedle(allFiles, tok);
    resolveAndCollect(hits, tok, `class ${tok}`);
  }

  if (out.length < maxCandidates) {
    for (const needle of buildSearchNeedles(snippet)) {
      if (out.length >= maxCandidates) break;
      const hits = await filesMatchingNeedle(allFiles, needle);
      resolveAndCollect(hits, needle, `needle "${needle.slice(0, 24)}…"`);
    }
  }

  return out.slice(0, maxCandidates);
}

async function summarizeMatchFailure(
  allFiles: string[],
  snippet: string,
  urlPathTokens?: Set<string>
): Promise<string> {
  const needles = buildSearchNeedles(snippet).slice(0, 12);
  const lines: string[] = [];
  lines.push(`Scanned ${allFiles.length} source files (.html,.tsx,.ts,.jsx,…).`);
  if (urlPathTokens?.size) {
    lines.push(
      `Audited URL path tokens (file pick boost): ${Array.from(urlPathTokens).slice(0, 12).join(", ")}.`
    );
  }
  if (needles.length === 0) {
    lines.push("Snippet produced no search needles (too short or empty).");
    return lines.join(" ");
  }
  for (const n of needles.slice(0, 6)) {
    const hits = await filesMatchingNeedle(allFiles, n);
    const preview = n.length > 42 ? `${n.slice(0, 42)}…` : n;
    lines.push(`"${preview}" → ${hits.length} file(s)`);
  }
  lines.push(
    "Tip: audited HTML is rendered DOM; source uses className/tsx. Ensure snippets include real id= or class= from the page, or add data-testid in the app."
  );
  return lines.join(" ");
}

async function inferReplacementHtml(params: {
  issue: string;
  recommendation: string;
  htmlSnippet: string;
  /** Real file slices so replacement matches sibling-repo markup, not only DOM. */
  sourceGrounding?: string;
  llm_api_key: string;
  llm_model: string;
}): Promise<string | null> {
  const raw = await llmCompleteJson(params.llm_api_key, params.llm_model, [
    {
      role: "system",
      content:
        "You help apply HTML fixes. Reply with ONLY a JSON object: {\"action\":\"replace\"|\"skip\",\"replacementHtml\":\"...\"}. " +
        "If action is replace, replacementHtml must be the full HTML fragment to substitute for htmlSnippet (same role in the document). " +
        "SOURCE_GROUNDING (if present) shows how this fragment appears in the target file — match quoting, attributes, and structure from there when possible. " +
        "If you cannot safely produce a drop-in replacement, use action skip and empty replacementHtml.",
    },
    {
      role: "user",
      content: JSON.stringify({
        issue: params.issue,
        recommendation: params.recommendation,
        htmlSnippet: params.htmlSnippet,
        SOURCE_GROUNDING: params.sourceGrounding?.slice(0, 10_000),
      }),
    },
  ]);
  let parsed: unknown;
  try {
    parsed = parseLlmJsonObject(raw);
  } catch {
    return null;
  }
  const r = ReplacementSchema.safeParse(parsed);
  if (!r.success || r.data.action === "skip") return null;
  const rep = (r.data.replacementHtml ?? "").trim();
  if (!rep || rep === params.htmlSnippet.trim()) return null;
  return rep;
}

const FULL_FILE_MAX = 110_000;

function allIndicesOfNeedle(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const slice = haystack.slice(from);
    const i = indexOfNeedle(slice, needle);
    if (i < 0) break;
    const abs = from + i;
    out.push(abs);
    from = abs + Math.max(1, needle.length);
  }
  return out;
}

/** When oldSource appears multiple times, replace the occurrence closest to the locate needle index. */
function applyPatchNearAnchor(
  before: string,
  oldSource: string,
  newSource: string,
  anchorIdx: number
): string | null {
  const positions = allIndicesOfNeedle(before, oldSource);
  if (positions.length === 0) return null;
  let best = positions[0]!;
  let bestDist = Math.abs(best - anchorIdx);
  for (const p of positions) {
    const d = Math.abs(p - anchorIdx);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return before.slice(0, best) + newSource + before.slice(best + oldSource.length);
}

async function inferSourcePatch(params: {
  relativePath: string;
  sourceWindow: string;
  fullFile?: string;
  /** Narrow slice around the matched id/class/needle — helps the model align oldSource. */
  anchorContext?: string;
  /** Wider excerpts where snippet ids/classes/data-* hit the real source (DOM → source bridge). */
  sourceGroundingExcerpts?: string;
  issue: string;
  recommendation: string;
  htmlSnippet: string;
  matchNeedle: string;
  llm_api_key: string;
  llm_model: string;
}): Promise<{ oldSource: string; newSource: string } | null> {
  const useFull =
    params.fullFile !== undefined && params.fullFile.length <= FULL_FILE_MAX;
  const raw = await llmCompleteJson(params.llm_api_key, params.llm_model, [
    {
      role: "system",
      content:
        "The audit used RENDERED DOM HTML from a live page. This file is TSX/JSX/HTML source. " +
        "Return ONLY JSON: {\"action\":\"replace\"|\"skip\",\"oldSource\":\"...\",\"newSource\":\"...\"}. " +
        (useFull
          ? "oldSource MUST be copied EXACTLY once from FILE_FULL (character-for-character, including spaces and quotes). newSource must be valid JSX/TSX/HTML source that implements the recommendation. Prefer replace over skip when the fix is localized."
          : "oldSource MUST be copied EXACTLY once from SOURCE_WINDOW. newSource must be valid JSX/TSX/HTML. Prefer replace when the fix is localized.") +
        " ANCHOR_CONTEXT (if present) shows the intended edit neighborhood — oldSource should appear in or overlap that region when possible." +
        " SOURCE_GROUNDING_EXCERPTS (if present) lists real regions of THIS file where DOM ids/classes/data-* from the audit appear (often className/cn/JSX). Use them to copy exact source for oldSource and to adapt the recommendation to dynamic code." +
        " If impossible, use skip.",
    },
    {
      role: "user",
      content: JSON.stringify(
        useFull
          ? {
              file: params.relativePath,
              matchedNeedleInSource: params.matchNeedle,
              renderedHtmlSnippet: params.htmlSnippet,
              issue: params.issue,
              recommendation: params.recommendation,
              ANCHOR_CONTEXT: params.anchorContext,
              SOURCE_GROUNDING_EXCERPTS: params.sourceGroundingExcerpts,
              FILE_FULL: params.fullFile,
            }
          : {
              file: params.relativePath,
              matchedNeedleInSource: params.matchNeedle,
              renderedHtmlSnippet: params.htmlSnippet,
              issue: params.issue,
              recommendation: params.recommendation,
              ANCHOR_CONTEXT: params.anchorContext,
              SOURCE_GROUNDING_EXCERPTS: params.sourceGroundingExcerpts,
              SOURCE_WINDOW: params.sourceWindow,
            }
      ),
    },
  ]);
  let parsed: unknown;
  try {
    parsed = parseLlmJsonObject(raw);
  } catch {
    return null;
  }
  const r = SourcePatchSchema.safeParse(parsed);
  if (!r.success || r.data.action === "skip") return null;
  const oldS = (r.data.oldSource ?? "").trim();
  const newS = (r.data.newSource ?? "").trim();
  if (!oldS || oldS === newS || oldS.length < 8) return null;
  return { oldSource: oldS, newSource: newS };
}

function anchorContextSlice(before: string, idx: number): string | undefined {
  const a = Math.max(0, idx - 180);
  const b = Math.min(before.length, idx + 380);
  const s = before.slice(a, b);
  return s.length > 0 ? s : undefined;
}

function mergeByteRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let [cs, ce] = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i]!;
    if (a <= ce + 8) ce = Math.max(ce, b);
    else {
      out.push([cs, ce]);
      cs = a;
      ce = b;
    }
  }
  out.push([cs, ce]);
  return out;
}

/**
 * Concatenated source slices where ids/classes from the audit snippet appear — maps DOM hints to real TSX/HTML.
 */
function collectSourceGroundingExcerpts(
  before: string,
  snippet: string,
  anchorIdx: number,
  maxChars: number
): string {
  const ranges: [number, number][] = [];
  const span = (center: number, half: number) => {
    ranges.push([
      Math.max(0, center - half),
      Math.min(before.length, center + half),
    ]);
  };

  span(anchorIdx, 450);

  for (const id of Array.from(snippet.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi))
    .map((x) => x[1]!.trim())
    .filter(Boolean)) {
    for (const p of [`id="${id}"`, `id='${id}'`, `id={"${id}"}`, `id={'${id}'}`]) {
      let from = 0;
      let n = 0;
      while (n < 4) {
        const sub = before.slice(from);
        const i = indexOfNeedle(sub, p);
        if (i < 0) break;
        const abs = from + i;
        span(abs, 260);
        from = abs + Math.max(1, p.length);
        n++;
      }
    }
  }

  for (const tok of snippetClassTokensFromDom(snippet)) {
    if (tok.length < 5) continue;
    const positions = allIndicesOfNeedle(before, tok);
    if (positions.length > 28) continue;
    const take = Math.min(5, positions.length);
    for (let i = 0; i < take; i++) span(positions[i]!, 240);
  }

  for (const dm of Array.from(
    snippet.matchAll(/\b(data-[a-zA-Z0-9-]+)\s*=\s*["']([^"']+)["']/gi)
  )) {
    const probe = `${dm[1]}="${dm[2]}"`;
    const j = indexOfNeedle(before, probe);
    if (j >= 0) span(j, 280);
  }

  const merged = mergeByteRanges(ranges);
  let buf = "";
  for (const [a, b] of merged) {
    const head = `\n/* --- bytes ${a}-${b} --- */\n`;
    const piece = before.slice(a, b);
    if (buf.length + head.length + piece.length > maxChars) break;
    buf += head + piece;
  }
  return buf.trim();
}

/** Rewrite audit recommendation so it targets this repo file (JSX/className/cn vs DOM class). */
async function refineRecommendationForDirSource(params: {
  relativePath: string;
  issue: string;
  recommendation: string;
  htmlSnippet: string;
  sourceGrounding: string;
  llm_api_key: string;
  llm_model: string;
}): Promise<string> {
  const raw = await llmCompleteJson(params.llm_api_key, params.llm_model, [
    {
      role: "system",
      content:
        "Return ONLY JSON: {\"adaptedRecommendation\":\"...\"}. " +
        "The audit described RENDERED DOM (class=, static HTML). The sibling repo uses TSX/JSX/JS (className=, cn(), template literals, conditionals) or plain HTML. " +
        "Rewrite the recommendation so it names concrete patterns to change in THIS file (e.g. className, aria-*, tags) using evidence from SOURCE_GROUNDING. " +
        "Keep the same intent; do not invent file paths; stay under 1200 characters.",
    },
    {
      role: "user",
      content: JSON.stringify({
        file: params.relativePath,
        issue: params.issue,
        originalRecommendation: params.recommendation,
        renderedHtmlSnippet: params.htmlSnippet,
        SOURCE_GROUNDING: params.sourceGrounding.slice(0, 12_000),
      }),
    },
  ]);
  let parsed: unknown;
  try {
    parsed = parseLlmJsonObject(raw);
  } catch {
    return params.recommendation;
  }
  const r = AdaptedRecommendationSchema.safeParse(parsed);
  if (!r.success) return params.recommendation;
  const t = r.data.adaptedRecommendation.trim();
  return t.length > 0 ? t : params.recommendation;
}

async function tryInferSourcePatchWithRetries(
  rel: string,
  before: string,
  idx: number,
  needle: string,
  snippet: string,
  issue: string,
  recommendation: string,
  llm_api_key: string,
  llm_model: string
): Promise<{ oldSource: string; newSource: string } | null> {
  const winStart = Math.max(0, idx - 4000);
  const winEnd = Math.min(before.length, idx + needle.length + 4000);
  const window = before.slice(winStart, winEnd);
  const anchorContext = anchorContextSlice(before, idx);
  const sourceGroundingExcerpts = collectSourceGroundingExcerpts(
    before,
    snippet,
    idx,
    12_000
  );

  const patchOk = (p: { oldSource: string; newSource: string } | null) => {
    if (!p) return false;
    if (before.split(p.oldSource).length === 2) return true;
    return applyPatchNearAnchor(before, p.oldSource, p.newSource, idx) !== null;
  };

  let patch = await inferSourcePatch({
    relativePath: rel,
    sourceWindow: window,
    anchorContext,
    sourceGroundingExcerpts,
    issue,
    recommendation,
    htmlSnippet: snippet,
    matchNeedle: needle,
    llm_api_key,
    llm_model,
  });
  if (patchOk(patch)) {
    return patch;
  }

  if (before.length <= FULL_FILE_MAX) {
    patch = await inferSourcePatch({
      relativePath: rel,
      sourceWindow: window,
      fullFile: before,
      anchorContext,
      sourceGroundingExcerpts,
      issue,
      recommendation,
      htmlSnippet: snippet,
      matchNeedle: needle,
      llm_api_key,
      llm_model,
    });
    if (patchOk(patch)) {
      return patch;
    }
  }

  return null;
}

function collectIssues(report: AuditReport): AuditIssue[] {
  const keys = [
    "llmFriendly",
    "w3cCompliance",
    "seo",
    "semanticHtml",
    "accessibility",
  ] as const;
  const list: AuditIssue[] = [];
  for (const k of keys) {
    for (const issue of report[k].issues) {
      const snip = issue.htmlSnippet?.trim();
      if (snip && snip.length >= 6) list.push({ ...issue, htmlSnippet: snip });
    }
  }
  return list;
}

export type ApplyDirFixesResult = {
  repoRoot: string;
  /** Which sibling repo was chosen (dir/pdp/mobile). */
  repoTarget: RepoTargetKey;
  /** Human label for the chosen repo. */
  repoLabel: string;
  branch: string;
  filesTouched: string[];
  issuesAttempted: number;
  issuesApplied: number;
  skipped: { reason: string }[];
  commitSha: string | null;
  pushed: boolean;
  /** When nothing applied: why needles did not resolve to one file (first issue). */
  locationSummary?: string;
  /** Per-issue trace so users see which file/needle was tried and outcome. */
  issueTrace?: {
    issue: string;
    candidates: { file: string; how: string }[];
    appliedFile?: string;
    outcome: "applied" | "skipped";
    detail?: string;
  }[];
};

export async function applyAuditRecommendationsToDir(params: {
  report: AuditReport;
  branchName: string;
  llm_api_key: string;
  llm_model: string;
  /** Audited page URL — chooses target repo (dir/pdp/mobile) and helps pick files. */
  auditedPageUrl?: string;
  /** Override URL-based selection. */
  repoTarget?: RepoTargetKey;
}): Promise<ApplyDirFixesResult> {
  const target = params.repoTarget
    ? ENV.repoTargets[params.repoTarget]
    : pickRepoTargetForUrl(params.auditedPageUrl);
  console.log(
    `[applyAuditRecommendationsToDir] target=${target.key} (${target.label}) for url=${params.auditedPageUrl ?? "<none>"}`
  );
  const repoRoot = await assertRepoReady(target);
  const branch = sanitizeBranch(params.branchName);

  const status = await git(repoRoot, ["status", "--porcelain"]);
  if (status.trim().length > 0) {
    throw new Error(
      `${target.label} repo has uncommitted changes. Commit or stash them before running apply.`
    );
  }

  const baseBranch = await prepareFeatureBranch(repoRoot, target, branch);

  const issues = collectIssues(params.report).slice(0, 20);
  const skipped: { reason: string }[] = [];
  const filesTouched = new Set<string>();
  const issueTrace: NonNullable<ApplyDirFixesResult["issueTrace"]> = [];
  let applied = 0;

  const walked = await walkFiles(repoRoot);
  const allFiles = walked.filter(
    (f) => !isFileSkippedForTarget(repoRoot, f, target)
  );
  if (target.skipFiles.length > 0) {
    const skippedCount = walked.length - allFiles.length;
    console.log(
      `[applyAuditRecommendationsToDir] target=${target.key} skipFiles=${JSON.stringify(target.skipFiles)} excluded=${skippedCount}`
    );
  }
  const urlPathTokens = pathTokensFromAuditedUrl(params.auditedPageUrl);

  const allowedSet = new Set(allFiles);
  const isFileAllowed = (file: string) =>
    allowedSet.has(file) && !isFileSkippedForTarget(repoRoot, file, target);

  let reverseImportIndex: Map<string, string[]> | null = null;
  try {
    reverseImportIndex = await buildReverseImportIndex(
      repoRoot,
      allFiles,
      isFileAllowed
    );
    console.log(
      `[applyAuditRecommendationsToDir] reverseImportIndex entries=${reverseImportIndex.size}`
    );
  } catch (e) {
    console.warn(
      `[applyAuditRecommendationsToDir] failed to build reverseImportIndex: ${(e as Error).message}`
    );
  }

  for (const issue of issues) {
    const snippet = issue.htmlSnippet!;
    const baseCandidates = await findCandidateFilesForSnippet(
      repoRoot,
      allFiles,
      snippet,
      urlPathTokens,
      3
    );
    const candidates = await expandCandidatesViaImportGraph(
      repoRoot,
      baseCandidates,
      snippet,
      isFileAllowed,
      reverseImportIndex,
      urlPathTokens,
      8
    );

    const candSummary = candidates.map((c) => ({
      file: path.relative(repoRoot, c.file),
      how: c.how,
    }));
    console.log(
      `[applyAuditRecommendationsToDir] issue="${issue.issue.slice(0, 60)}" candidates=${JSON.stringify(candSummary)}`
    );

    if (candidates.length === 0) {
      const reason = `No file matched DOM hints (id/class/data-*) for: ${issue.issue.slice(0, 55)}…`;
      skipped.push({ reason });
      issueTrace.push({
        issue: issue.issue,
        candidates: candSummary,
        outcome: "skipped",
        detail: reason,
      });
      continue;
    }

    let appliedThisIssue = false;
    let lastDetail = "";

    for (const cand of candidates) {
      if (appliedThisIssue) break;
      const filePath = cand.file;
      const needle = cand.needle;
      const rel = path.relative(repoRoot, filePath);
      const before = await fs.readFile(filePath, "utf8");

      const needleIdxForGround = indexOfNeedle(before, needle);
      const refineAnchor =
        needleIdxForGround >= 0
          ? needleIdxForGround
          : (findBestClassAttrAnchorIndex(before, snippet) ?? 0);
      const refineGround = collectSourceGroundingExcerpts(
        before,
        snippet,
        refineAnchor,
        9000
      );
      let recommendationToUse = issue.recommendation;
      try {
        recommendationToUse = await refineRecommendationForDirSource({
          relativePath: rel,
          issue: issue.issue,
          recommendation: issue.recommendation,
          htmlSnippet: snippet,
          sourceGrounding: refineGround,
          llm_api_key: params.llm_api_key,
          llm_model: params.llm_model,
        });
      } catch {
        recommendationToUse = issue.recommendation;
      }

      let after: string | null = null;
      const snipIdx = indexOfNeedle(before, snippet);
      if (snipIdx >= 0) {
        try {
          const replacement = await inferReplacementHtml({
            issue: issue.issue,
            recommendation: recommendationToUse,
            htmlSnippet: snippet,
            sourceGrounding: collectSourceGroundingExcerpts(
              before,
              snippet,
              snipIdx,
              8000
            ),
            llm_api_key: params.llm_api_key,
            llm_model: params.llm_model,
          });
          if (replacement) {
            const matchedLen = Math.min(
              snippet.length,
              before.length - snipIdx
            );
            const matched = before.slice(snipIdx, snipIdx + matchedLen);
            after =
              before.slice(0, snipIdx) +
              replacement +
              before.slice(snipIdx + matched.length);
          } else {
            lastDetail = `No HTML replacement returned by LLM in ${rel}`;
          }
        } catch (e) {
          lastDetail = `LLM replacement error in ${rel}: ${e instanceof Error ? e.message : String(e)}`;
        }
      } else {
        const needleIdx = indexOfNeedle(before, needle);
        if (needleIdx < 0) {
          lastDetail = `Needle disappeared in ${rel} after candidate selection`;
        } else {
          const anchorCandidates = collectPatchAnchorCandidates(
            before,
            snippet,
            needle,
            needleIdx
          );
          let patch: { oldSource: string; newSource: string } | null = null;
          let anchorUsed = needleIdx;
          try {
            for (const idx of anchorCandidates.slice(0, 5)) {
              const p = await tryInferSourcePatchWithRetries(
                rel,
                before,
                idx,
                needle,
                snippet,
                issue.issue,
                recommendationToUse,
                params.llm_api_key,
                params.llm_model
              );
              if (p) {
                patch = p;
                anchorUsed = idx;
                break;
              }
            }
          } catch (e) {
            lastDetail = `Source-patch LLM error in ${rel}: ${e instanceof Error ? e.message : String(e)}`;
          }
          if (patch) {
            const parts = before.split(patch.oldSource);
            if (parts.length === 2) {
              after = parts[0] + patch.newSource + parts[1];
            } else {
              const anchored = applyPatchNearAnchor(
                before,
                patch.oldSource,
                patch.newSource,
                anchorUsed
              );
              if (!anchored) {
                lastDetail = `Patch oldSource not unique in ${rel} (${parts.length - 1} matches) and no anchored fit`;
              } else {
                after = anchored;
              }
            }
          } else if (!lastDetail) {
            lastDetail = `LLM produced no patch for ${rel} (skip or empty oldSource)`;
          }
        }
      }

      if (after !== null) {
        await fs.writeFile(filePath, after, "utf8");
        filesTouched.add(rel);
        applied++;
        appliedThisIssue = true;
        issueTrace.push({
          issue: issue.issue,
          candidates: candSummary,
          appliedFile: rel,
          outcome: "applied",
        });
        console.log(
          `[applyAuditRecommendationsToDir] APPLIED → ${rel} (issue="${issue.issue.slice(0, 60)}")`
        );
      } else {
        console.log(
          `[applyAuditRecommendationsToDir] cand-skip ${rel}: ${lastDetail || "unknown"}`
        );
      }
    }

    if (!appliedThisIssue) {
      const reason = lastDetail || `Could not patch any candidate file for: ${issue.issue.slice(0, 50)}…`;
      skipped.push({ reason });
      issueTrace.push({
        issue: issue.issue,
        candidates: candSummary,
        outcome: "skipped",
        detail: reason,
      });
    }
  }

  let locationSummary: string | undefined;
  if (applied === 0 && issues.length > 0 && issues[0]?.htmlSnippet) {
    locationSummary = await summarizeMatchFailure(
      allFiles,
      issues[0].htmlSnippet,
      urlPathTokens
    );
  }

  if (filesTouched.size === 0) {
    await git(repoRoot, ["checkout", baseBranch]);
    await git(repoRoot, ["branch", "-D", branch]).catch(() => {});
    return {
      repoRoot,
      repoTarget: target.key,
      repoLabel: target.label,
      branch,
      filesTouched: [],
      issuesAttempted: issues.length,
      issuesApplied: 0,
      skipped,
      commitSha: null,
      pushed: false,
      locationSummary,
      issueTrace,
    };
  }

  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, [
    "commit",
    "-m",
    `chore(audit): apply HTML recommendations (${applied} change(s))`,
  ]);
  const shaOut = await git(repoRoot, ["rev-parse", "HEAD"]);
  const commitSha = shaOut.trim() || null;

  await gitPushBranch(repoRoot, target, branch);

  return {
    repoRoot,
    repoTarget: target.key,
    repoLabel: target.label,
    branch,
    filesTouched: Array.from(filesTouched),
    issuesAttempted: issues.length,
    issuesApplied: applied,
    skipped,
    commitSha,
    pushed: true,
    locationSummary: undefined,
    issueTrace,
  };
}
