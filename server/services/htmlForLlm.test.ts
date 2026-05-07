import { describe, it, expect } from "vitest";
import {
  prepareHtmlForLlm,
  chunkHtmlForLlm,
  stripHtmlForLlm,
} from "./htmlForLlm";

describe("stripHtmlForLlm", () => {
  it("removes scripts, styles, JSON-LD, inline style and stylesheet links", () => {
    const html = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="/a.css">
      <style>.x{color:red}</style>
      <title>Hello</title>
      <script type="application/ld+json">{"@context":"https://schema.org"}</script>
    </head><body>
      <div style="display:none" class="x">visible text</div>
      <script>var a=1;</script>
    </body></html>`;
    const out = stripHtmlForLlm(html);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<style/i);
    expect(out).not.toMatch(/rel="stylesheet"/i);
    expect(out).not.toMatch(/style\s*=\s*"display:none"/i);
    expect(out).toMatch(/<title>Hello<\/title>/);
    expect(out).toMatch(/visible text/);
  });
});

describe("prepareHtmlForLlm", () => {
  it("returns stripped HTML untouched when under cap", () => {
    const html = "<html><body><p>hi</p></body></html>";
    const r = prepareHtmlForLlm(html, 1024);
    expect(r.truncated).toBe(false);
    expect(r.preparedBytes).toBeLessThanOrEqual(r.originalBytes + 32);
  });

  it("truncates body but keeps head when oversized", () => {
    const head = `<head><title>T</title><meta name="description" content="D"></head>`;
    const body = `<body>${"a".repeat(5000)}<p>tail</p></body>`;
    const html = `<!doctype html><html>${head}${body}</html>`;
    const r = prepareHtmlForLlm(html, 200);
    expect(r.truncated).toBe(true);
    expect(r.prepared).toContain("<title>T</title>");
    expect(r.prepared).toContain("audit-truncated");
    expect(r.preparedBytes).toBeLessThanOrEqual(220);
  });
});

describe("chunkHtmlForLlm", () => {
  it("returns a single chunk when under cap", () => {
    const html =
      "<!doctype html><html><head><title>T</title></head><body><main><p>x</p></main></body></html>";
    const r = chunkHtmlForLlm(html, 4096);
    expect(r.chunks.length).toBe(1);
    expect(r.chunked).toBe(false);
  });

  it("splits at landmark boundaries with head as chunk 1", () => {
    const head = `<head><title>Hello world</title></head>`;
    const main = `<main>${"M".repeat(800)}</main>`;
    const aside = `<aside>${"A".repeat(800)}</aside>`;
    const footer = `<footer>${"F".repeat(800)}</footer>`;
    const html = `<!doctype html><html>${head}<body>${main}${aside}${footer}</body></html>`;
    const r = chunkHtmlForLlm(html, 600);
    expect(r.chunked).toBe(true);
    expect(r.chunks.length).toBeGreaterThanOrEqual(2);
    expect(r.chunks[0]).toContain("<title>Hello world</title>");
    expect(r.chunks[0]).toContain("chunk:head");
    const joined = r.chunks.slice(1).join("\n");
    expect(joined).toMatch(/<main\b/);
    expect(joined).toMatch(/<aside\b/);
    expect(joined).toMatch(/<footer\b/);
  });

  it("hard-slices a single oversize landmark with no inner siblings", () => {
    const huge = `<main>${"X".repeat(5000)}</main>`;
    const html = `<!doctype html><html><head><title>T</title></head><body>${huge}</body></html>`;
    const r = chunkHtmlForLlm(html, 800);
    expect(r.chunked).toBe(true);
    expect(r.chunks.some((c) => c.includes("chunk:body-part"))).toBe(true);
  });

  it("drills into oversize landmarks at sibling boundaries instead of byte-slicing", () => {
    // <main> wraps 5 large sibling <section>s. Each section is small enough on
    // its own; the splitter should drill in and emit them as siblings, NOT
    // hard-slice them mid-content.
    const sections = [1, 2, 3, 4, 5]
      .map(
        (i) => `<section id="s${i}">${"S".repeat(900)}</section>`
      )
      .join("");
    const html = `<!doctype html><html><head><title>T</title></head><body><main>${sections}</main></body></html>`;
    const r = chunkHtmlForLlm(html, 1500);
    expect(r.chunked).toBe(true);

    // Every section id should appear in the joined body chunks (not lost or split mid-attribute).
    const joined = r.chunks.slice(1).join("");
    for (const i of [1, 2, 3, 4, 5]) {
      expect(joined).toContain(`id="s${i}"`);
    }
    // Each body chunk should be within the budget (allow small overhead for marker comments).
    for (let i = 1; i < r.chunks.length; i++) {
      expect(Buffer.byteLength(r.chunks[i]!, "utf8")).toBeLessThanOrEqual(1500 + 64);
    }
  });

  it("uses lower default budget so heavy pages produce more, smaller chunks", async () => {
    const { DEFAULT_MAX_PAYLOAD_BYTES } = await import("./htmlForLlm");
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(100 * 1024);
  });
});
