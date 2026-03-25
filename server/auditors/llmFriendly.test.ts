import { describe, it, expect, vi } from "vitest";
import { analyzeLLMFriendly } from "./llmFriendly";

vi.mock("../services/llmClient", () => {
  return {
    llmCompleteJson: vi.fn(async () => {
      return JSON.stringify({
        score: 88,
        issues: [{ severity: "info", issue: "mock-llmFriendly", recommendation: "ok" }],
      });
    }),
    LlmConfigError: class LlmConfigError extends Error {},
  };
});

describe("LLM Friendly Analyzer", () => {
  it("should return score and issues", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test</title></head>
        <body>
          <h1>Main Title</h1>
          <h2>Section 1</h2>
          <p>This is a paragraph with content.</p>
          <h2>Section 2</h2>
          <p>Another paragraph.</p>
        </body>
      </html>
    `;

    const result = await analyzeLLMFriendly(html);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("should be deterministic under mock", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test</title></head>
        <body>
          <h2>Section</h2>
          <p>Content</p>
        </body>
      </html>
    `;

    const result = await analyzeLLMFriendly(html);
    expect(result.score).toBe(88);
    expect(result.issues[0]?.issue).toContain("mock-llmFriendly");
  });

  it("should not throw on repeated headings", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test</title></head>
        <body>
          <h1>Title 1</h1>
          <h1>Title 2</h1>
          <p>Content</p>
        </body>
      </html>
    `;

    const result = await analyzeLLMFriendly(html);
    expect(result.score).toBe(88);
  });

  it("should handle div-heavy markup", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test</title></head>
        <body>
          <h1>Title</h1>
          <div><div><div><div><div><div><div><div><div><div>
            <p>Content</p>
          </div></div></div></div></div></div></div></div></div></div>
        </body>
      </html>
    `;

    const result = await analyzeLLMFriendly(html);
    expect(result.score).toBe(88);
  });

  it("should handle invalid HTML gracefully", async () => {
    const html = "invalid html content";

    const result = await analyzeLLMFriendly(html);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.issues)).toBe(true);
  });
});
