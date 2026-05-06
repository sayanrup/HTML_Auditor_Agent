import { describe, it, expect } from "vitest";
import { filterIssuesAgainstGroundTruth } from "./llmEvaluator";

const issue = (
  severity: "error" | "warning" | "info",
  text: string,
  recommendation = "rec",
  htmlSnippet = "<x/>"
) => ({ severity, issue: text, recommendation, htmlSnippet });

const BASE_GT = { h1Count: 1, mainCount: 1, html: "" };

describe("filterIssuesAgainstGroundTruth", () => {
  it("drops 'missing/no/lacking <h1>' style issues when h1Count >= 1", () => {
    const items = [
      issue("warning", "Missing a clear and unique <h1> element."),
      issue("warning", "No <h1> tag is present on the page"),
      issue("warning", "Lacking a primary h1 heading"),
      issue("info", "Heading hierarchy could be improved"),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, BASE_GT);
    expect(dropped).toBe(3);
    expect(kept.map((i) => i.issue)).toEqual([
      "Heading hierarchy could be improved",
    ]);
  });

  it("keeps 'missing <h1>' issues when h1Count is 0", () => {
    const items = [issue("warning", "Missing a primary <h1> element.")];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, {
      ...BASE_GT,
      h1Count: 0,
    });
    expect(dropped).toBe(0);
    expect(kept.length).toBe(1);
  });

  it("drops 'multiple <h1>' issues when h1Count <= 1", () => {
    const items = [
      issue("warning", "Multiple <h1> elements found"),
      issue("warning", "Several h1 tags detected on the page"),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, BASE_GT);
    expect(dropped).toBe(2);
    expect(kept.length).toBe(0);
  });

  it("keeps 'multiple <h1>' issues when h1Count > 1", () => {
    const items = [issue("warning", "Multiple <h1> elements found")];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, {
      ...BASE_GT,
      h1Count: 3,
    });
    expect(dropped).toBe(0);
    expect(kept.length).toBe(1);
  });

  it("drops 'missing <main>' issues when mainCount >= 1 and 'multiple <main>' when <= 1", () => {
    const items = [
      issue("warning", "Missing <main> landmark for main content"),
      issue("warning", "Multiple <main> elements detected"),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, BASE_GT);
    expect(dropped).toBe(2);
    expect(kept.length).toBe(0);
  });

  it("drops Open Graph warnings regardless of count", () => {
    const items = [
      issue("warning", "Open Graph tags are incomplete"),
      issue("info", "og:image missing for sharing previews"),
      issue("warning", "Add og:title and og:description meta tags"),
      issue("info", "Twitter card present but no og:url"),
      issue("info", "Title length is fine"),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, BASE_GT);
    expect(dropped).toBe(4);
    expect(kept.map((i) => i.issue)).toEqual(["Title length is fine"]);
  });

  it("does not drop unrelated issues that mention 'h1' in passing words like 'h1emisphere'", () => {
    const items = [
      issue(
        "info",
        "Heading levels skip from h2 to h4 in the second section."
      ),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, BASE_GT);
    expect(dropped).toBe(0);
    expect(kept.length).toBe(1);
  });

  it("drops 'use <article>' suggestions when the snippet is already inside an <article>", () => {
    const html = `<main><article class="card"><div class="slider-card">x</div></article></main>`;
    const items = [
      issue(
        "warning",
        "Use <article> for product cards instead of <div> to enhance semantic meaning.",
        "Wrap in an <article> tag.",
        '<div class="slider-card">'
      ),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, {
      ...BASE_GT,
      html,
    });
    expect(dropped).toBe(1);
    expect(kept.length).toBe(0);
  });

  it("keeps 'use <article>' suggestions when the snippet is NOT inside any <article>", () => {
    const html = `<main><section><div class="slider-card">x</div></section></main>`;
    const items = [
      issue(
        "warning",
        "Use <article> for product cards instead of <div> to enhance semantic meaning.",
        "Wrap in an <article> tag.",
        '<div class="slider-card">'
      ),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, {
      ...BASE_GT,
      html,
    });
    expect(dropped).toBe(0);
    expect(kept.length).toBe(1);
  });

  it("does NOT drop when only some snippet occurrences are inside the suggested ancestor", () => {
    const html = `<article><div class="x">a</div></article><div class="x">b</div>`;
    const items = [
      issue(
        "warning",
        "Use <article> for grouping related content",
        "Wrap with <article>",
        '<div class="x">'
      ),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, {
      ...BASE_GT,
      html,
    });
    expect(dropped).toBe(0);
    expect(kept.length).toBe(1);
  });

  it("drops 'use <article>' when the LLM hallucinated <div> but the real element IS already <article>", () => {
    // Reproduces user-reported bug: LLM emitted snippet `<div class="slider-card">`
    // but the actual HTML has `<article class="slider-card">`.
    const html = `<main><article class="slider-card"><h2>Product</h2></article></main>`;
    const items = [
      issue(
        "info",
        "Consider using <article> for product cards.",
        "Wrap each product card in an <article> tag to improve semantic structure.",
        '<div class="slider-card">'
      ),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, {
      ...BASE_GT,
      html,
    });
    expect(dropped).toBe(1);
    expect(kept.length).toBe(0);
  });

  it("drops via id-based fallback when the snippet uses the wrong tag", () => {
    const html = `<section id="reviews"><p>Reviews here</p></section>`;
    const items = [
      issue(
        "info",
        "Use <section> for grouped content",
        "Wrap in <section>",
        '<div id="reviews">'
      ),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, {
      ...BASE_GT,
      html,
    });
    expect(dropped).toBe(1);
    expect(kept.length).toBe(0);
  });

  it("keeps suggestion when no element with matching identifiers is already a semantic element", () => {
    const html = `<main><div class="slider-card"><span>P</span></div></main>`;
    const items = [
      issue(
        "info",
        "Consider using <article> for product cards.",
        "Wrap each product card in an <article> tag.",
        '<div class="slider-card">'
      ),
    ];
    const { kept, dropped } = filterIssuesAgainstGroundTruth(items, {
      ...BASE_GT,
      html,
    });
    expect(dropped).toBe(0);
    expect(kept.length).toBe(1);
  });
});
