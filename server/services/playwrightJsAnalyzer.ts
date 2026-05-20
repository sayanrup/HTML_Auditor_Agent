import { chromium } from "playwright";

export type JsAnalysisResult = {
  /** Total chars of all imimg.com JS files (including packages). */
  jsChars: number;
  /** Chars of imimg.com JS files that are NOT package/vendor bundles. */
  jsCharsApp: number;
  /** Total JS files captured from imimg.com (static + dynamically loaded). */
  jsFilesTotal: number;
  /** Files classified as package/vendor bundles. */
  jsFilesPackage: number;
  /** jsChars / visibleTextChars — ratio including packages. */
  jsToTextRatio: number;
  /** jsCharsApp / visibleTextChars — ratio excluding packages. */
  jsToTextRatioApp: number;
  /** Total chars of all imimg.com external CSS files (including pkg). */
  cssCharsExt: number;
  /** Chars of imimg.com external CSS that are NOT package/vendor bundles. */
  cssCharsExtApp: number;
  /** Total external CSS files captured from imimg.com. */
  cssExtCount: number;
  /** External CSS files classified as package/vendor. */
  cssExtPackage: number;
};

// ── JS package classification ──────────────────────────────────────────────

const JS_PKG_RE =
  /\b(vendors?[-~.]|chunk[-.]?vendor|react(?:-dom)?|jquery|lodash|underscore|polyfill|core[-.]?js|regenerator|runtime[-.]|framework[-.]|angular|vue\b|bootstrap|webpack[-.]runtime|three\b|d3\b)\b/i;

function classifyJs(url: string, content: string): "package" | "app" {
  const filename = (url.split("/").pop() ?? "").split("?")[0].toLowerCase();
  if (JS_PKG_RE.test(filename)) return "package";

  const head = content.slice(0, 6000);
  const licenseComments = (head.match(/\/\*!/g) ?? []).length;
  if (licenseComments >= 3) return "package";
  if (/\/\*![\s\S]{0,300}(?:React|ReactDOM|jQuery|Lodash|Underscore|Angular|Vue\.js)\b/i.test(head))
    return "package";
  const externalModules = (content.match(/\/\/ EXTERNAL MODULE:/g) ?? []).length;
  if (externalModules >= 5) return "package";
  if (/Copyright\s.*(?:Facebook|Meta|jQuery Foundation|Google Inc)/i.test(head)) return "package";

  return "app";
}

// Estimate vendor chars inside a file that passed the "app" classifier but may
// contain embedded vendor code. Two strategies tried in order:
//  1. Webpack module entry markers (non-minified builds): path strings containing
//     "node_modules" define module boundaries; we sum the chars of those sections.
//  2. License comment block regions (production minified builds): minifiers keep
//     "important" comments. Code from one license block to the next is the vendor
//     lib following its header. The last block is counted as its comment only
//     (trailing code may be app code).
function estimateVendorCharsWithin(content: string): number {
  // Strategy 1: webpack non-minified module path comments
  if (content.includes('/***/ "./node_modules/')) {
    const entryRe = /\/\*\*\*\/ "(\.\/[^"]+)":/g;
    const entries: Array<{ idx: number; isVendor: boolean }> = [];
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(content)) !== null) {
      entries.push({ idx: m.index, isVendor: m[1].includes("node_modules") });
    }
    let vendorChars = 0;
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].isVendor) continue;
      const end = i + 1 < entries.length ? entries[i + 1].idx : content.length;
      vendorChars += end - entries[i].idx;
    }
    if (vendorChars > 0) return Math.min(vendorChars, content.length);
  }

  // Strategy 2: license comment block regions
  const licenseRe = /\/\*![\s\S]*?\*\//g;
  const blocks: Array<{ start: number; end: number }> = [];
  let m2: RegExpExecArray | null;
  while ((m2 = licenseRe.exec(content)) !== null) {
    blocks.push({ start: m2.index, end: m2.index + m2[0].length });
  }
  if (blocks.length === 0) return 0;

  let vendorChars = 0;
  for (let i = 0; i < blocks.length; i++) {
    // Code from this block's start to the next block's start is the vendor library
    // that follows its license header. For the last block, only count the comment
    // itself to avoid attributing trailing app code to vendor.
    const end = i + 1 < blocks.length ? blocks[i + 1].start : blocks[i].end;
    vendorChars += end - blocks[i].start;
  }
  return Math.min(vendorChars, content.length);
}

// ── CSS package classification ─────────────────────────────────────────────

const CSS_PKG_RE =
  /\b(bootstrap|normalize|reset|tailwind|bulma|foundation|materialize|semantic[-.]ui|fontawesome|font-awesome|animate|slick|swiper|owl[-.]carousel|vendors?[-~.]|vendor[-.]|framework)\b/i;

function classifyCss(url: string, content: string): "package" | "app" {
  const filename = (url.split("/").pop() ?? "").split("?")[0].toLowerCase();
  if (CSS_PKG_RE.test(filename)) return "package";

  const head = content.slice(0, 2000);
  if (/(?:Bootstrap|Normalize\.css|Tailwind|Font Awesome|Bulma)\s+v?\d/i.test(head)) return "package";
  // Multiple /*! license comments = bundled vendor CSS
  const licenseComments = (head.match(/\/\*!/g) ?? []).length;
  if (licenseComments >= 2) return "package";

  return "app";
}

// ── shared fetch helper ────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  try {
    const full = url.startsWith("//") ? `https:${url}` : url;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch(full, { signal: ctrl.signal, headers: { "User-Agent": "audit-bot/1.0" } });
      return res.ok ? await res.text() : "";
    } finally {
      clearTimeout(t);
    }
  } catch {
    return "";
  }
}

// ── HTML-only fallback ─────────────────────────────────────────────────────

async function analyzeFromHtml(
  html: string,
  visibleTextChars: number,
  jsDomain: string
): Promise<JsAnalysisResult> {
  const escaped = jsDomain.replace(/\./g, "\\.");

  const jsUrlRe = new RegExp(
    `<script\\b[^>]*\\bsrc\\s*=\\s*["']([^"']*${escaped}[^"']*)["'][^>]*>`,
    "gi"
  );
  const cssUrlRe = new RegExp(
    `<link\\b[^>]*\\brel\\s*=\\s*["']stylesheet["'][^>]*\\bhref\\s*=\\s*["']([^"']*${escaped}[^"']*)["'][^>]*>|` +
    `<link\\b[^>]*\\bhref\\s*=\\s*["']([^"']*${escaped}[^"']*)["'][^>]*\\brel\\s*=\\s*["']stylesheet["'][^>]*>`,
    "gi"
  );

  const jsUrls: string[] = [];
  for (const m of html.matchAll(jsUrlRe)) jsUrls.push(m[1]);
  const cssUrls: string[] = [];
  for (const m of html.matchAll(cssUrlRe)) cssUrls.push(m[1] ?? m[2]);

  const [jsContents, cssContents] = await Promise.all([
    Promise.all(jsUrls.map(fetchText)),
    Promise.all(cssUrls.map(fetchText)),
  ]);

  const jsFiles = new Map(jsUrls.map((u, i) => [u, jsContents[i]]));
  const cssFiles = new Map(cssUrls.map((u, i) => [u, cssContents[i]]));
  return buildResult(jsFiles, cssFiles, visibleTextChars);
}

// ── Playwright-based analysis ──────────────────────────────────────────────

async function analyzeWithPlaywright(
  pageUrl: string,
  visibleTextChars: number,
  jsDomain: string
): Promise<JsAnalysisResult> {
  const isMobile = pageUrl.includes("m.indiamart.com");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: isMobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ...(isMobile ? { viewport: { width: 390, height: 844 } } : {}),
  });
  const page = await context.newPage();

  const pending: Promise<void>[] = [];
  const jsFiles = new Map<string, string>();
  const cssFiles = new Map<string, string>();

  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes(jsDomain)) return;
    const ct = response.headers()["content-type"] ?? "";
    if (ct.includes("javascript") || /\.js(\?|$)/i.test(url)) {
      pending.push(
        response.text()
          .then((text) => { jsFiles.set(url, text); })
          .catch(() => {})
      );
    } else if (ct.includes("css") || /\.css(\?|$)/i.test(url)) {
      pending.push(
        response.text()
          .then((text) => { cssFiles.set(url, text); })
          .catch(() => {})
      );
    }
  });

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
    } catch {
      // networkidle timed out — proceed with what we have
    }
  } finally {
    await Promise.allSettled(pending);
    await browser.close();
  }

  return buildResult(jsFiles, cssFiles, visibleTextChars);
}

// ── shared result builder ──────────────────────────────────────────────────

function buildResult(
  jsFiles: Map<string, string>,
  cssFiles: Map<string, string>,
  visibleTextChars: number
): JsAnalysisResult {
  let jsChars = 0;
  let jsCharsApp = 0;
  let jsFilesPackage = 0;

  for (const [url, content] of jsFiles) {
    jsChars += content.length;
    if (classifyJs(url, content) === "package") {
      jsFilesPackage++;
    } else {
      // Subtract any embedded vendor sections from the app char count
      const vendorWithin = estimateVendorCharsWithin(content);
      jsCharsApp += Math.max(0, content.length - vendorWithin);
    }
  }

  let cssCharsExt = 0;
  let cssCharsExtApp = 0;
  let cssExtPackage = 0;

  for (const [url, content] of cssFiles) {
    cssCharsExt += content.length;
    if (classifyCss(url, content) === "package") {
      cssExtPackage++;
    } else {
      cssCharsExtApp += content.length;
    }
  }

  const denom = Math.max(visibleTextChars, 1);
  return {
    jsChars,
    jsCharsApp,
    jsFilesTotal: jsFiles.size,
    jsFilesPackage,
    jsToTextRatio:    Math.round((jsChars    / denom) * 100) / 100,
    jsToTextRatioApp: Math.round((jsCharsApp / denom) * 100) / 100,
    cssCharsExt,
    cssCharsExtApp,
    cssExtCount: cssFiles.size,
    cssExtPackage,
  };
}

// ── public entry ───────────────────────────────────────────────────────────

/** Analyse imimg.com JS + CSS files: tries Playwright first, falls back to HTML-only fetch. */
export async function analyzeJsFiles(
  pageUrl: string,
  html: string,
  visibleTextChars: number,
  jsDomain = "imimg.com"
): Promise<JsAnalysisResult> {
  try {
    return await analyzeWithPlaywright(pageUrl, visibleTextChars, jsDomain);
  } catch (e) {
    console.warn("[resource-analyzer] Playwright failed, falling back to HTML fetch:", (e as Error).message);
    return analyzeFromHtml(html, visibleTextChars, jsDomain);
  }
}
