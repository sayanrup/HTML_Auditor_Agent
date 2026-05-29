/**
 * Prepare HTML for sending to an LLM gateway.
 *
 * Two reasons we strip + cap + chunk before posting:
 *  1. Upstream gateways (e.g. imllm.intermesh.net) enforce an upload-side timeout;
 *     multi-MB request bodies routinely produce "upload stream timeout" errors.
 *  2. Inline scripts / JSON-LD / state blobs / `<style>` blocks are not useful for
 *     audit rubrics (LLM-friendliness, semantic HTML, SEO, accessibility, W3C) —
 *     they only burn tokens and slow the gateway.
 *
 * `prepareHtmlForLlm`  → strip + hard-cap (single-call use cases).
 * `chunkHtmlForLlm`    → strip then split at landmark boundaries when the prepared
 *                         HTML still exceeds the per-call budget. The first chunk
 *                         always contains `<head>...</head>` so SEO/meta findings
 *                         have a focused pass.
 */

import {
  stripCssMarkersFromMarkup,
  stripNonContentRegions,
} from "./htmlTextMetrics";

/** Default per-call payload budget. We size this for the WORST case: a chunk
 *  that needs to fit alongside ~6–8 KB of prompt overhead (schema, scoring,
 *  GT, rubric, caveats) inside the gateway's per-request budget. 30 KB gives
 *  ~38 KB total request, keeping concurrent uploads well under the intermesh
 *  gateway's inbound-stream timeout. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 30 * 1024;

const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Tags that are common enough to be treated as structural sub-boundaries when
 *  drilling into oversize landmarks. */
const SUB_LANDMARK_TAGS = new Set([
  "section",
  "article",
  "div",
  "ul",
  "ol",
  "li",
  "table",
  "form",
  "fieldset",
  "details",
  "address",
  "blockquote",
  "pre",
  "p",
]);

export type LlmHtmlPrep = {
  prepared: string;
  originalBytes: number;
  preparedBytes: number;
  truncated: boolean;
};

export type LlmHtmlChunks = {
  chunks: string[];
  originalBytes: number;
  preparedBytes: number;
  totalChunkBytes: number;
  chunked: boolean;
};

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * UTF-8 safe byte slice. Trims trailing replacement chars created by cutting in
 * the middle of a multibyte sequence so we don't ship a stray U+FFFD.
 */
function sliceUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (bytes(s) <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8");
  return buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/g, "");
}

/**
 * Find positions in `s` where a TOP-LEVEL sibling element begins (i.e. open-tag
 * positions where the cumulative tag depth is 0). Used to split an oversize
 * landmark into chunks at structural boundaries instead of mid-element bytes.
 */
function topLevelSiblingPositions(s: string): number[] {
  const positions: number[] = [];
  let depth = 0;
  let firstTagSeen = false;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const isClose = m[1] === "/";
    const selfClose = m[3] === "/";
    const name = m[2]!.toLowerCase();
    if (selfClose || HTML_VOID_ELEMENTS.has(name)) {
      if (depth === 0 && firstTagSeen) positions.push(m.index);
      firstTagSeen = true;
      continue;
    }
    if (isClose) {
      if (depth > 0) depth--;
    } else {
      if (depth === 0 && firstTagSeen) positions.push(m.index);
      firstTagSeen = true;
      depth++;
    }
  }
  return positions;
}

/**
 * Peel one outermost wrapper element if `s` consists of a single top-level
 * element. Returns the inner HTML so the recursive splitter can drill inside it.
 */
function peelOutermost(
  s: string
): { tag: string; open: string; inner: string; close: string } | null {
  const openMatch = s.match(/^\s*<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/);
  if (!openMatch) return null;
  const tag = openMatch[1]!.toLowerCase();
  if (HTML_VOID_ELEMENTS.has(tag)) return null;
  const closeRe = new RegExp(`</\\s*${tag}\\s*>\\s*$`, "i");
  const closeMatch = s.match(closeRe);
  if (!closeMatch) return null;
  const openEnd = openMatch.index! + openMatch[0].length;
  const closeStart = s.lastIndexOf(closeMatch[0]);
  if (closeStart < openEnd) return null;
  return {
    tag,
    open: s.slice(0, openEnd),
    inner: s.slice(openEnd, closeStart),
    close: s.slice(closeStart),
  };
}

/**
 * Recursively split an oversize HTML block into pieces ≤ `maxBytes`:
 *  1. Try splitting at top-level sibling boundaries.
 *  2. If the block is a single element, peel its wrapper and recurse on the inner HTML.
 *  3. Last resort, hard byte-slice.
 *
 * Output may contain partial HTML fragments — that's fine for audit prompts.
 */
function splitOversizeBlock(s: string, maxBytes: number): string[] {
  if (bytes(s) <= maxBytes) return [s];

  const positions = topLevelSiblingPositions(s);
  if (positions.length > 0) {
    const parts: string[] = [];
    let prev = 0;
    for (const p of positions) {
      if (p > prev) parts.push(s.slice(prev, p));
      prev = p;
    }
    if (prev < s.length) parts.push(s.slice(prev));
    if (parts.length > 1) {
      return packPartsIntoChunks(parts, maxBytes);
    }
  }

  const peeled = peelOutermost(s);
  if (peeled && bytes(peeled.inner) > 0) {
    const innerChunks = splitOversizeBlock(peeled.inner, maxBytes);
    if (innerChunks.length > 0) {
      const out: string[] = [];
      out.push(`${peeled.open}${innerChunks[0]}`);
      for (let i = 1; i < innerChunks.length - 1; i++) {
        out.push(innerChunks[i]!);
      }
      if (innerChunks.length > 1) {
        out.push(`${innerChunks[innerChunks.length - 1]}${peeled.close}`);
      } else {
        out[out.length - 1] = `${out[out.length - 1]}${peeled.close}`;
      }
      // Any element that's still oversize after peeling? Recurse once more.
      const final: string[] = [];
      for (const c of out) {
        if (bytes(c) > maxBytes) {
          const sub = hardByteSlice(c, maxBytes);
          final.push(...sub);
        } else {
          final.push(c);
        }
      }
      return final;
    }
  }

  return hardByteSlice(s, maxBytes);
}

function packPartsIntoChunks(parts: string[], maxBytes: number): string[] {
  const out: string[] = [];
  let buffer = "";
  let bufferBytes = 0;
  const flush = () => {
    if (buffer.trim().length === 0) return;
    out.push(buffer);
    buffer = "";
    bufferBytes = 0;
  };
  for (const p of parts) {
    const pBytes = bytes(p);
    if (pBytes > maxBytes) {
      flush();
      out.push(...splitOversizeBlock(p, maxBytes));
      continue;
    }
    if (bufferBytes + pBytes > maxBytes) flush();
    buffer += p;
    bufferBytes += pBytes;
  }
  flush();
  return out;
}

function hardByteSlice(s: string, maxBytes: number): string[] {
  const out: string[] = [];
  let remaining = s;
  while (bytes(remaining) > 0) {
    const slice = sliceUtf8(remaining, maxBytes);
    if (slice.length === 0) break;
    out.push(slice);
    remaining = remaining.slice(slice.length);
  }
  return out;
}

// Silence unused-warning for SUB_LANDMARK_TAGS while keeping the list available
// for future heuristics; depth-tracking already gives the right boundaries.
void SUB_LANDMARK_TAGS;

/** Strip script/style/JSON/widget/CSS markers; collapse runs of whitespace. */
export function stripHtmlForLlm(html: string): string {
  const stripped = stripCssMarkersFromMarkup(stripNonContentRegions(html));
  return stripped
    .replace(/[\t\f\v]+/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Single-call prep: strip then hard-cap. If still too big, keep `<head>...</head>`
 * intact (charset/title/meta/lang/canonical/og live there) and truncate the body
 * region with a `<!-- audit-truncated -->` marker.
 */
export function prepareHtmlForLlm(
  html: string,
  maxBytes: number = DEFAULT_MAX_PAYLOAD_BYTES
): LlmHtmlPrep {
  const originalBytes = bytes(html);
  const stripped = stripHtmlForLlm(html);
  if (bytes(stripped) <= maxBytes) {
    return {
      prepared: stripped,
      originalBytes,
      preparedBytes: bytes(stripped),
      truncated: false,
    };
  }

  const headMatch = stripped.match(/<head[\s\S]*?<\/head>/i);
  const headIndex = headMatch?.index ?? -1;
  const head = headMatch?.[0] ?? "";
  const before = headIndex >= 0 ? stripped.slice(0, headIndex) : "";
  const afterHead =
    headIndex >= 0 ? stripped.slice(headIndex + head.length) : stripped;

  const marker = "\n<!-- audit-truncated -->\n";
  const fixedBytes = bytes(before) + bytes(head) + bytes(marker);
  const budgetForBody = Math.max(0, maxBytes - fixedBytes);
  const bodyTrunc = sliceUtf8(afterHead, budgetForBody);
  const prepared = `${before}${head}${bodyTrunc}${marker}`;
  return {
    prepared,
    originalBytes,
    preparedBytes: bytes(prepared),
    truncated: true,
  };
}

/**
 * Multi-call prep: strip then split at landmark boundaries. Chunk 1 always covers
 * everything up to and including `<head>...</head>` so SEO/meta issues land in
 * one focused pass. The body is split on `<header|nav|main|section|article|aside|footer>`
 * boundaries; oversize landmarks are recursively split at top-level sibling
 * boundaries (and peeled if they are a single wrapper element) before falling
 * back to a hard byte slice.
 */
export function chunkHtmlForLlm(
  html: string,
  maxChunkBytes: number = DEFAULT_MAX_PAYLOAD_BYTES
): LlmHtmlChunks {
  const originalBytes = bytes(html);
  const stripped = stripHtmlForLlm(html);
  const preparedBytes = bytes(stripped);
  if (preparedBytes <= maxChunkBytes) {
    return {
      chunks: [stripped],
      originalBytes,
      preparedBytes,
      totalChunkBytes: preparedBytes,
      chunked: false,
    };
  }

  const headMatch = stripped.match(/<head[\s\S]*?<\/head>/i);
  const headIndex = headMatch?.index ?? -1;
  const head = headMatch?.[0] ?? "";
  const before = headIndex >= 0 ? stripped.slice(0, headIndex) : "";
  const afterHead =
    headIndex >= 0 ? stripped.slice(headIndex + head.length) : stripped;

  const chunks: string[] = [];
  if (head) {
    const headChunk = `${before}${head}\n<!-- chunk:head -->`;
    if (bytes(headChunk) <= maxChunkBytes) {
      chunks.push(headChunk);
    } else {
      // <head> alone is bigger than budget — recursively split it too.
      for (const sub of splitOversizeBlock(headChunk, maxChunkBytes)) {
        chunks.push(sub + "\n<!-- chunk:head-part -->");
      }
    }
  }

  const landmarkSplitter =
    /(?=<(?:header|nav|main|section|article|aside|footer)[\s>])/i;
  const parts = afterHead
    .split(landmarkSplitter)
    .map((p) => p)
    .filter((p) => p.trim().length > 0);

  let buffer = "";
  let bufferBytes = 0;
  const flush = () => {
    if (buffer.trim().length === 0) return;
    chunks.push(buffer);
    buffer = "";
    bufferBytes = 0;
  };

  for (const p of parts) {
    const pBytes = bytes(p);
    if (pBytes > maxChunkBytes) {
      flush();
      const subs = splitOversizeBlock(p, maxChunkBytes);
      for (const sub of subs) {
        chunks.push(sub + "\n<!-- chunk:body-part -->");
      }
      continue;
    }
    if (bufferBytes + pBytes > maxChunkBytes) flush();
    buffer += p;
    bufferBytes += pBytes;
  }
  flush();

  if (chunks.length === 0) chunks.push(stripped);
  const totalChunkBytes = chunks.reduce((a, c) => a + bytes(c), 0);
  return {
    chunks,
    originalBytes,
    preparedBytes,
    totalChunkBytes,
    chunked: chunks.length > 1,
  };
}
