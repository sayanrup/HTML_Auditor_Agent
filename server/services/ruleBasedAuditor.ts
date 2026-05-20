/**
 * Fully deterministic (no-LLM) HTML auditor.
 * Covers the same five criteria as the AI audit plus docSize.
 * Output shape matches AuditReport exactly so the same UI renders both modes.
 */

import type { AuditReport, AuditIssue, CriterionResult } from "./auditOrchestrator";
import {
  computeHtmlTextMetrics,
  computeJsCssMetrics,
  findTopBloatedSegments,
  type HtmlTextMetrics,
  type JsCssMetrics,
} from "./htmlTextMetrics";
// JS metrics (jsChars, jsToTextRatio, etc.) are injected by the router via Playwright analysis
import { countOpenTags } from "./htmlAuditFacts";
import { runDeterministicSemanticChecks } from "./llmEvaluator";

// ── tiny helpers ──────────────────────────────────────────────────────────

function trunc(s: string, n = 300): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function firstMatch(html: string, re: RegExp): string {
  const m = re.exec(html);
  return m ? trunc(m[0]) : "";
}

function allMatches(html: string, re: RegExp, max = 20): string[] {
  const out: string[] = [];
  const flags = re.flags.replace(/g/g, "") + "g";
  const gr = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  while ((m = gr.exec(html)) !== null && out.length < max) out.push(m[0]);
  return out;
}

/** score = 92 - (errors×10 + warnings×4 + infos×1), clamped 0–92 */
function scoreFrom(issues: AuditIssue[]): number {
  const e = issues.filter(i => i.severity === "error").length;
  const w = issues.filter(i => i.severity === "warning").length;
  const n = issues.filter(i => i.severity === "info").length;
  return Math.max(0, Math.min(92, 92 - e * 10 - w * 4 - n));
}

function getHead(html: string): string {
  return /<head\b[^>]*>[\s\S]*?<\/head>/i.exec(html)?.[0] ?? "";
}

function getMetaContent(head: string, name: string): string | null {
  const re = new RegExp(
    `<meta\\b[^>]*\\bname\\s*=\\s*["']${name}["'][^>]*>`,
    "i"
  );
  const tag = re.exec(head)?.[0];
  if (!tag) return null;
  return /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
}

// ── LLM-Friendly ──────────────────────────────────────────────────────────

function checkLlmFriendly(html: string): CriterionResult {
  const issues: AuditIssue[] = [];

  // H1 presence / uniqueness
  const h1Count = countOpenTags(html, "h1");
  if (h1Count === 0) {
    issues.push({
      severity: "error",
      issue: "Missing <h1> element",
      recommendation: "Add a single descriptive <h1> summarising the page topic.",
      htmlSnippet: firstMatch(html, /<body\b[^>]*>/) || "<body>",
    });
  } else if (h1Count > 1) {
    issues.push({
      severity: "warning",
      issue: `Multiple <h1> elements found (${h1Count})`,
      recommendation: "Use exactly one <h1> per page. Demote extra headings to <h2>–<h6>.",
      htmlSnippet: firstMatch(html, /<h1\b[^>]*>[\s\S]*?<\/h1>/i) || "<h1>",
    });
  }

  // Heading hierarchy — flag first 3 skipped levels
  const headingTags = [...html.matchAll(/<h([1-6])\b[^>]*>/gi)];
  let prev = 0;
  let skips = 0;
  for (const m of headingTags) {
    const lvl = parseInt(m[1]);
    if (prev > 0 && lvl > prev + 1 && skips < 3) {
      issues.push({
        severity: "warning",
        issue: `Heading level skipped: <h${prev}> followed by <h${lvl}>`,
        recommendation: `Use <h${prev + 1}> instead of <h${lvl}> to keep a continuous hierarchy.`,
        htmlSnippet: trunc(m[0]),
      });
      skips++;
    }
    prev = lvl;
  }

  // Missing <main> landmark
  if (countOpenTags(html, "main") === 0) {
    issues.push({
      severity: "error",
      issue: "Missing <main> landmark",
      recommendation: "Wrap primary content in <main> so crawlers and parsers can identify the main region.",
      htmlSnippet: firstMatch(html, /<body\b[^>]*>/) || "<body>",
    });
  }

  // Missing <nav>
  if (countOpenTags(html, "nav") === 0) {
    issues.push({
      severity: "warning",
      issue: "No <nav> landmark found",
      recommendation: "Wrap navigation menus in <nav> so parsers can identify navigation regions.",
      htmlSnippet: firstMatch(html, /<body\b[^>]*>/) || "<body>",
    });
  }

  // Generic link text
  const genericTexts = ["click here", "read more", "here", "more", "learn more", "details", "view", "link"];
  for (const txt of genericTexts) {
    const found = firstMatch(html, new RegExp(`<a\\b[^>]*>\\s*${txt}\\s*<\\/a>`, "i"));
    if (found) {
      issues.push({
        severity: "warning",
        issue: `Generic link text: "${txt}"`,
        recommendation: `Replace "${txt}" with descriptive text explaining the link destination.`,
        htmlSnippet: found,
      });
    }
  }

  // Empty anchor tags
  for (const a of allMatches(html, /<a\b[^>]*>\s*<\/a>/gi, 3)) {
    issues.push({
      severity: "error",
      issue: "Empty <a> element with no accessible text",
      recommendation: "Add descriptive text or aria-label to all <a> elements.",
      htmlSnippet: trunc(a),
    });
  }

  // Images without alt
  const imgsNoAlt = allMatches(html, /<img\b(?![^>]*\balt\s*=)[^>]*>/gi, 5);
  if (imgsNoAlt.length > 0) {
    issues.push({
      severity: "error",
      issue: `${imgsNoAlt.length} <img> element(s) missing alt attribute`,
      recommendation: "Add descriptive alt text to informative images; use alt=\"\" for decorative ones.",
      htmlSnippet: trunc(imgsNoAlt[0]),
    });
  }

  // Clickable <div> without button role
  for (const div of allMatches(html, /<div\b[^>]*\bonclick\b[^>]*>/gi, 3).slice(0, 2)) {
    if (!/role\s*=\s*["']button["']/i.test(div)) {
      issues.push({
        severity: "warning",
        issue: "Clickable <div> with onclick and no role=\"button\"",
        recommendation: "Use <button> instead, or add role=\"button\" and tabindex=\"0\".",
        htmlSnippet: trunc(div),
      });
    }
  }

  // Layout tables (td but no th/thead)
  let layoutTableCount = 0;
  for (const tbl of allMatches(html, /<table\b[\s\S]*?<\/table>/gi, 5)) {
    if (/<td\b/i.test(tbl) && !/<th\b/i.test(tbl) && !/<thead\b/i.test(tbl)) {
      if (layoutTableCount === 0) {
        issues.push({
          severity: "warning",
          issue: "Table without <th>/<thead> — likely used for layout",
          recommendation: "Use CSS grid/flex for layout. For data tables add <th> with scope and a <caption>.",
          htmlSnippet: trunc(tbl, 250),
        });
      }
      layoutTableCount++;
    }
  }
  if (layoutTableCount > 1) {
    issues.push({
      severity: "info",
      issue: `${layoutTableCount} layout-style tables found`,
      recommendation: "Replace all layout tables with CSS-based layouts.",
      htmlSnippet: "<table>…</table>",
    });
  }

  // Deep nesting (6+ consecutive div openings)
  const deepNest = firstMatch(html, /(?:<div\b[^>]*>\s*){6,}/i);
  if (deepNest) {
    issues.push({
      severity: "info",
      issue: "Deeply nested <div> wrappers (6+ levels) detected",
      recommendation: "Flatten wrapper chains; use semantic elements (section, article, aside) to reduce depth.",
      htmlSnippet: trunc(deepNest, 250),
    });
  }

  return { score: scoreFrom(issues), issues };
}

// ── W3C Compliance ────────────────────────────────────────────────────────

function checkW3cCompliance(html: string): CriterionResult {
  const issues: AuditIssue[] = [];

  // Reuse existing deterministic direct-child rules
  const deterministicIssues = runDeterministicSemanticChecks(html);
  issues.push(...deterministicIssues);

  // Duplicate IDs
  const allIds = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(m => m[1].toLowerCase());
  const idCount = new Map<string, number>();
  for (const id of allIds) idCount.set(id, (idCount.get(id) ?? 0) + 1);
  for (const [id, cnt] of idCount) {
    if (cnt > 1) {
      issues.push({
        severity: "error",
        issue: `Duplicate id="${id}" appears ${cnt} times`,
        recommendation: `IDs must be unique per document. Rename all duplicate instances of id="${id}".`,
        htmlSnippet: firstMatch(html, new RegExp(`id\\s*=\\s*["']${id}["']`, "i")) || `id="${id}"`,
      });
    }
  }

  // Deprecated elements
  const deprecated = ["font", "center", "marquee", "blink", "basefont", "big", "strike", "tt", "frame", "frameset"];
  for (const tag of deprecated) {
    const found = firstMatch(html, new RegExp(`<${tag}\\b[^>]*>`, "i"));
    if (found) {
      issues.push({
        severity: "error",
        issue: `Deprecated <${tag}> element used`,
        recommendation: `Remove <${tag}>. Use CSS or modern semantic HTML equivalents.`,
        htmlSnippet: found,
      });
    }
  }

  // Nested interactive: <a> inside <a>
  for (const m of allMatches(html, /<a\b[^>]*>[\s\S]*?<a\b[^>]*>/gi, 2)) {
    issues.push({
      severity: "error",
      issue: "Nested <a> inside <a> — invalid HTML",
      recommendation: "Interactive elements cannot be nested. Split into sibling elements.",
      htmlSnippet: trunc(m, 250),
    });
  }

  // <button> inside <a>
  for (const m of allMatches(html, /<a\b[^>]*>[\s\S]*?<button\b[^>]*>/gi, 2)) {
    issues.push({
      severity: "error",
      issue: "<button> nested inside <a> — invalid HTML",
      recommendation: "Use <a> for navigation or <button> for actions, not both nested together.",
      htmlSnippet: trunc(m, 250),
    });
  }

  // Block elements inside <p>
  for (const m of allMatches(
    html,
    /<p\b[^>]*>[\s\S]*?<(?:div|section|article|ul|ol|table|h[1-6]|blockquote|pre|figure)\b/gi,
    3
  )) {
    issues.push({
      severity: "error",
      issue: "Block-level element inside <p> — invalid HTML",
      recommendation: "Close <p> before any block-level element. Browsers auto-close <p>, causing unexpected DOM structure.",
      htmlSnippet: trunc(m, 250),
    });
  }

  // <img> missing required alt
  const imgsNoAlt = allMatches(html, /<img\b(?![^>]*\balt\s*=)[^>]*>/gi, 5);
  if (imgsNoAlt.length > 0) {
    issues.push({
      severity: "error",
      issue: `${imgsNoAlt.length} <img> element(s) missing required alt attribute`,
      recommendation: "alt is required on every <img> per the HTML spec. Use alt=\"\" for decorative images.",
      htmlSnippet: trunc(imgsNoAlt[0]),
    });
  }

  // Multiple <main>
  const mainCount = countOpenTags(html, "main");
  if (mainCount > 1) {
    issues.push({
      severity: "error",
      issue: `Multiple <main> elements (${mainCount}) — only one is allowed`,
      recommendation: "A document must have exactly one <main>. Convert or remove extra instances.",
      htmlSnippet: firstMatch(html, /<main\b[^>]*>/) || "<main>",
    });
  }

  return { score: scoreFrom(issues), issues };
}

// ── SEO ───────────────────────────────────────────────────────────────────

function checkSeo(html: string): CriterionResult {
  const issues: AuditIssue[] = [];
  const head = getHead(html);

  // <title>
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (!titleMatch) {
    issues.push({
      severity: "error",
      issue: "Missing <title> element",
      recommendation: "Add a <title> tag in <head> with 50–65 characters.",
      htmlSnippet: "<head>…</head>",
    });
  } else {
    const titleText = titleMatch[1].replace(/<[^>]+>/g, "").trim();
    if (titleText.length < 10) {
      issues.push({
        severity: "error",
        issue: `<title> is too short (${titleText.length} chars): "${titleText}"`,
        recommendation: "Write a descriptive title of 50–65 characters.",
        htmlSnippet: trunc(titleMatch[0]),
      });
    } else if (titleText.length > 65) {
      issues.push({
        severity: "warning",
        issue: `<title> too long (${titleText.length} chars) — search engines may truncate it`,
        recommendation: "Shorten the title to 50–65 characters.",
        htmlSnippet: trunc(titleMatch[0]),
      });
    }
  }

  // Meta description
  const descTag = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i.exec(head);
  if (!descTag) {
    issues.push({
      severity: "error",
      issue: "Missing meta description",
      recommendation: 'Add <meta name="description" content="…"> with 150–165 characters.',
      htmlSnippet: "<head>…</head>",
    });
  } else {
    const desc = (/\bcontent\s*=\s*["']([^"']*)["']/i.exec(descTag[0])?.[1] ?? "").trim();
    if (desc.length < 70) {
      issues.push({
        severity: "warning",
        issue: `Meta description too short (${desc.length} chars)`,
        recommendation: "Write a meta description of 150–165 characters.",
        htmlSnippet: trunc(descTag[0]),
      });
    } else if (desc.length > 165) {
      issues.push({
        severity: "info",
        issue: `Meta description too long (${desc.length} chars) — may be truncated in SERPs`,
        recommendation: "Trim meta description to 150–165 characters.",
        htmlSnippet: trunc(descTag[0]),
      });
    }
  }

  // Canonical
  if (!/<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i.test(head)) {
    issues.push({
      severity: "warning",
      issue: "Missing canonical link",
      recommendation: 'Add <link rel="canonical" href="…"> to prevent duplicate-content issues.',
      htmlSnippet: "<head>…</head>",
    });
  }

  // Viewport
  if (!/<meta\b[^>]*\bname\s*=\s*["']viewport["'][^>]*>/i.test(head)) {
    issues.push({
      severity: "error",
      issue: "Missing viewport meta tag",
      recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      htmlSnippet: "<head>…</head>",
    });
  }

  // H1 from SEO angle
  const h1Count = countOpenTags(html, "h1");
  if (h1Count === 0) {
    issues.push({
      severity: "error",
      issue: "Missing <h1> — primary keyword signal absent",
      recommendation: "Add a single <h1> containing the page's main keyword phrase.",
      htmlSnippet: firstMatch(html, /<body\b[^>]*>/) || "<body>",
    });
  } else if (h1Count > 1) {
    issues.push({
      severity: "warning",
      issue: `Multiple <h1> elements (${h1Count}) dilute keyword signal`,
      recommendation: "Use exactly one <h1> per page.",
      htmlSnippet: firstMatch(html, /<h1\b[^>]*>[\s\S]*?<\/h1>/i) || "<h1>",
    });
  }

  // JSON-LD
  if (!/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>/i.test(html)) {
    issues.push({
      severity: "warning",
      issue: "No JSON-LD structured data found",
      recommendation: "Add JSON-LD (Organization, Product, Article, BreadcrumbList, etc.) to improve rich results.",
      htmlSnippet: "<head>…</head>",
    });
  }

  // Images without alt (keyword opportunity)
  const imgsNoAlt = allMatches(html, /<img\b(?![^>]*\balt\s*=)[^>]*>/gi, 3);
  if (imgsNoAlt.length > 0) {
    issues.push({
      severity: "warning",
      issue: `${imgsNoAlt.length} image(s) missing alt — keyword opportunity lost`,
      recommendation: "Add descriptive, keyword-relevant alt text to content images.",
      htmlSnippet: trunc(imgsNoAlt[0]),
    });
  }

  // Robots meta noindex
  const robotsTag = /<meta\b[^>]*\bname\s*=\s*["']robots["'][^>]*>/i.exec(head);
  if (robotsTag) {
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(robotsTag[0])?.[1] ?? "";
    if (/noindex/i.test(content)) {
      issues.push({
        severity: "error",
        issue: `Page has robots meta noindex: "${content}"`,
        recommendation: "Remove noindex if this page should be indexed. Confirm this is intentional.",
        htmlSnippet: trunc(robotsTag[0]),
      });
    }
  }

  // Twitter Card
  if (!/<meta\b[^>]*\bname\s*=\s*["']twitter:card["'][^>]*>/i.test(head)) {
    issues.push({
      severity: "info",
      issue: "Missing Twitter Card meta tags",
      recommendation: "Add twitter:card, twitter:title, twitter:description for social sharing previews.",
      htmlSnippet: "<head>…</head>",
    });
  }

  // hreflang if multiple lang attributes exist
  const langAttrs = allMatches(html, /\blang\s*=\s*["'][^"']+["']/gi, 10);
  const uniqueLangs = new Set(langAttrs.map(a => /["']([^"']+)["']/.exec(a)?.[1]?.toLowerCase()));
  if (uniqueLangs.size > 1 && !/<link\b[^>]*\bhreflang\b/i.test(head)) {
    issues.push({
      severity: "info",
      issue: "Multiple lang attributes detected but no hreflang links found",
      recommendation: "Add hreflang link elements for each language/region variant of the page.",
      htmlSnippet: "<head>…</head>",
    });
  }

  return { score: scoreFrom(issues), issues };
}

// ── Semantic HTML ─────────────────────────────────────────────────────────

function checkSemanticHtml(html: string): CriterionResult {
  const issues: AuditIssue[] = [];

  // Reuse direct-child content-model rules
  issues.push(...runDeterministicSemanticChecks(html));

  // Missing structural landmarks
  const landmarkChecks: Array<[string, string, string]> = [
    ["main",   "error",   "Wrap primary content in <main>."],
    ["header", "warning", "Wrap the page banner in <header>."],
    ["footer", "warning", "Wrap footer content in <footer>."],
    ["nav",    "warning", "Wrap navigation in <nav>."],
  ];
  for (const [tag, sev, rec] of landmarkChecks) {
    if (countOpenTags(html, tag) === 0) {
      issues.push({
        severity: sev as AuditIssue["severity"],
        issue: `Missing <${tag}> landmark element`,
        recommendation: rec,
        htmlSnippet: firstMatch(html, /<body\b[^>]*>/) || "<body>",
      });
    }
  }

  // Multiple <main>
  if (countOpenTags(html, "main") > 1) {
    issues.push({
      severity: "error",
      issue: `Multiple <main> elements (${countOpenTags(html, "main")}) found`,
      recommendation: "A document must have exactly one <main>.",
      htmlSnippet: firstMatch(html, /<main\b[^>]*>/) || "<main>",
    });
  }

  // <section> without heading
  let sectionNoHeading = 0;
  for (const sec of allMatches(html, /<section\b[\s\S]*?<\/section>/gi, 10)) {
    if (!/<h[1-6]\b/i.test(sec)) {
      if (sectionNoHeading === 0) {
        issues.push({
          severity: "warning",
          issue: "<section> element without a heading",
          recommendation: "Add an <h2>–<h6> heading to every <section> to label its content region.",
          htmlSnippet: trunc(sec, 250),
        });
      }
      sectionNoHeading++;
    }
  }
  if (sectionNoHeading > 1) {
    issues.push({
      severity: "info",
      issue: `${sectionNoHeading} <section> elements lack headings`,
      recommendation: "Every <section> should have a heading.",
      htmlSnippet: "<section>…</section>",
    });
  }

  // <article> without heading
  let articleNoHeading = 0;
  for (const art of allMatches(html, /<article\b[\s\S]*?<\/article>/gi, 5)) {
    if (!/<h[1-6]\b/i.test(art)) {
      if (articleNoHeading === 0) {
        issues.push({
          severity: "warning",
          issue: "<article> element without a heading",
          recommendation: "Add an <h2>–<h6> to each <article> to identify its topic.",
          htmlSnippet: trunc(art, 250),
        });
      }
      articleNoHeading++;
    }
  }

  // <nav> without list
  for (const nav of allMatches(html, /<nav\b[\s\S]*?<\/nav>/gi, 3)) {
    if (!/<[uo]l\b/i.test(nav)) {
      issues.push({
        severity: "info",
        issue: "<nav> without a <ul>/<ol> list",
        recommendation: "Wrap navigation links in a <ul> or <ol> for semantic list structure.",
        htmlSnippet: trunc(nav, 250),
      });
      break;
    }
  }

  // Empty semantic containers
  for (const m of allMatches(
    html,
    /<(?:main|section|article|aside)\b[^>]*>\s*<\/(?:main|section|article|aside)>/gi,
    3
  )) {
    issues.push({
      severity: "error",
      issue: "Empty semantic container element",
      recommendation: "Remove empty semantic elements or populate them with content.",
      htmlSnippet: trunc(m),
    });
  }

  // Div/span soup ratio
  const divSpanCount =
    countOpenTags(html, "div") + countOpenTags(html, "span");
  const semanticCount = ["main", "nav", "header", "footer", "section", "article", "aside", "figure"]
    .reduce((s, t) => s + countOpenTags(html, t), 0);
  if (divSpanCount > 50 && semanticCount < Math.floor(divSpanCount * 0.1)) {
    issues.push({
      severity: "warning",
      issue: `Heavy div/span usage: ${divSpanCount} generic containers vs ${semanticCount} semantic elements`,
      recommendation: "Replace div/span wrappers with semantic equivalents (section, article, nav, aside, figure, etc.).",
      htmlSnippet: "<div>…</div>",
    });
  }

  return { score: scoreFrom(issues), issues };
}

// ── Accessibility ─────────────────────────────────────────────────────────

function checkAccessibility(html: string): CriterionResult {
  const issues: AuditIssue[] = [];

  // html[lang]
  const htmlTag = /<html\b[^>]*>/i.exec(html)?.[0] ?? "";
  if (!htmlTag || !/\blang\s*=\s*["'][^"']+["']/i.test(htmlTag)) {
    issues.push({
      severity: "error",
      issue: "Missing lang attribute on <html>",
      recommendation: 'Add lang="en" (or correct language code) to <html>.',
      htmlSnippet: trunc(htmlTag || "<html>"),
    });
  }

  // Document title
  if (!/<title\b[^>]*>[^<]+<\/title>/i.test(html)) {
    issues.push({
      severity: "error",
      issue: "Missing or empty document <title>",
      recommendation: "Add a descriptive, non-empty <title> in <head>.",
      htmlSnippet: "<head>…</head>",
    });
  }

  // Images without alt
  const imgsNoAlt = allMatches(html, /<img\b(?![^>]*\balt\s*=)[^>]*>/gi, 5);
  if (imgsNoAlt.length > 0) {
    issues.push({
      severity: "error",
      issue: `${imgsNoAlt.length} <img> element(s) missing alt attribute`,
      recommendation: "Add alt text to informative images; use alt=\"\" for decorative ones.",
      htmlSnippet: trunc(imgsNoAlt[0]),
    });
  }

  // Inputs without labels — collect label[for] IDs first
  const labelledIds = new Set(
    [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(m => m[1])
  );
  let unlabelled = 0;
  for (const input of allMatches(html, /<input\b[^>]*>/gi, 30)) {
    const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(input)?.[1]?.toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type ?? "")) continue;
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(input)?.[1];
    const hasAria = /\baria-(?:label|labelledby)\s*=\s*["'][^"']+["']/i.test(input);
    if (!hasAria && (!id || !labelledIds.has(id))) {
      if (unlabelled < 3) {
        issues.push({
          severity: "error",
          issue: "Form input without associated label",
          recommendation: "Associate a <label> via for/id pair, or add aria-label/aria-labelledby.",
          htmlSnippet: trunc(input),
        });
      }
      unlabelled++;
    }
  }
  if (unlabelled > 3) {
    issues.push({
      severity: "info",
      issue: `${unlabelled} unlabelled inputs total`,
      recommendation: "Every visible form input must have an accessible label.",
      htmlSnippet: "<input>",
    });
  }

  // Placeholder-only inputs (no label association but has placeholder)
  let placeholderOnly = 0;
  for (const input of allMatches(html, /<input\b[^>]*\bplaceholder\s*=[^>]*>/gi, 20)) {
    const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(input)?.[1]?.toLowerCase();
    if (["hidden", "submit", "button", "reset"].includes(type ?? "")) continue;
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(input)?.[1];
    const hasAria = /\baria-(?:label|labelledby)\s*=\s*["'][^"']+["']/i.test(input);
    if (!hasAria && (!id || !labelledIds.has(id))) {
      if (placeholderOnly === 0) {
        issues.push({
          severity: "warning",
          issue: "Input uses placeholder as the only label",
          recommendation: "Add a visible <label>. Placeholder disappears on input and is inaccessible to many users.",
          htmlSnippet: trunc(input),
        });
      }
      placeholderOnly++;
    }
  }

  // Positive tabindex
  for (const t of allMatches(html, /\btabindex\s*=\s*["'][1-9][0-9]*["']/gi, 3).slice(0, 2)) {
    issues.push({
      severity: "warning",
      issue: "Positive tabindex value disrupts natural focus order",
      recommendation: "Use tabindex=\"0\" to add to tab order; tabindex=\"-1\" to remove. Avoid positive values.",
      htmlSnippet: trunc(t),
    });
  }

  // target="_blank" without rel="noopener"
  const blankLink = allMatches(html, /<a\b[^>]*\btarget\s*=\s*["']_blank["'][^>]*>/gi, 5).find(
    l => !/rel\s*=\s*["'][^"']*noopener/i.test(l)
  );
  if (blankLink) {
    issues.push({
      severity: "warning",
      issue: 'Link opens in new tab without rel="noopener"',
      recommendation: 'Add rel="noopener noreferrer" and indicate to users that the link opens in a new tab.',
      htmlSnippet: trunc(blankLink),
    });
  }

  // Empty buttons
  for (const btn of allMatches(html, /<button\b[^>]*>\s*<\/button>/gi, 3)) {
    if (!/aria-label\s*=/i.test(btn)) {
      issues.push({
        severity: "error",
        issue: "Empty <button> with no accessible text or aria-label",
        recommendation: "Add visible text or aria-label to every <button>.",
        htmlSnippet: trunc(btn),
      });
    }
  }

  // aria-hidden on focusable elements
  for (const el of allMatches(
    html,
    /<(?:a|button|input|select|textarea)\b[^>]*\baria-hidden\s*=\s*["']true["'][^>]*>/gi,
    2
  )) {
    issues.push({
      severity: "error",
      issue: 'Focusable element has aria-hidden="true"',
      recommendation: 'Never set aria-hidden="true" on focusable elements — it hides them from screen readers while keeping keyboard focus.',
      htmlSnippet: trunc(el),
    });
  }

  // Tables without <th>
  const tablesNoTh = allMatches(html, /<table\b[\s\S]*?<\/table>/gi, 5).filter(
    t => /<td\b/i.test(t) && !/<th\b/i.test(t)
  );
  if (tablesNoTh.length > 0) {
    issues.push({
      severity: "warning",
      issue: `${tablesNoTh.length} data table(s) without <th> header cells`,
      recommendation: "Add <th scope=\"col\"> or <th scope=\"row\"> elements to identify headers.",
      htmlSnippet: trunc(tablesNoTh[0], 250),
    });
  }

  // Skip link
  const hasSkipLink = /<a\b[^>]*href\s*=\s*["']#(?:main|content|skip|maincontent)[^"']*["'][^>]*>/i.test(html);
  if (!hasSkipLink && countOpenTags(html, "nav") > 0) {
    issues.push({
      severity: "info",
      issue: "No skip navigation link found",
      recommendation: 'Add a skip link at the top: <a href="#main">Skip to main content</a>.',
      htmlSnippet: "<body>…</body>",
    });
  }

  return { score: scoreFrom(issues), issues };
}

// ── docSize recommendation ────────────────────────────────────────────────

function buildDocSizeRec(m: HtmlTextMetrics, js: JsCssMetrics): string {
  const tactics: string[] = [];

  const r = m.htmlToTextRatio;
  if (r > 30)
    tactics.push(`HTML-to-text ratio ${r.toFixed(1)} is very high (>30) — aggressively remove wrapper divs and inline styles`);
  else if (r > 15)
    tactics.push(`HTML-to-text ratio ${r.toFixed(1)} is notable (target <15) — reduce wrapper nesting`);
  else
    tactics.push(`HTML-to-text ratio ${r.toFixed(1)} is acceptable`);

  if (js.cssToTextRatio > 2)
    tactics.push(`Inline CSS-to-text ratio ${js.cssToTextRatio.toFixed(2)} is high (${js.cssInlineCount} inline <style> block(s)) — consolidate into external stylesheets`);
  else if (js.cssInlineCount > 2)
    tactics.push(`${js.cssInlineCount} inline <style> blocks detected — consolidate into external stylesheet`);
  if (js.cssExtCount > 5)
    tactics.push(`${js.cssExtCount} external imimg.com stylesheets detected — consider bundling`);

  if (m.htmlBytes > 200_000)
    tactics.push("page exceeds 200 KB — minify HTML and defer non-critical resources");
  if (m.markupHtmlBytes > 80_000)
    tactics.push("move JSON-LD and inline config data to external files");

  tactics.push("minify HTML whitespace in production");

  return tactics.slice(0, 6).join("; ");
}

// ── public entry ──────────────────────────────────────────────────────────

export async function performRuleBasedAudit(html: string): Promise<AuditReport> {
  const metrics = computeHtmlTextMetrics(html);
  const jsCss = await computeJsCssMetrics(html, metrics.visibleTextChars);
  const topBloatedSegments = findTopBloatedSegments(html, 5);

  const llmFriendly  = checkLlmFriendly(html);
  const w3cCompliance = checkW3cCompliance(html);
  const seo          = checkSeo(html);
  const semanticHtml = checkSemanticHtml(html);
  const accessibility = checkAccessibility(html);

  const overallScore = Math.round(
    (llmFriendly.score + w3cCompliance.score + seo.score + semanticHtml.score + accessibility.score) / 5
  );

  return {
    overallScore,
    llmFriendly,
    w3cCompliance,
    seo,
    semanticHtml,
    accessibility,
    docSize: {
      size: metrics.htmlBytes,
      recommendation: buildDocSizeRec(metrics, jsCss),
      htmlBytes: metrics.htmlBytes,
      markupHtmlBytes: metrics.markupHtmlBytes,
      visibleTextChars: metrics.visibleTextChars,
      htmlToTextRatio: metrics.htmlToTextRatio,
      topBloatedSegments,
      ...jsCss,
    },
  };
}
