import jsPDF from "jspdf";

interface Issue {
  severity: "error" | "warning" | "info";
  issue: string;
  recommendation: string;
  htmlSnippet: string;
}

interface CriterionResult {
  score: number;
  issues: Issue[];
}

interface HtmlSegmentRatio {
  tagName: string;
  snippet: string;
  ratio: number;
  markupBytes: number;
  visibleChars: number;
}

interface AuditReportData {
  overallScore: number;
  llmFriendly: CriterionResult;
  w3cCompliance: CriterionResult;
  seo: CriterionResult;
  semanticHtml: CriterionResult;
  accessibility: CriterionResult;
  docSize: {
    size: number;
    recommendation: string;
    htmlBytes?: number;
    markupHtmlBytes?: number;
    visibleTextChars?: number;
    htmlToTextRatio?: number;
    topBloatedSegments?: HtmlSegmentRatio[];
    jsChars?: number;
    jsCharsApp?: number;
    jsFilesTotal?: number;
    jsFilesPackage?: number;
    jsToTextRatio?: number;
    jsToTextRatioApp?: number;
    cssChars?: number;
    cssCharsApp?: number;
    cssExtCount?: number;
    cssExtPackage?: number;
    cssInlineCount?: number;
    cssToTextRatio?: number;
    cssToTextRatioApp?: number;
    unusedJs?: Array<{ url: string; totalChars: number; unusedChars: number; unusedPct: number }>;
    unusedCss?: Array<{ url: string; totalChars: number; unusedChars: number; unusedPct: number }>;
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

const M = 14;          // page margin mm
const PW = 210;        // A4 width mm
const PH = 297;        // A4 height mm
const CW = PW - M * 2; // content width mm

function scoreRgb(score: number): [number, number, number] {
  if (score >= 80) return [22, 163, 74];
  if (score >= 60) return [202, 138, 4];
  if (score >= 40) return [234, 88, 12];
  return [220, 38, 38];
}

const SEVERITY_RGB: Record<string, [number, number, number]> = {
  error:   [220, 38,  38],
  warning: [202, 138,  4],
  info:    [37,  99, 235],
};

const SEVERITY_TAG: Record<string, string> = {
  error:   "ERROR",
  warning: "WARN",
  info:    "INFO",
};

// ── PDF builder class ──────────────────────────────────────────────────────

class PdfBuilder {
  pdf: jsPDF;
  y: number = M;

  constructor() {
    this.pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  }

  newPage() {
    this.pdf.addPage();
    this.y = M;
  }

  ensureSpace(needed: number) {
    if (this.y + needed > PH - M) this.newPage();
  }

  /** Set font and return line height in mm for given fontSize (pt). */
  font(size: number, style: "normal" | "bold" | "italic" = "normal", family: "helvetica" | "courier" = "helvetica") {
    this.pdf.setFont(family, style);
    this.pdf.setFontSize(size);
    return size * 0.3528 * 1.35; // pt → mm, with leading
  }

  color(r: number, g: number, b: number) {
    this.pdf.setTextColor(r, g, b);
    return this;
  }

  writeLine(text: string, x: number, lineH: number) {
    this.pdf.text(text, x, this.y);
    this.y += lineH;
  }

  /** Write wrapped text; returns total height consumed. */
  writeWrapped(text: string, x: number, maxW: number, lineH: number): number {
    const lines = this.pdf.splitTextToSize(text, maxW);
    this.ensureSpace(lines.length * lineH + 1);
    this.pdf.text(lines, x, this.y);
    const h = lines.length * lineH;
    this.y += h;
    return h;
  }

  hrule(color: [number, number, number] = [203, 213, 225]) {
    this.pdf.setDrawColor(...color);
    this.pdf.setLineWidth(0.3);
    this.pdf.line(M, this.y, PW - M, this.y);
    this.y += 3;
  }

  spacer(mm: number) { this.y += mm; }

  /** Filled rect helper. */
  fillRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number, radius = 0) {
    this.pdf.setFillColor(r, g, b);
    if (radius > 0) this.pdf.roundedRect(x, y, w, h, radius, radius, "F");
    else this.pdf.rect(x, y, w, h, "F");
  }
}

// ── section renderers ──────────────────────────────────────────────────────

function renderHeader(b: PdfBuilder, url: string) {
  b.y += 6;

  // Title
  const lh = b.font(22, "bold");
  b.color(15, 23, 42).writeLine("HTML Audit Report", M, lh);

  b.hrule([100, 116, 139]);

  // URL
  b.font(9, "normal");
  b.color(71, 85, 105);
  b.writeWrapped(`URL: ${url}`, M, CW, 4);
  b.spacer(1);

  // Date
  b.writeLine(
    `Date: ${new Date().toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}`,
    M, 4.5
  );
  b.spacer(4);
}

function renderOverallScore(b: PdfBuilder, score: number) {
  const [r, g, bl] = scoreRgb(score);
  const cx = M + 16;
  const cy = b.y + 13;

  b.pdf.setFillColor(r, g, bl);
  b.pdf.circle(cx, cy, 16, "F");

  b.pdf.setTextColor(255, 255, 255);
  b.pdf.setFont("helvetica", "bold");
  b.pdf.setFontSize(20);
  b.pdf.text(String(score), cx, cy + 4, { align: "center" });

  b.pdf.setTextColor(15, 23, 42);
  b.pdf.setFont("helvetica", "bold");
  b.pdf.setFontSize(13);
  b.pdf.text("Overall Score", M + 38, b.y + 10);

  const label =
    score >= 80 ? "Excellent — well-optimised across all criteria." :
    score >= 60 ? "Good — some areas need improvement." :
    score >= 40 ? "Fair — consider addressing the issues below." :
    "Needs significant improvements.";

  b.pdf.setFont("helvetica", "normal");
  b.pdf.setFontSize(9);
  b.pdf.setTextColor(71, 85, 105);
  b.pdf.text(label, M + 38, b.y + 17);

  b.y += 34;
  b.spacer(4);
}

function renderScoreSummary(
  b: PdfBuilder,
  criteria: { label: string; score: number }[]
) {
  b.ensureSpace(28);
  b.font(11, "bold");
  b.color(15, 23, 42).writeLine("Score Summary", M, 6);

  const colW = CW / criteria.length;
  criteria.forEach((c, i) => {
    const x = M + i * colW;
    const cx = x + colW / 2 - 1;
    const [r, g, bl] = scoreRgb(c.score);
    b.fillRect(x, b.y, colW - 2, 16, r, g, bl, 2);
    b.pdf.setTextColor(255, 255, 255);
    b.pdf.setFont("helvetica", "bold");
    b.pdf.setFontSize(13);
    b.pdf.text(String(c.score), cx, b.y + 8, { align: "center" });
    b.pdf.setFontSize(6.5);
    b.pdf.setFont("helvetica", "normal");
    b.pdf.text(c.label, cx, b.y + 13.5, { align: "center" });
  });
  b.y += 20;
  b.spacer(4);
}

function renderDocSize(b: PdfBuilder, docSize: AuditReportData["docSize"]) {
  b.ensureSpace(20);
  b.font(11, "bold");
  b.color(15, 23, 42).writeLine("Document Size & Markup Density", M, 6);
  b.hrule();

  const lines: string[] = [
    `File size: ${(docSize.size / 1000).toFixed(1)} KB`,
    ...(docSize.visibleTextChars != null
      ? [`Visible text: ${docSize.visibleTextChars.toLocaleString()} chars`]
      : []),
    ...(docSize.htmlToTextRatio != null
      ? [`HTML-to-text ratio: ${docSize.htmlToTextRatio.toFixed(2)} — markup bytes (incl. tags, excl. scripts/CSS/JSON) per visible text char`]
      : []),
    ...(docSize.jsToTextRatio != null
      ? [`JS (imimg.com, incl. packages) ratio: ${docSize.jsToTextRatio.toFixed(2)} — ${docSize.jsFilesTotal ?? 0} files (${docSize.jsFilesPackage ?? 0} pkg), ${(docSize.jsChars ?? 0).toLocaleString()} chars`]
      : []),
    ...(docSize.jsToTextRatioApp != null
      ? [`JS (imimg.com, app only) ratio: ${docSize.jsToTextRatioApp.toFixed(2)} — excl. ${docSize.jsFilesPackage ?? 0} vendor/pkg bundle(s), ${(docSize.jsCharsApp ?? 0).toLocaleString()} chars`]
      : []),
    ...(docSize.cssToTextRatio != null
      ? [`CSS (imimg.com + inline) ratio: ${docSize.cssToTextRatio.toFixed(2)} — ${docSize.cssExtCount ?? 0} ext + ${docSize.cssInlineCount ?? 0} inline <style>, ${(docSize.cssChars ?? 0).toLocaleString()} chars total`]
      : []),
    ...(docSize.markupHtmlBytes != null
      ? [`Markup HTML (no JS/CSS/JSON): ${(docSize.markupHtmlBytes / 1000).toFixed(1)} KB`]
      : []),
  ];

  lines.forEach(line => {
    b.ensureSpace(5);
    b.font(9, "normal");
    b.color(51, 65, 85);
    b.writeLine(`• ${line}`, M + 2, 4.5);
  });

  if (docSize.recommendation) {
    b.spacer(2);
    b.ensureSpace(8);
    b.font(9, "bold");
    b.color(79, 70, 229).writeLine("Recommendation:", M + 2, 4.5);
    b.font(9, "normal");
    b.color(79, 70, 229);
    b.writeWrapped(docSize.recommendation, M + 2, CW - 4, 4.2);
  }
  b.spacer(5);
}

function renderBloatedSegments(b: PdfBuilder, segments: HtmlSegmentRatio[]) {
  if (!segments.length) return;

  b.ensureSpace(14);
  b.font(11, "bold");
  b.color(15, 23, 42).writeLine("Top HTML-to-Text Ratio Segments", M, 6);
  b.hrule();

  segments.forEach((seg, i) => {
    const [r, g, bl] =
      seg.ratio > 30 ? [220, 38, 38] :
      seg.ratio > 15 ? [234, 88, 12] :
      [202, 138, 4];

    b.ensureSpace(12);
    b.font(8.5, "bold");
    b.color(r, g, bl);
    b.writeWrapped(
      `${i + 1}. <${seg.tagName}>  ratio: ${seg.ratio.toFixed(2)}  |  ${seg.markupBytes.toLocaleString()} markup bytes · ${seg.visibleChars.toLocaleString()} text chars`,
      M + 2, CW - 4, 4.2
    );

    const snippet = seg.snippet.length > 450 ? seg.snippet.slice(0, 450) + "…" : seg.snippet;
    const snipLines = b.pdf.splitTextToSize(snippet, CW - 6);
    const blockH = snipLines.length * 3.2 + 4;
    b.ensureSpace(blockH);
    b.fillRect(M, b.y - 1, CW, blockH, 241, 245, 249);
    b.pdf.setFont("courier", "normal");
    b.pdf.setFontSize(6.5);
    b.pdf.setTextColor(30, 41, 59);
    b.pdf.text(snipLines, M + 2, b.y + 1.5);
    b.y += blockH + 1;
    b.spacer(3);
  });

  b.spacer(3);
}

function renderUnusedResources(b: PdfBuilder, docSize: AuditReportData["docSize"]) {
  // Deduplicate by URL (same logic as the UI table)
  const seen = new Set<string>();
  const cssRows = (docSize.unusedCss ?? []).filter(e => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });
  if (cssRows.length === 0) return;

  b.ensureSpace(14);
  b.font(11, "bold");
  b.color(15, 23, 42).writeLine("Unused CSS (imimg.com)", M, 6);
  b.hrule();

  b.font(8.5, "normal");
  b.color(120, 53, 15);
  b.writeWrapped(
    "Playwright browser coverage — CSS bytes loaded but never applied during the page visit.",
    M + 2, CW - 4, 4.2
  );
  b.spacer(3);

  // Column positions: File | Total | Unused | %
  const COL = [M, M + 95, M + 120, M + 148];

  // Header row
  b.ensureSpace(6);
  b.fillRect(M, b.y - 0.5, CW, 5.5, 255, 237, 213);
  b.font(8, "bold"); b.color(120, 53, 15);
  b.pdf.text("File",   COL[0] + 2, b.y + 3.5);
  b.pdf.text("Total",  COL[1],     b.y + 3.5, { align: "right" });
  b.pdf.text("Unused", COL[2],     b.y + 3.5, { align: "right" });
  b.pdf.text("%",      COL[3],     b.y + 3.5, { align: "right" });
  b.y += 6;

  for (const row of cssRows) {
    b.ensureSpace(5);
    const filename = (row.url.split("/").pop() ?? row.url).split("?")[0].slice(0, 48);
    // Match UI colour thresholds: ≥90% red, ≥70% orange, else yellow
    const [r, g, bl] =
      row.unusedPct >= 90 ? [220, 38,  38] as const :
      row.unusedPct >= 70 ? [234, 88,  12] as const :
                            [202, 138,  4] as const;

    b.font(7.5, "normal", "courier"); b.color(30, 41, 59);
    b.pdf.text(filename, COL[0] + 2, b.y + 3);
    b.pdf.text(`${(row.totalChars  / 1000).toFixed(1)} KB`, COL[1], b.y + 3, { align: "right" });
    b.pdf.text(`${(row.unusedChars / 1000).toFixed(1)} KB`, COL[2], b.y + 3, { align: "right" });
    b.pdf.setFont("helvetica", "bold"); b.pdf.setTextColor(r, g, bl);
    b.pdf.text(`${row.unusedPct}%`, COL[3], b.y + 3, { align: "right" });
    b.y += 4.5;
  }

  b.spacer(5);
}

function renderCriterion(
  b: PdfBuilder,
  title: string,
  result: CriterionResult
) {
  b.newPage();

  // ── Criterion header bar ─────────────────────────────────────────────────
  const [r, g, bl] = scoreRgb(result.score);
  b.fillRect(M, b.y, CW, 14, r, g, bl, 2);
  b.pdf.setTextColor(255, 255, 255);
  b.pdf.setFont("helvetica", "bold");
  b.pdf.setFontSize(13);
  b.pdf.text(title, M + 4, b.y + 9.5);
  b.pdf.setFontSize(17);
  b.pdf.text(String(result.score), PW - M - 4, b.y + 10, { align: "right" });
  b.y += 18;

  if (result.issues.length === 0) {
    b.font(10, "italic");
    b.color(22, 163, 74).writeLine("No issues found.", M + 2, 6);
    return;
  }

  const BADGE_W  = 15;   // badge width mm
  const BADGE_H  = 5.5;  // badge height mm
  const INDENT   = M + BADGE_W + 3; // text x after badge
  const TXTW     = CW - BADGE_W - 3; // available text width

  result.issues.forEach((issue, idx) => {
    const [ir, ig, ib] = SEVERITY_RGB[issue.severity] ?? [0, 0, 0];
    const tag = SEVERITY_TAG[issue.severity] ?? issue.severity.toUpperCase();

    // ── Issue title ────────────────────────────────────────────────────────
    b.pdf.setFont("helvetica", "bold");
    b.pdf.setFontSize(9);
    const issueLines = b.pdf.splitTextToSize(`${idx + 1}.  ${issue.issue}`, TXTW);
    const titleH = Math.max(issueLines.length * 4.2, BADGE_H);
    b.ensureSpace(titleH + 3);

    // Badge — vertically centred on first text line
    b.fillRect(M, b.y, BADGE_W, BADGE_H, ir, ig, ib, 1);
    b.pdf.setTextColor(255, 255, 255);
    b.pdf.setFont("helvetica", "bold");
    b.pdf.setFontSize(6.5);
    b.pdf.text(tag, M + BADGE_W / 2, b.y + 3.6, { align: "center" });

    // Issue text to the right of the badge, baseline-aligned with its top
    b.pdf.setFont("helvetica", "bold");
    b.pdf.setFontSize(9);
    b.pdf.setTextColor(15, 23, 42);
    b.pdf.text(issueLines, INDENT, b.y + 3.8);
    b.y += titleH + 3; // gap after title

    // ── Recommendation ─────────────────────────────────────────────────────
    if (issue.recommendation) {
      b.pdf.setFont("helvetica", "bold");
      b.pdf.setFontSize(8);
      b.pdf.setTextColor(99, 102, 241);
      const recLines = b.pdf.splitTextToSize(issue.recommendation, CW - 14);
      b.ensureSpace(recLines.length * 4 + 6);
      b.pdf.text("Rec:", M + 2, b.y);
      b.pdf.setFont("helvetica", "normal");
      b.pdf.text(recLines, M + 12, b.y);
      b.y += recLines.length * 4 + 3; // gap after rec
    }

    // ── HTML Snippet ───────────────────────────────────────────────────────
    if (issue.htmlSnippet) {
      const snip = issue.htmlSnippet.length > 380
        ? issue.htmlSnippet.slice(0, 380) + "…"
        : issue.htmlSnippet;
      b.pdf.setFont("courier", "normal");
      b.pdf.setFontSize(6.5);
      const snipLines = b.pdf.splitTextToSize(snip, CW - 8);
      const blockH = snipLines.length * 3.3 + 5;
      b.ensureSpace(blockH + 3);

      // Background + border
      b.fillRect(M, b.y, CW, blockH, 255, 241, 242);
      b.pdf.setDrawColor(252, 165, 165);
      b.pdf.setLineWidth(0.3);
      b.pdf.rect(M, b.y, CW, blockH);

      b.pdf.setTextColor(185, 28, 28);
      b.pdf.text(snipLines, M + 3, b.y + 3.5);
      b.y += blockH + 2; // gap after snippet
    }

    // ── Divider between issues ─────────────────────────────────────────────
    b.spacer(2);
    if (idx < result.issues.length - 1) {
      b.ensureSpace(4);
      b.pdf.setDrawColor(226, 232, 240);
      b.pdf.setLineWidth(0.25);
      b.pdf.line(M, b.y, PW - M, b.y);
      b.spacer(4);
    }
  });
}

// ── public entry ───────────────────────────────────────────────────────────

export function downloadAuditPdf(report: AuditReportData, url: string) {
  const b = new PdfBuilder();

  renderHeader(b, url);
  renderOverallScore(b, report.overallScore);
  renderScoreSummary(b, [
    { label: "LLM-Friendly",  score: report.llmFriendly.score },
    { label: "W3C Compliance", score: report.w3cCompliance.score },
    { label: "SEO",            score: report.seo.score },
    { label: "Semantic HTML",  score: report.semanticHtml.score },
    { label: "Accessibility",  score: report.accessibility.score },
  ]);
  renderDocSize(b, report.docSize);

  if (report.docSize.topBloatedSegments?.length) {
    renderBloatedSegments(b, report.docSize.topBloatedSegments);
  }
  renderUnusedResources(b, report.docSize);

  const criteriaSections: [string, CriterionResult][] = [
    ["LLM-Friendly HTML",       report.llmFriendly],
    ["W3C Compliance",          report.w3cCompliance],
    ["SEO Optimisation",        report.seo],
    ["Semantic HTML",           report.semanticHtml],
    ["Accessibility (WCAG 2.1)", report.accessibility],
  ];

  for (const [title, result] of criteriaSections) {
    renderCriterion(b, title, result);
  }

  const slug = url.replace(/https?:\/\//i, "").replace(/[^\w.-]/g, "_").slice(0, 40);
  const date = new Date().toISOString().slice(0, 10);
  b.pdf.save(`audit-${slug}-${date}.pdf`);
}
