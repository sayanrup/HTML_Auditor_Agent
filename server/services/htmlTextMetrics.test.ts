import { describe, it, expect } from "vitest";
import { computeHtmlTextMetrics } from "./htmlTextMetrics";

describe("computeHtmlTextMetrics", () => {
  it("excludes script and JSON-like text from visible count", () => {
    const html = `<!DOCTYPE html><html><body>
      <p>Visible paragraph one.</p>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"X"}</script>
      <p>Two.</p>
      <textarea>{"hydration":"payload","n":1}</textarea>
    </body></html>`;
    const m = computeHtmlTextMetrics(html);
    // Only the two <p> sentences; script + textarea JSON excluded from text
    expect(m.visibleTextChars).toBe("Visible paragraph one. Two.".length);
    expect(m.htmlBytes).toBeGreaterThan(0);
    expect(m.markupHtmlBytes).toBeGreaterThan(0);
    expect(m.markupHtmlBytes).toBeLessThanOrEqual(m.htmlBytes);
    const expectedRatio =
      Math.round((m.markupHtmlBytes / m.visibleTextChars) * 100) / 100;
    expect(m.htmlToTextRatio).toBe(expectedRatio);
  });
});
