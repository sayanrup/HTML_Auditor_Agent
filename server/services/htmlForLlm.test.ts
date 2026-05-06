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

  it("hard-slices a single oversize landmark", () => {
    const huge = `<main>${"X".repeat(5000)}</main>`;
    const html = `<!doctype html><html><head><title>T</title></head><body>${huge}</body></html>`;
    const r = chunkHtmlForLlm(html, 800);
    expect(r.chunked).toBe(true);
    expect(r.chunks.some((c) => c.includes("chunk:body-part"))).toBe(true);
  });
});
