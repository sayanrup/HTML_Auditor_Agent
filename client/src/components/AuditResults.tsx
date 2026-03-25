import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertCircle, CheckCircle2, AlertTriangle, Info, ChevronDown } from "lucide-react";
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

interface AuditReportData {
  overallScore: number;
  llmFriendly: CriterionResult;
  w3cCompliance: CriterionResult;
  seo: CriterionResult;
  semanticHtml: CriterionResult;
  accessibility: CriterionResult;
}

interface AuditResultsProps {
  report: AuditReportData;
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
                <span>No issues found! This criterion is fully optimized.</span>
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
                      <span className="font-semibold">Recommendation:</span> {issue.recommendation}
                    </p>
                    <p className="text-sm text-slate-600 mt-2">
                      <span className="font-semibold">htmlSnippet:</span> {issue.htmlSnippet}
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

export default function AuditResults({ report }: AuditResultsProps) {
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
        </CardContent>
      </Card>
    </div>
  );
}
