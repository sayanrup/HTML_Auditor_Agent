import { describe, it, expect, vi } from "vitest";
import { analyzeSEO } from "./seo";

vi.mock("../services/llmClient", () => {
  return {
    llmCompleteJson: vi.fn(async () => {
      return JSON.stringify({
        score: 77,
        issues: [{ severity: "info", issue: "mock-seo", recommendation: "ok" }],
      });
    }),
    LlmConfigError: class LlmConfigError extends Error {},
  };
});

describe("SEO Analyzer", () => {
  it("should return a score and issues", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>My Awesome Page - Best Content</title>
          <meta name="description" content="This is a comprehensive description of my page that helps search engines understand the content.">
          <meta property="og:title" content="My Awesome Page">
          <meta property="og:description" content="Description">
          <meta property="og:image" content="image.jpg">
          <link rel="canonical" href="https://example.com/page">
        </head>
        <body>
          <h1>Main Heading</h1>
          <h2>Subheading</h2>
          <p>This is substantial content with more than 300 words. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
          <img src="image.jpg" alt="Descriptive alt text">
          <a href="/internal">Internal Link</a>
          <a href="https://external.com">External Link</a>
        </body>
      </html>
    `;

    const result = await analyzeSEO(html);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("should be deterministic under mock", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head></head>
        <body>
          <h1>Content</h1>
        </body>
      </html>
    `;

    const result = await analyzeSEO(html);
    expect(result.score).toBe(77);
    expect(result.issues[0]?.issue).toContain("mock-seo");
  });

  it("should handle minimal HTML", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Page Title</title>
        </head>
        <body>
          <h1>Content</h1>
        </body>
      </html>
    `;

    const result = await analyzeSEO(html);
    expect(result.score).toBe(77);
  });

  it("should not throw for missing fields", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Page</title>
          <meta name="description" content="Description">
        </head>
        <body>
          <h1>Title</h1>
          <img src="image.jpg">
          <img src="image2.jpg">
        </body>
      </html>
    `;

    const result = await analyzeSEO(html);
    expect(result.score).toBe(77);
  });

  it("should keep output shape", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Short</title>
          <meta name="description" content="Description">
        </head>
        <body>
          <h1>Title</h1>
        </body>
      </html>
    `;

    const result = await analyzeSEO(html);
    expect(typeof result.score).toBe("number");
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("should not exceed score range", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Page Title</title>
          <meta name="description" content="Description">
        </head>
        <body>
          <h2>Not H1</h2>
        </body>
      </html>
    `;

    const result = await analyzeSEO(html);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
