import { chromium } from "playwright";

export type UnusedEntry = {
  url: string;
  totalChars: number;
  unusedChars: number;
  unusedPct: number;
};

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
  /** Per-file unused JS breakdown from Playwright coverage (empty when coverage unavailable). */
  unusedJs: UnusedEntry[];
  /** Per-file unused CSS breakdown from Playwright coverage (empty when coverage unavailable). */
  unusedCss: UnusedEntry[];
  // ── CSS source-hierarchy metrics (Playwright only; 0 in HTML-fallback) ──
  /** Chars inside <style> blocks injected by JS after DOMContentLoaded. */
  cssJsInjectedChars: number;
  /** Count of JS-injected <style> blocks. */
  cssJsInjectedCount: number;
  /** DOM elements that carry a style="" attribute. */
  inlineStyleCount: number;
  /** Total chars across all style="" attribute values. */
  inlineStyleChars: number;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  return buildResult(jsFiles, cssFiles, [], [], visibleTextChars, jsDomain);
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

  // Start coverage before any navigation so all resources are captured
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.coverage.startCSSCoverage({ resetOnNavigation: false });

  // Track <style> tags injected by JavaScript after the initial HTML parse.
  // The script snapshots styles present at DOMContentLoaded (= from HTML) then
  // watches for any new <style> nodes added by JS code after that point.
  await page.addInitScript(`(function(){
    window.__jsInjectedStyles={chars:0,count:0};
    window.addEventListener('DOMContentLoaded',function(){
      var initial=new Set(Array.from(document.querySelectorAll('style')));
      new MutationObserver(function(muts){
        for(var i=0;i<muts.length;i++){
          var added=muts[i].addedNodes;
          for(var j=0;j<added.length;j++){
            var n=added[j];
            if(n.nodeName==='STYLE'&&!initial.has(n)){
              window.__jsInjectedStyles.chars+=(n.textContent||'').length;
              window.__jsInjectedStyles.count++;
            }
          }
        }
      }).observe(document.documentElement,{childList:true,subtree:true});
    },{once:true});
  })();`);

  let jsStyleInfo  = { chars: 0, count: 0 };
  let inlineInfo   = { count: 0, chars: 0 };

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

  // Playwright JS coverage uses V8 format; CSS uses simple {text, ranges}
  type RawJsCovEntry = {
    url: string; source?: string;
    functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>;
  };
  type RawCssCovEntry = { url: string; text: string; ranges: Array<{ start: number; end: number }> };

  let rawJsCov: RawJsCovEntry[] = [];
  let rawCssCov: RawCssCovEntry[] = [];

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
    } catch {
      // networkidle timed out — proceed with what we have
    }

    // ── Post-load interactions to improve CSS coverage accuracy ───────────
    // 1. Scroll through the full page in steps.
    //    This triggers lazy-loaded content, intersection observers,
    //    scroll-driven animations, and sticky/fixed-element transitions —
    //    all of which add CSS rules to the "used" pool.
    try {
      const bodyH = await page.evaluate(() => document.body.scrollHeight);
      const viewH = page.viewportSize()?.height ?? 800;
      const steps = Math.min(20, Math.max(4, Math.ceil(bodyH / (viewH * 0.75))));
      for (let i = 1; i <= steps; i++) {
        await page.evaluate((y: number) => window.scrollTo(0, y), Math.round((bodyH / steps) * i));
        await sleep(120);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(200);
    } catch { /* scroll pass failed — continue */ }

    // 2. Mouse-hover over navigation and interactive elements to fire
    //    :hover / :focus-within CSS rules without risking navigation.
    try {
      const hoverSel = [
        "nav a", "nav li", "nav > ul > li", "nav button",
        "header a", "header li", "header button",
        "[class*='nav-link']", "[class*='navlink']", "[class*='navbar']",
        "[class*='menu-item']", "[class*='dropdown']",
        "button:not([disabled])", "[role='menuitem']",
      ].join(",");
      const els = await page.$$(hoverSel);
      const vp = page.viewportSize() ?? { width: 1280, height: 800 };
      for (const el of els.slice(0, 40)) {
        try {
          const box = await el.boundingBox();
          // Only hover elements currently visible in the viewport
          if (box && box.width > 0 && box.height > 0 && box.y >= 0 && box.y + box.height <= vp.height) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 1 });
            await sleep(25);
          }
        } catch { /* individual element failed — skip */ }
      }
    } catch { /* hover pass failed — continue */ }

    // 3. Click dropdown/tab/accordion triggers to expose open-state CSS.
    //    Restricted to non-anchor elements to minimise navigation risk.
    try {
      const clickSel = [
        "button[aria-haspopup]",
        "button[aria-expanded='false']",
        "[role='button'][aria-haspopup]",
        "[data-toggle='dropdown']:not(a)",
        "[data-toggle='collapse']:not(a)",
        "[class*='hamburger']:not(a)",
        "[class*='menu-toggle']:not(a)",
        "[class*='accordion-btn']:not(a)",
      ].join(",");
      const startUrl = page.url();
      const triggers = await page.$$(clickSel);
      for (const el of triggers.slice(0, 10)) {
        try {
          const box = await el.boundingBox();
          if (!box || box.width === 0 || box.height === 0) continue;
          await el.click({ timeout: 600 });
          await sleep(200);
          if (page.url() !== startUrl) { await page.goBack({ timeout: 8_000 }); break; }
        } catch { /* skip unclickable element */ }
      }
    } catch { /* click pass failed — continue */ }

    // 4. Wait for CSS transitions / animations triggered by the interactions.
    await sleep(400);
    // ──────────────────────────────────────────────────────────────────────

    // Stop coverage while page is still open (before browser close)
    [rawJsCov, rawCssCov] = await Promise.all([
      page.coverage.stopJSCoverage() as unknown as Promise<RawJsCovEntry[]>,
      page.coverage.stopCSSCoverage() as unknown as Promise<RawCssCovEntry[]>,
    ]);

    // Collect CSS source-hierarchy metrics before closing the browser
    try {
      [jsStyleInfo, inlineInfo] = await Promise.all([
        page.evaluate(() => {
          const t = (window as any).__jsInjectedStyles;
          return { chars: +(t && t.chars) || 0, count: +(t && t.count) || 0 };
        }),
        page.evaluate(() => {
          const els = Array.from(document.querySelectorAll("[style]")) as HTMLElement[];
          return {
            count: els.length,
            chars: els.reduce((s, el) => s + (el.getAttribute("style") || "").length, 0),
          };
        }),
      ]);
    } catch { /* non-critical — defaults remain 0 */ }
  } finally {
    await Promise.allSettled(pending);
    await browser.close();
  }

  return buildResult(jsFiles, cssFiles, rawJsCov, rawCssCov, visibleTextChars, jsDomain, {
    cssJsInjectedChars: jsStyleInfo.chars,
    cssJsInjectedCount: jsStyleInfo.count,
    inlineStyleCount:   inlineInfo.count,
    inlineStyleChars:   inlineInfo.chars,
  });
}

// ── CSS-in-JS cross-reference helpers ─────────────────────────────────────

/**
 * Scan JS source and return CSS class names that are *explicitly manipulated*
 * at runtime via classList / className / setAttribute / jQuery / React className.
 * These classes are definitively "used" even if Chrome Coverage never saw them.
 */
function extractDynamicJsClasses(jsContent: string): Set<string> {
  const classes = new Set<string>();

  const push = (raw: string) => {
    for (const part of raw.split(/[\s,]+/)) {
      const t = part.trim();
      // Require ≥4 chars and a valid identifier (no BEM/utility too-short noise)
      if (t.length >= 4 && /^-?[a-zA-Z][a-zA-Z0-9_-]*$/.test(t)) classes.add(t);
    }
  };

  // classList.add / remove / toggle / replace / contains('class-name')
  for (const m of jsContent.matchAll(
    /classList\s*\.\s*(?:add|remove|toggle|replace|contains)\s*\(\s*(['"`])([^'"`\n]+)\1/gi
  )) push(m[2]);

  // element.className = 'cls'  or  += 'cls'
  for (const m of jsContent.matchAll(/\.className\s*\+?=\s*(['"`])([^'"`\n]+)\1/g)) push(m[2]);

  // setAttribute('class', 'cls')  or  setAttribute('className', 'cls')
  for (const m of jsContent.matchAll(
    /setAttribute\s*\(\s*['"`]class(?:Name)?['"`]\s*,\s*(['"`])([^'"`\n]+)\1/gi
  )) push(m[2]);

  // jQuery: .addClass / .removeClass / .toggleClass('cls')
  for (const m of jsContent.matchAll(
    /\.(?:addClass|removeClass|toggleClass)\s*\(\s*(['"`])([^'"`\n]+)\1/gi
  )) push(m[2]);

  // React / JSX: className="cls cls2"  (static string only)
  for (const m of jsContent.matchAll(/\bclassName\s*=\s*(['"`])([^'"`\n]+)\1/g)) push(m[2]);

  return classes;
}

/**
 * Pull every unique CSS class name (≥4 chars) out of a CSS text's selectors.
 * We read the whole text (not just rules) because we want a full picture of
 * what class names are *defined* in this file.
 */
function extractCssClassNames(cssText: string): string[] {
  const seen = new Set<string>();
  for (const m of cssText.matchAll(/\.(-?[a-zA-Z][a-zA-Z0-9_-]*)/g)) {
    if (m[1].length >= 4) seen.add(m[1]);
  }
  return [...seen];
}

// ── shared result builder ──────────────────────────────────────────────────

type RawJsCov = {
  url: string; source?: string;
  functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>;
};
type RawCssCov = { url: string; text: string; ranges: Array<{ start: number; end: number }> };

/**
 * Count chars inside CSS at-rules that Chrome Coverage never marks as "used"
 * even when they are actively applied:
 *   • @keyframes / @-webkit-keyframes  — animation definitions
 *   • @font-face                        — custom font declarations
 *   • @charset / @namespace / @layer declarations (no block, just statements)
 *
 * Subtracting these from "unused" prevents false-positive 100% unused reports
 * for CSS files that are primarily animation/font sheets.
 */
function countUntrackedAtRuleChars(cssText: string): number {
  let total = 0;

  // @keyframes and vendor-prefixed variants — contain nested {} blocks
  // Use brace counting (not regex) to handle nested {} inside keyframe stops.
  for (const m of cssText.matchAll(/@(?:-webkit-|-moz-|-o-)?keyframes\s+\S+\s*\{/gi)) {
    const start = m.index!;
    // m[0] ends with '{', so depth = 1 and we scan from the char after it
    let depth = 1;
    let i = start + m[0].length;
    while (i < cssText.length) {
      if (cssText[i] === "{") depth++;
      else if (cssText[i] === "}") {
        depth--;
        if (depth === 0) { total += i - start + 1; break; }
      }
      i++;
    }
  }

  // @font-face { ... } — single brace level, no nesting
  for (const m of cssText.matchAll(/@font-face\s*\{[^}]*\}/gi)) {
    total += m[0].length;
  }

  // @charset "..." ; and @namespace ... ; — statement form (no block)
  for (const m of cssText.matchAll(/@(?:charset|namespace)\b[^;]*;/gi)) {
    total += m[0].length;
  }

  return Math.min(total, cssText.length);
}

/** Merge overlapping used ranges and return total covered chars. */
function mergeUsed(ranges: Array<{ start: number; end: number }>): number {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let used = 0; let lastEnd = -1;
  for (const r of sorted) {
    const s = Math.max(r.start, lastEnd);
    if (s < r.end) { used += r.end - s; lastEnd = r.end; }
  }
  return used;
}

function buildResult(
  jsFiles: Map<string, string>,
  cssFiles: Map<string, string>,
  jsCoverage: RawJsCov[],
  cssCoverage: RawCssCov[],
  visibleTextChars: number,
  jsDomain: string,
  playwrightExtra?: {
    cssJsInjectedChars: number;
    cssJsInjectedCount: number;
    inlineStyleCount: number;
    inlineStyleChars: number;
  }
): JsAnalysisResult {
  let jsChars = 0;
  let jsCharsApp = 0;
  let jsFilesPackage = 0;

  for (const [url, content] of jsFiles) {
    jsChars += content.length;
    if (classifyJs(url, content) === "package") {
      jsFilesPackage++;
    } else {
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

  // JS coverage: V8 format — collect ranges with count > 0 across all functions
  const unusedJs: UnusedEntry[] = [];
  for (const entry of jsCoverage) {
    if (!entry.url.includes(jsDomain)) continue;
    const totalChars = (entry.source ?? "").length;
    if (totalChars === 0) continue;
    const usedRanges: Array<{ start: number; end: number }> = [];
    for (const fn of entry.functions) {
      for (const r of fn.ranges) {
        if (r.count > 0) usedRanges.push({ start: r.startOffset, end: r.endOffset });
      }
    }
    const usedChars = mergeUsed(usedRanges);
    const unusedChars = totalChars - usedChars;
    const unusedPct = Math.round((unusedChars / totalChars) * 100);
    unusedJs.push({ url: entry.url, totalChars, unusedChars, unusedPct });
  }
  unusedJs.sort((a, b) => b.unusedChars - a.unusedChars);

  // ── Build JS class-reference index for CSS cross-check ───────────────────
  // Chrome Coverage only sees CSS that matched a DOM element *during our session*.
  // Classes toggled at runtime by JS (dropdowns, modals, active states, etc.)
  // never appear in coverage even though the CSS is being used.
  //
  // Two tiers of evidence:
  //   • dynamicJsClasses  — explicit DOM API calls (classList.add, className=, …)  weight 1.0
  //   • jsAnyStringClasses — any quoted string ≥4 chars that looks like a class name  weight 0.30
  const dynamicJsClasses   = new Set<string>();
  const jsAnyStringClasses = new Set<string>();
  for (const [, content] of jsFiles) {
    for (const cls of extractDynamicJsClasses(content)) dynamicJsClasses.add(cls);
    for (const m of content.matchAll(/['"`](-?[a-zA-Z][a-zA-Z0-9_-]{3,})['"`]/g))
      jsAnyStringClasses.add(m[1]);
  }

  // CSS coverage: simple {text, ranges} — ranges are the USED portions.
  // Three layers of correction applied before reporting "unused":
  //   1. @keyframes / @font-face blocks  — Coverage never emits ranges for these
  //   2. Dynamic JS class references      — classes manipulated at runtime by JS
  //   3. Quoted JS string mentions        — classes referenced in JS string literals
  const unusedCss: UnusedEntry[] = [];
  for (const entry of cssCoverage) {
    if (!entry.url.includes(jsDomain)) continue;
    const totalChars = entry.text.length;
    if (totalChars === 0) continue;

    const usedBySelector = mergeUsed(entry.ranges);
    const usedByAtRules  = countUntrackedAtRuleChars(entry.text);

    // Remaining chars that coverage considers unused (after at-rule credit)
    const rawUnused = Math.max(0, totalChars - usedBySelector - usedByAtRules);

    // Cross-reference CSS selector class names with JS class manipulation
    let dynamicCredit = 0;
    if (rawUnused > 0) {
      const cssClasses = extractCssClassNames(entry.text);
      if (cssClasses.length > 0) {
        const dynMatches = cssClasses.filter(c => dynamicJsClasses.has(c)).length;
        const strMatches = cssClasses.filter(c =>
          jsAnyStringClasses.has(c) && !dynamicJsClasses.has(c)
        ).length;
        // Credit fraction: strong evidence counts full weight, string mentions 30%
        const creditFraction = Math.min(
          0.85,
          dynMatches / cssClasses.length + (strMatches / cssClasses.length) * 0.30
        );
        dynamicCredit = Math.round(rawUnused * creditFraction);
      }
    }

    const effectiveUsed = Math.min(totalChars, usedBySelector + usedByAtRules + dynamicCredit);
    const unusedChars   = totalChars - effectiveUsed;
    const unusedPct     = Math.round((unusedChars / totalChars) * 100);
    unusedCss.push({ url: entry.url, totalChars, unusedChars, unusedPct });
  }
  unusedCss.sort((a, b) => b.unusedChars - a.unusedChars);

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
    unusedJs,
    unusedCss,
    cssJsInjectedChars: playwrightExtra?.cssJsInjectedChars ?? 0,
    cssJsInjectedCount: playwrightExtra?.cssJsInjectedCount ?? 0,
    inlineStyleCount:   playwrightExtra?.inlineStyleCount   ?? 0,
    inlineStyleChars:   playwrightExtra?.inlineStyleChars   ?? 0,
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
