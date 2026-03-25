import { describe, it, expect, vi } from "vitest";
import { performAudit } from "./auditOrchestrator";

vi.mock("./llmClient", () => {
  return {
    llmCompleteJson: vi.fn(async (messages: any[]) => {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const match = /\((accessibility|seo|semanticHtml|w3cCompliance|llmFriendly)\)/.exec(
        String(user)
      );
      const id = match?.[1] ?? "seo";
      const scoreMap: Record<string, number> = {
        accessibility: 80,
        seo: 70,
        semanticHtml: 90,
        w3cCompliance: 60,
        llmFriendly: 85,
      };
      return JSON.stringify({
        score: scoreMap[id] ?? 75,
        issues: [{ severity: "info", issue: `mock-${id}`, recommendation: "ok" }],
      });
    }),
    LlmConfigError: class LlmConfigError extends Error {},
  };
});

describe("Audit Orchestrator", () => {
  it("should perform a complete audit and return all criteria scores", async () => {
    const html = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <title>Test Page - Comprehensive Audit</title>
          <meta name="description" content="This is a test page for comprehensive auditing with proper meta tags and structure.">
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta property="og:title" content="Test Page">
          <meta property="og:description" content="Description">
          <meta property="og:image" content="image.jpg">
          <link rel="canonical" href="https://example.com">
          <style>
            :focus { outline: 2px solid blue; }
          </style>
        </head>
        <body>
          <header>
            <nav>
              <ul>
                <li><a href="/home">Home</a></li>
                <li><a href="/about">About</a></li>
              </ul>
            </nav>
          </header>
          <main>
            <article>
              <h1>Main Article Title</h1>
              <section>
                <h2>Section One</h2>
                <p>This is a comprehensive paragraph with substantial content to meet minimum length requirements. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
                <img src="image.jpg" alt="Descriptive image">
              </section>
              <section>
                <h2>Section Two</h2>
                <p>Another section with proper semantic markup and good structure.</p>
              </section>
            </article>
          </main>
          <aside>
            <h2>Related Content</h2>
            <ul>
              <li><a href="/related1">Related Article 1</a></li>
              <li><a href="/related2">Related Article 2</a></li>
            </ul>
          </aside>
          <footer>
            <p>&copy; 2026 Test Site</p>
          </footer>
        </body>
      </html>
    `;

    const report = await performAudit(html);

    // Check that all criteria are present
    expect(report).toHaveProperty("overallScore");
    expect(report).toHaveProperty("llmFriendly");
    expect(report).toHaveProperty("w3cCompliance");
    expect(report).toHaveProperty("seo");
    expect(report).toHaveProperty("semanticHtml");
    expect(report).toHaveProperty("accessibility");

    // Check that all scores are numbers between 0 and 100
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(100);

    expect(report.llmFriendly.score).toBeGreaterThanOrEqual(0);
    expect(report.llmFriendly.score).toBeLessThanOrEqual(100);

    expect(report.w3cCompliance.score).toBeGreaterThanOrEqual(0);
    expect(report.w3cCompliance.score).toBeLessThanOrEqual(100);

    expect(report.seo.score).toBeGreaterThanOrEqual(0);
    expect(report.seo.score).toBeLessThanOrEqual(100);

    expect(report.semanticHtml.score).toBeGreaterThanOrEqual(0);
    expect(report.semanticHtml.score).toBeLessThanOrEqual(100);

    expect(report.accessibility.score).toBeGreaterThanOrEqual(0);
    expect(report.accessibility.score).toBeLessThanOrEqual(100);

    // Check that issues arrays exist
    expect(Array.isArray(report.llmFriendly.issues)).toBe(true);
    expect(Array.isArray(report.w3cCompliance.issues)).toBe(true);
    expect(Array.isArray(report.seo.issues)).toBe(true);
    expect(Array.isArray(report.semanticHtml.issues)).toBe(true);
    expect(Array.isArray(report.accessibility.issues)).toBe(true);
  });

  it("should handle poorly structured HTML", async () => {
    const html = `
      <html>
        <body>
          <div>Some content</div>
        </body>
      </html>
    `;

    const report = await performAudit(html);

    // Should still return valid scores
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(100);

    // Should have identified issues
    expect(
      report.llmFriendly.issues.length +
        report.w3cCompliance.issues.length +
        report.seo.issues.length +
        report.semanticHtml.issues.length +
        report.accessibility.issues.length
    ).toBeGreaterThan(0);
  });

  it("should calculate overall score as average of all criteria", async () => {
    const html = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <title>Test</title>
          <meta name="description" content="Test description">
        </head>
        <body>
          <h1>Test</h1>
          <p>Content</p>
        </body>
      </html>
    `;

    const report = await performAudit(html);

    // Overall score should be approximately the average
    const average = Math.round(
      (report.llmFriendly.score +
        report.w3cCompliance.score +
        report.seo.score +
        report.semanticHtml.score +
        report.accessibility.score) /
        5
    );

    expect(report.overallScore).toBe(average);
  });

  it("should include issue details with severity and recommendations", async () => {
    const html = `
      <html>
        <body>
          <p>Content</p>
        </body>
      </html>
    `;

    const report = await performAudit(html);

    // Get all issues
    const allIssues = [
      ...report.llmFriendly.issues,
      ...report.w3cCompliance.issues,
      ...report.seo.issues,
      ...report.semanticHtml.issues,
      ...report.accessibility.issues,
    ];

    // Check that issues have required properties
    for (const issue of allIssues) {
      expect(issue).toHaveProperty("severity");
      expect(issue).toHaveProperty("issue");
      expect(issue).toHaveProperty("recommendation");
      expect(["error", "warning", "info"]).toContain(issue.severity);
      expect(typeof issue.issue).toBe("string");
      expect(typeof issue.recommendation).toBe("string");
    }
  });
});
