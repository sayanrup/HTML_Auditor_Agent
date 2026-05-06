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
