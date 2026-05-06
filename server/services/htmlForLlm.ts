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

/** Default per-call payload budget. Picked to stay well under upstream upload-stream timeouts. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 250 * 1024;

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
 * boundaries; oversize landmarks are hard-sliced as a last resort.
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
      chunks.push(
        sliceUtf8(headChunk, maxChunkBytes) + "\n<!-- audit-truncated -->\n"
      );
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
      let remaining = p;
      const tail = "\n<!-- chunk:body-part -->";
      const sliceBudget = Math.max(1, maxChunkBytes - bytes(tail));
      while (bytes(remaining) > 0) {
        const slice = sliceUtf8(remaining, sliceBudget);
        if (slice.length === 0) break;
        chunks.push(slice + tail);
        remaining = remaining.slice(slice.length);
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
