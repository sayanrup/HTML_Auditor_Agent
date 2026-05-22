import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertCircle, CheckCircle2, AlertTriangle, Info, ChevronDown, GitBranch, Code2, FileDown } from "lucide-react";
import { downloadAuditPdf } from "@/lib/generatePdf";
import { Button } from "@/components/ui/button";
import { useState } from "react";

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

interface docResult {
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
}

interface AuditReportData {
  overallScore: number;
  llmFriendly: CriterionResult;
  w3cCompliance: CriterionResult;
  seo: CriterionResult;
  semanticHtml: CriterionResult;
  accessibility: CriterionResult;
  docSize: docResult;
}

const DIR_FIX_BRANCH = "html-audit-suggestion";

interface AuditResultsProps {
  report: AuditReportData;
  auditUrl?: string;
  dirRepoReady?: boolean;
  dirFixPending?: boolean;
  onApplyDirFixes?: () => void;
}

function getScoreColor(score: number): string {
  if (score >= 80) return "bg-green-100 text-green-900";
  if (score >= 60) return "bg-yellow-100 text-yellow-900";
  if (score >= 40) return "bg-orange-100 text-orange-900";
  return "bg-red-100 text-red-900";
}

function getScoreBadgeColor(score: number): string {
  if (score >= 80) return "bg-green-500";
  if (score >= 60) return "bg-yellow-500";
  if (score >= 40) return "bg-orange-500";
  return "bg-red-500";
}

function getSeverityIcon(severity: string) {
  switch (severity) {
    case "error":
      return <AlertCircle className="h-4 w-4 text-red-500" />;
    case "warning":
      return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
    case "info":
      return <Info className="h-4 w-4 text-blue-500" />;
    default:
      return null;
  }
}

function CriterionCard({
  title,
  description,
  score,
  issues,
}: {
  title: string;
  description: string;
  score: number;
  issues: Issue[];
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Card className="overflow-hidden">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <div className={`p-4 cursor-pointer hover:opacity-90 transition-opacity ${getScoreColor(score)}`}>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <h3 className="font-semibold text-lg">{title}</h3>
                <p className="text-sm opacity-75">{description}</p>
              </div>
              <div className="flex items-center gap-3">
                <div className={`${getScoreBadgeColor(score)} text-white rounded-full w-16 h-16 flex items-center justify-center font-bold text-xl`}>
                  {score}
                </div>
                <ChevronDown
                  className={`h-5 w-5 transition-transform ${isOpen ? "rotate-180" : ""}`}
                />
              </div>
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-4 pb-4">
            {issues.length === 0 ? (
              <div className="flex items-center gap-2 text-green-700 bg-green-50 p-3 rounded">
                <CheckCircle2 className="h-5 w-5" />
                <span>
                  {score >= 95
                    ? "No issues found! This criterion is fully optimized."
                    : "No specific issues identified — score reflects the LLM's overall assessment of structural quality, not a list of defects."}
                </span>
              </div>
            ) : (
              <div className="space-y-3">
                {issues.map((issue, idx) => (
                  <div key={idx} className="border-l-4 border-slate-200 pl-4 py-2">
                    <div className="flex items-start gap-2 mb-1">
                      {getSeverityIcon(issue.severity)}
                      <div>
                        <p className="font-medium text-sm text-slate-900">{issue.issue}</p>
                        <Badge variant="outline" className="mt-1 text-xs">
                          {issue.severity}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-sm text-slate-600 mt-2">
                      <span className="font-semibold" style={{ color: '#6666ff' }}>Recommendation:</span>
<span style={{ color: '#6666ff' }}>{issue.recommendation}</span>
                    </p>
                    <p className="text-sm text-slate-600 mt-2">
                      <span className="font-semibold" style={{ color: '#ff6666' }}>htmlSnippet:</span>
<span style={{ color: '#ff6666' }}>{issue.htmlSnippet}</span>
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function ratioColor(ratio: number): string {
  if (ratio > 30) return "text-red-700 font-bold";
  if (ratio > 15) return "text-orange-600 font-semibold";
  if (ratio > 5)  return "text-yellow-700 font-semibold";
  return "text-green-700";
}

function RatioRow({ label, sizeLabel, ratio, notes }: {
  label: string;
  sizeLabel: string;
  ratio: number;
  notes: string;
}) {
  return (
    <tr className="border-t border-yellow-200/60 odd:bg-yellow-50/40 even:bg-transparent">
      <td className="px-3 py-2 text-yellow-900">{label}</td>
      <td className="px-3 py-2 text-right font-mono text-yellow-900">{sizeLabel}</td>
      <td className={`px-3 py-2 text-right font-mono ${ratioColor(ratio)}`}>
        {ratio.toFixed(2)}
      </td>
      <td className="px-3 py-2 text-xs text-yellow-800/80">{notes}</td>
    </tr>
  );
}

function BloatedSegmentRow({ rank, seg }: { rank: number; seg: HtmlSegmentRatio }) {
  const [open, setOpen] = useState(false);
  const ratioColor =
    seg.ratio > 30 ? "text-red-700 bg-red-100" :
    seg.ratio > 15 ? "text-orange-700 bg-orange-100" :
    "text-yellow-800 bg-yellow-100";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div className="flex items-center gap-2 cursor-pointer rounded border border-yellow-300 bg-yellow-50 px-3 py-2 hover:bg-yellow-100 transition-colors">
          <span className="text-xs font-bold text-yellow-800 w-4">{rank}.</span>
          <code className="text-xs font-mono text-slate-700">&lt;{seg.tagName}&gt;</code>
          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${ratioColor}`}>
            ratio {seg.ratio.toFixed(2)}
          </span>
          <span className="text-xs text-slate-500 ml-1">
            {seg.markupBytes.toLocaleString()} markup bytes · {seg.visibleChars.toLocaleString()} text chars
          </span>
          <ChevronDown className={`h-3.5 w-3.5 ml-auto text-yellow-700 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 text-xs bg-slate-900 text-slate-100 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
          {seg.snippet}{seg.snippet.length >= 500 ? "\n…" : ""}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function AuditResults({
  report,
  auditUrl = "",
  dirRepoReady,
  dirFixPending,
  onApplyDirFixes,
}: AuditResultsProps) {
  const criteria = [
    {
      title: "LLM-Friendly HTML",
      description: "Content structure and readability for AI processing",
      score: report.llmFriendly.score,
      issues: report.llmFriendly.issues,
    },
    {
      title: "W3C Compliance",
      description: "HTML/CSS standards and web compliance",
      score: report.w3cCompliance.score,
      issues: report.w3cCompliance.issues,
    },
    {
      title: "SEO Optimization",
      description: "Search engine optimization and meta tags",
      score: report.seo.score,
      issues: report.seo.issues,
    },
    {
      title: "Semantic HTML",
      description: "Proper use of HTML5 semantic elements",
      score: report.semanticHtml.score,
      issues: report.semanticHtml.issues,
    },
    {
      title: "Accessibility",
      description: "WCAG compliance and accessibility standards",
      score: report.accessibility.score,
      issues: report.accessibility.issues,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Download PDF */}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          className="gap-2 border-slate-300 text-slate-700 hover:bg-slate-50"
          onClick={() => downloadAuditPdf(report, auditUrl)}
        >
          <FileDown className="w-4 h-4" />
          Download Result
        </Button>
      </div>

      {/* {onApplyDirFixes && (
        <Card className="border border-indigo-200 bg-indigo-50/60">
          <CardContent className="pt-4 pb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <p className="font-medium text-slate-900">Apply fixes to repo</p>
              <p className="text-sm text-slate-600 mt-1">
                Matches source by <strong>id</strong> and <strong>class</strong> / <strong>className</strong> first (dynamic pages), then data-*, href, and text. Creates branch{" "}
                <code className="text-xs">{DIR_FIX_BRANCH}</code> from{" "}
                <code className="text-xs">stage</code>, commits fixes, then pushes to{" "}
                <code className="text-xs">origin</code>.
              </p>
              {!dirRepoReady && (
                <p className="text-sm text-amber-800 mt-2">
                  DIR repo path is missing or not a git checkout. Set{" "}
                  <code className="text-xs">DIR_REPO_PATH</code> or clone{" "}
                  <code className="text-xs">dir-impcat-nodejs</code> next to this project.
                </p>
              )}
            </div>
            <Button
              type="button"
              disabled={!dirRepoReady || dirFixPending}
              onClick={onApplyDirFixes}
              className="shrink-0"
            >
              {dirFixPending ? (
                <>Applying…</>
              ) : (
                <>
                  <GitBranch className="w-4 h-4 mr-2 inline" />
                  Apply &amp; push
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )} */}

      {/* Overall Score */}
      <Card className="border-2">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Overall Score</CardTitle>
        </CardHeader>
        <CardContent className="text-center pb-8">
          <div className={`${getScoreBadgeColor(report.overallScore)} text-white rounded-full w-32 h-32 mx-auto flex items-center justify-center font-bold text-5xl mb-4`}>
            {report.overallScore}
          </div>
          <p className="text-slate-600">
            {report.overallScore >= 80
              ? "Excellent! Your page is well-optimized across all criteria."
              : report.overallScore >= 60
              ? "Good! There are some areas for improvement."
              : report.overallScore >= 40
              ? "Fair. Consider addressing the issues below."
              : "Needs significant improvements. Review the detailed feedback."}
          </p>
        </CardContent>
      </Card>

      {/* Criteria Breakdown */}
      <div>
        <h2 className="text-2xl font-bold text-slate-900 mb-4">Detailed Breakdown</h2>
        <div className="grid gap-4">
          <Card className="overflow-hidden bg-yellow-100 text-yellow-900">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Document size &amp; markup density</CardTitle>
              <CardDescription className="text-yellow-900/80">
                Page weight and how much HTML carries each unit of visible text.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0 pb-4">
              <div className="space-y-3">
                <div className="border-l-4 border-slate-200 pl-4 py-2">
                  <div className="text-sm text-yellow-900/70 mb-1">
                    Full page: <span className="font-semibold text-yellow-900">{(report.docSize.size / 1000).toFixed(1)} KB</span>
                    {report.docSize.visibleTextChars != null && (
                      <> &nbsp;·&nbsp; Visible text: <span className="font-semibold text-yellow-900">{report.docSize.visibleTextChars.toLocaleString()} chars</span></>
                    )}
                  </div>

                  {/* Ratio table */}
                  {report.docSize.htmlToTextRatio != null && (
                    <div className="overflow-x-auto mt-2">
                      <table className="w-full text-sm border-collapse">
                        <thead>
                          <tr className="bg-yellow-200/60 text-yellow-900">
                            <th className="text-left px-3 py-2 font-semibold rounded-tl">Metric</th>
                            <th className="text-right px-3 py-2 font-semibold">Size</th>
                            <th className="text-right px-3 py-2 font-semibold">Ratio&nbsp;<span className="font-normal text-xs opacity-75">(per text char)</span></th>
                            <th className="text-left px-3 py-2 font-semibold rounded-tr">Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          <RatioRow
                            label="HTML markup"
                            sizeLabel={`${((report.docSize.markupHtmlBytes ?? report.docSize.size) / 1000).toFixed(1)} KB`}
                            ratio={report.docSize.htmlToTextRatio}
                            notes="tags kept; excl. scripts, CSS, JSON-like blocks"
                          />
                          {report.docSize.jsToTextRatio != null && (
                            <RatioRow
                              label="JS (imimg.com, incl. packages)"
                              sizeLabel={`${(report.docSize.jsChars ?? 0).toLocaleString()} chars`}
                              ratio={report.docSize.jsToTextRatio}
                              notes={`${report.docSize.jsFilesTotal ?? 0} files (${report.docSize.jsFilesPackage ?? 0} pkg)`}
                            />
                          )}
                          {report.docSize.jsToTextRatioApp != null && (
                            <RatioRow
                              label="JS (imimg.com, app only)"
                              sizeLabel={`${(report.docSize.jsCharsApp ?? 0).toLocaleString()} chars`}
                              ratio={report.docSize.jsToTextRatioApp}
                              notes={`excl. ${report.docSize.jsFilesPackage ?? 0} vendor/pkg bundle(s)`}
                            />
                          )}
                          {report.docSize.cssToTextRatio != null && (
                            <RatioRow
                              label="CSS (imimg.com + inline)"
                              sizeLabel={`${(report.docSize.cssChars ?? 0).toLocaleString()} chars`}
                              ratio={report.docSize.cssToTextRatio}
                              notes={`${report.docSize.cssExtCount ?? 0} ext + ${report.docSize.cssInlineCount ?? 0} inline <style>`}
                            />
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <p className="text-sm text-slate-600 mt-3">
                    <span className="font-semibold" style={{ color: '#6666ff' }}>Recommendation:</span>
                    <span style={{ color: '#6666ff' }}> {report.docSize.recommendation}</span>
                  </p>
                </div>

                {report.docSize.topBloatedSegments && report.docSize.topBloatedSegments.length > 0 && (
                  <div className="mt-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Code2 className="h-4 w-4 text-yellow-700" />
                      <span className="font-semibold text-sm text-yellow-900">
                        Top {report.docSize.topBloatedSegments.length} highest HTML-to-text ratio segments
                      </span>
                    </div>
                    <div className="space-y-2">
                      {report.docSize.topBloatedSegments.map((seg, i) => (
                        <BloatedSegmentRow key={i} rank={i + 1} seg={seg} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
          {criteria.map((criterion, idx) => (
            <CriterionCard
              key={idx}
              title={criterion.title}
              description={criterion.description}
              score={criterion.score}
              issues={criterion.issues}
            />
          ))}
        </div>
      </div>

      {/* Unused CSS */}
      {(report.docSize.unusedCss?.length ?? 0) > 0 && (() => {
        // Deduplicate by URL (keep first occurrence — already sorted by most unused)
        const seen = new Set<string>();
        const uniqueCss = report.docSize.unusedCss!.filter(e => {
          if (seen.has(e.url)) return false;
          seen.add(e.url);
          return true;
        });
        return (
          <Card className="border border-orange-200 bg-orange-50/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg text-orange-900">Unused CSS (imimg.com)</CardTitle>
              <CardDescription className="text-orange-800/70">
                Playwright browser coverage — CSS bytes loaded but never applied during the page visit.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0 pb-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-orange-100 text-orange-900">
                      <th className="text-left px-3 py-1.5 font-semibold">File</th>
                      <th className="text-right px-3 py-1.5 font-semibold">Total</th>
                      <th className="text-right px-3 py-1.5 font-semibold">Unused</th>
                      <th className="text-right px-3 py-1.5 font-semibold">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uniqueCss.map((e, i) => {
                      const pct = e.unusedPct;
                      const cls = pct >= 90 ? "text-red-700 font-bold" : pct >= 70 ? "text-orange-600 font-semibold" : "text-yellow-700";
                      const filename = e.url.split("/").pop()?.split("?")[0] ?? e.url;
                      return (
                        <tr key={i} className="border-t border-orange-200/60 odd:bg-orange-50/40">
                          <td className="px-3 py-1.5 font-mono text-xs text-slate-700 max-w-[320px] truncate" title={e.url}>{filename}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-600">{(e.totalChars / 1000).toFixed(1)} KB</td>
                          <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-600">{(e.unusedChars / 1000).toFixed(1)} KB</td>
                          <td className={`px-3 py-1.5 text-right font-mono text-xs ${cls}`}>{pct}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* Summary Statistics */}
      <Card>
        <CardHeader>
          <CardTitle>Summary Statistics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {criteria.map((criterion, idx) => (
              <div key={idx} className="text-center">
                <div className="text-2xl font-bold text-slate-900">{criterion.score}</div>
                <div className="text-xs text-slate-600 mt-1">{criterion.title}</div>
              </div>
            ))}
          </div>
          {report.docSize.htmlToTextRatio != null &&
            report.docSize.visibleTextChars != null && (
              <div className="mt-6 pt-6 border-t border-slate-200">
                <div className="text-sm font-semibold text-slate-800 mb-1">
                  Payload ratios vs visible text
                </div>
                <p className="text-xs text-slate-500 mb-3">
                  Full page: {(report.docSize.size / 1000).toFixed(1)} KB &nbsp;·&nbsp;
                  Visible text: {report.docSize.visibleTextChars.toLocaleString()} chars.
                  Ratio = resource bytes ÷ visible text chars; higher = heavier per unit of content.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-slate-100 text-slate-700">
                        <th className="text-left px-3 py-2 font-semibold">Metric</th>
                        <th className="text-right px-3 py-2 font-semibold">Size</th>
                        <th className="text-right px-3 py-2 font-semibold">Ratio&nbsp;<span className="font-normal text-xs opacity-60">(per text char)</span></th>
                        <th className="text-left px-3 py-2 font-semibold">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-slate-200 odd:bg-slate-50">
                        <td className="px-3 py-2 text-slate-800">HTML markup</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-800">
                          {((report.docSize.markupHtmlBytes ?? report.docSize.size) / 1000).toFixed(1)} KB
                        </td>
                        <td className={`px-3 py-2 text-right font-mono ${ratioColor(report.docSize.htmlToTextRatio)}`}>
                          {report.docSize.htmlToTextRatio.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500">tags kept; excl. scripts, CSS, JSON-like blocks</td>
                      </tr>
                      {report.docSize.jsToTextRatio != null && (
                        <tr className="border-t border-slate-200 even:bg-slate-50">
                          <td className="px-3 py-2 text-slate-800">JS (imimg.com, incl. packages)</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-800">
                            {(report.docSize.jsChars ?? 0).toLocaleString()} chars
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${ratioColor(report.docSize.jsToTextRatio)}`}>
                            {report.docSize.jsToTextRatio.toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500">
                            {report.docSize.jsFilesTotal ?? 0} files ({report.docSize.jsFilesPackage ?? 0} pkg)
                          </td>
                        </tr>
                      )}
                      {report.docSize.jsToTextRatioApp != null && (
                        <tr className="border-t border-slate-200 odd:bg-slate-50">
                          <td className="px-3 py-2 text-slate-800">JS (imimg.com, app only)</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-800">
                            {(report.docSize.jsCharsApp ?? 0).toLocaleString()} chars
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${ratioColor(report.docSize.jsToTextRatioApp)}`}>
                            {report.docSize.jsToTextRatioApp.toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500">
                            excl. {report.docSize.jsFilesPackage ?? 0} vendor/pkg bundle(s)
                          </td>
                        </tr>
                      )}
                      {report.docSize.cssToTextRatio != null && (
                        <tr className="border-t border-slate-200 odd:bg-slate-50">
                          <td className="px-3 py-2 text-slate-800">CSS (imimg.com + inline)</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-800">
                            {(report.docSize.cssChars ?? 0).toLocaleString()} chars
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${ratioColor(report.docSize.cssToTextRatio)}`}>
                            {report.docSize.cssToTextRatio.toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500">
                            {report.docSize.cssExtCount ?? 0} ext + {report.docSize.cssInlineCount ?? 0} inline &lt;style&gt;
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
        </CardContent>
      </Card>
    </div>
  );
}
