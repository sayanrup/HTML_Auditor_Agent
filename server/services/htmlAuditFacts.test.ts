import { describe, it, expect } from "vitest";
import { countOpenTags } from "./htmlAuditFacts";

describe("countOpenTags", () => {
  it("ignores h1 inside script and counts body h1", () => {
    const html = `<!doctype html><html><body>
      <h1>Real</h1>
      <script>var x = "<h1>fake</h1>";</script>
    </body></html>`;
    expect(countOpenTags(html, "h1")).toBe(1);
  });

  it("ignores h1 inside iframe", () => {
    const html = `<h1>Page</h1><iframe src="x"><h1>Embedded</h1></iframe>`;
    expect(countOpenTags(html, "h1")).toBe(1);
  });
});
