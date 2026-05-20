/**
 * HTML↔text metrics (no browser DOM).
 * - **Ratio numerator:** UTF-8 size of HTML **including tags**, after removing JS, JSON-like
 *   payloads, embedded widgets, `<style>`, stylesheet `<link>`s, and inline `style=""`.
 * - **Ratio denominator:** visible text only (tags stripped, same exclusions).
 */

export function stripNonContentRegions(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<textarea\b[\s\S]*?<\/textarea>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<object\b[\s\S]*?<\/object>/gi, " ")
    .replace(/<embed\b[^>]*>/gi, " ");
}

/** Remove CSS hooks from markup-only string (external + inline CSS references). */
export function stripCssMarkersFromMarkup(s: string): string {
  return s
    .replace(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi, " ")
    .replace(/<link\b[^>]*\bas\s*=\s*["']style["'][^>]*>/gi, " ")
    .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, " ");
}

/** Index of closing `}` that matches `{` at openIdx, respecting strings and escapes. */
function indexOfMatchingBrace(s: string, openIdx: number): number {
  if (s[openIdx] !== "{") return -1;
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let esc = false;
  for (let j = openIdx; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function looksLikeJsonPayload(block: string): boolean {
  const t = block.trim();
  if (t.length < 24 || !t.startsWith("{")) return false;
  if (/"(?:@context|@type|@graph|@id)"\s*:/.test(t)) return true;
  if (/"__\w+"\s*:/.test(t)) return true;
  const colons = (t.match(/:/g) || []).length;
  const quotes = (t.match(/"/g) || []).length;
  if (quotes >= 6 && colons >= 3) return true;
  return false;
}

/** Remove JSON / JSON-LD-like `{...}` blobs from plain text (e.g. inlined or leaked payloads). */
function stripJsonLikeRuns(text: string): string {
  let s = text;
  let guard = 0;
  while (guard++ < 4000) {
    const objStart = s.search(/\{\s*"/);
    if (objStart < 0) break;
    const end = indexOfMatchingBrace(s, objStart);
    if (end < 0) {
      s = s.slice(0, objStart) + " " + s.slice(objStart + 1);
      continue;
    }
    const block = s.slice(objStart, end + 1);
    if (looksLikeJsonPayload(block)) {
      s = s.slice(0, objStart) + " " + s.slice(end + 1);
    } else {
      s = s.slice(0, objStart) + " " + s.slice(objStart + 1);
    }
  }
  return s;
}

function decodeBasicEntities(s: string): string {
  let t = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff
        ? String.fromCodePoint(n)
        : " ";
    });
  t = t.replace(/&#(\d{1,7});/g, (_, dec) => {
    const n = parseInt(dec, 10);
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff
      ? String.fromCodePoint(n)
      : " ";
  });
  return t;
}

export type HtmlTextMetrics = {
  /** UTF-8 byte length of the full raw document (wire size). */
  htmlBytes: number;
  /** UTF-8 bytes of HTML **with tags kept**, after JS/script/style/JSON/widget/CSS ref stripping. */
  markupHtmlBytes: number;
  /** Human-facing text length: tags stripped; scripts/JSON/etc. excluded as for markup. */
  visibleTextChars: number;
  /** `markupHtmlBytes / visibleTextChars` — markup+structure weight per visible character. */
  htmlToTextRatio: number;
};

export type HtmlSegmentRatio = {
  tagName: string;
  /** Raw HTML snippet (≤ 500 chars) of the segment. */
  snippet: string;
  ratio: number;
  markupBytes: number;
  visibleChars: number;
};

const BLOCK_TAGS_FOR_RATIO = [
  "div", "section", "article", "nav", "header", "footer", "aside", "main",
  "ul", "ol", "table",
];

/**
 * Find the top N non-overlapping HTML block segments with the highest HTML-to-text ratio.
 * Segments under 300 bytes or over 60 KB are skipped to focus on meaningful structural bloat.
 */
export function findTopBloatedSegments(html: string, topN = 5): HtmlSegmentRatio[] {
  const candidates: Array<HtmlSegmentRatio & { startIdx: number; endIdx: number }> = [];
  const MAX_CANDIDATES = 80;

  for (const tag of BLOCK_TAGS_FOR_RATIO) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, "gi");
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(html)) !== null) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const startIdx = m.index;
      const innerRe = new RegExp(`<(\\/?)${tag}\\b[^>]*>`, "gi");
      innerRe.lastIndex = m.index + m[0].length;
      let depth = 1;
      let nm: RegExpExecArray | null;
      while ((nm = innerRe.exec(html)) !== null) {
        if (nm[1] === "/") {
          depth--;
          if (depth === 0) {
            const endIdx = nm.index + nm[0].length;
            const segLen = endIdx - startIdx;
            if (segLen >= 300 && segLen <= 60_000) {
              const segHtml = html.slice(startIdx, endIdx);
              const stripped = stripNonContentRegions(segHtml);
              const markupHtml = stripCssMarkersFromMarkup(stripped);
              const markupBytes = Buffer.byteLength(markupHtml, "utf8");
              let text = stripped.replace(/<[^>]+>/g, " ");
              text = decodeBasicEntities(text);
              text = text.replace(/\s+/g, " ").trim();
              const visibleChars = text.length;
              if (visibleChars >= 5) {
                candidates.push({
                  tagName: tag,
                  snippet: segHtml.slice(0, 500),
                  ratio: Math.round((markupBytes / visibleChars) * 100) / 100,
                  markupBytes,
                  visibleChars,
                  startIdx,
                  endIdx,
                });
              }
            }
            break;
          }
        } else {
          depth++;
        }
      }
    }
  }

  candidates.sort((a, b) => b.ratio - a.ratio);

  const result: HtmlSegmentRatio[] = [];
  const usedRanges: Array<{ start: number; end: number }> = [];
  const seenStructure = new Set<string>();

  for (const c of candidates) {
    // Skip DOM regions that overlap with an already-selected segment.
    const overlaps = usedRanges.some(
      (r) => c.startIdx < r.end && c.endIdx > r.start
    );
    if (overlaps) continue;

    // Skip structurally identical snippets (same tag skeleton, regardless of
    // attribute values or text content) so repeated patterns such as nav items
    // or product cards don't fill all 5 slots with the same structure.
    const structKey = c.snippet
      .replace(/=["'][^"']*["']/g, '=""') // normalise all attr values → ""
      .replace(/>[^<]*</g, "><")          // strip text nodes between tags
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    if (seenStructure.has(structKey)) continue;

    usedRanges.push({ start: c.startIdx, end: c.endIdx });
    seenStructure.add(structKey);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { startIdx: _s, endIdx: _e, ...rest } = c;
    result.push(rest);
    if (result.length >= topN) break;
  }
  return result;
}

export type JsCssMetrics = {
  /** Combined character count of fetched imimg.com CSS files + inline <style> content. */
  cssChars: number;
  /** Count of imimg.com external stylesheet references. */
  cssExtCount: number;
  /** Count of inline <style> blocks. */
  cssInlineCount: number;
  /** cssChars / visibleTextChars */
  cssToTextRatio: number;
};


/**
 * Parse inline CSS and count external stylesheet link tags from jsDomain.
 * External CSS content is fetched later by Playwright (playwrightJsAnalyzer).
 * cssChars here reflects inline <style> chars only.
 */
export async function computeJsCssMetrics(
  html: string,
  visibleTextChars: number,
  jsDomain = "imimg.com"
): Promise<JsCssMetrics> {
  const escapedDomain = jsDomain.replace(/\./g, "\\.");

  // Count external stylesheet link tags from jsDomain (both attribute orders) — no fetch
  const cssUrlRe = new RegExp(
    `<link\\b[^>]*\\brel\\s*=\\s*["']stylesheet["'][^>]*\\bhref\\s*=\\s*["'][^"']*${escapedDomain}[^"']*["'][^>]*>|` +
    `<link\\b[^>]*\\bhref\\s*=\\s*["'][^"']*${escapedDomain}[^"']*["'][^>]*\\brel\\s*=\\s*["']stylesheet["'][^>]*>`,
    "gi"
  );
  let cssExtCount = 0;
  for (const _ of html.matchAll(cssUrlRe)) cssExtCount++;

  // Inline <style> content
  let cssInlineChars = 0;
  let cssInlineCount = 0;
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    cssInlineChars += m[1].length;
    cssInlineCount++;
  }

  const cssChars = cssInlineChars;
  const cssToTextRatio = Math.round((cssChars / Math.max(visibleTextChars, 1)) * 100) / 100;

  return { cssChars, cssExtCount, cssInlineCount, cssToTextRatio };
}

export function computeHtmlTextMetrics(html: string): HtmlTextMetrics {
  const htmlBytes = Buffer.byteLength(html, "utf8");
  const stripped = stripNonContentRegions(html);
  const markupHtml = stripCssMarkersFromMarkup(stripped);
  const markupHtmlBytes = Buffer.byteLength(markupHtml, "utf8");

  let text = stripped;
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeBasicEntities(text);
  text = stripJsonLikeRuns(text);
  text = text.replace(/\s+/g, " ").trim();
  const visibleTextChars = text.length;
  const htmlToTextRatio =
    Math.round((markupHtmlBytes / Math.max(visibleTextChars, 1)) * 100) / 100;
  return { htmlBytes, markupHtmlBytes, visibleTextChars, htmlToTextRatio };
}
