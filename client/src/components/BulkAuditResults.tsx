import { useState, useEffect } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Loader2, Clock, ChevronDown, ExternalLink } from "lucide-react";
import AuditResults from "@/components/AuditResults";

export interface BulkItem {
  url: string;
  status: "pending" | "running" | "done" | "failed";
  result?: any;
  error?: string;
}

interface BulkAuditResultsProps {
  items: BulkItem[];
  totalUrls: number;
  completedUrls: number;
  jobDone: boolean;
}

function StatusIcon({ status }: { status: BulkItem["status"] }) {
  switch (status) {
    case "done":    return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
    case "failed":  return <XCircle      className="h-4 w-4 text-red-500 shrink-0" />;
    case "running": return <Loader2      className="h-4 w-4 text-blue-500 animate-spin shrink-0" />;
    default:        return <Clock        className="h-4 w-4 text-slate-400 shrink-0" />;
  }
}

function scoreBg(score: number) {
  if (score >= 80) return "bg-green-500";
  if (score >= 60) return "bg-yellow-500";
  if (score >= 40) return "bg-orange-500";
  return "bg-red-500";
}

function BulkItemRow({ item, index, autoOpen }: { item: BulkItem; index: number; autoOpen: boolean }) {
  const [open, setOpen] = useState(false);

  // Auto-open the first completed item
  useEffect(() => {
    if (autoOpen && item.status === "done") setOpen(true);
  }, [autoOpen, item.status]);

  const hostname = (() => {
    try { return new URL(item.url).hostname; } catch { return item.url; }
  })();

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={`flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors select-none
            ${item.status === "done"   ? "bg-green-50  border-green-200  hover:bg-green-100"  : ""}
            ${item.status === "failed" ? "bg-red-50    border-red-200    hover:bg-red-100"    : ""}
            ${item.status === "running"? "bg-blue-50   border-blue-200"                       : ""}
            ${item.status === "pending"? "bg-slate-50  border-slate-200"                      : ""}
          `}
        >
          <span className="text-xs font-mono text-slate-500 w-6 text-right shrink-0">{index + 1}.</span>
          <StatusIcon status={item.status} />

          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">{hostname}</p>
            <p className="text-xs text-slate-500 truncate">{item.url}</p>
          </div>

          {item.status === "done" && item.result && (
            <span className={`${scoreBg(item.result.overallScore)} text-white text-xs font-bold rounded-full px-2.5 py-1 shrink-0`}>
              {item.result.overallScore}
            </span>
          )}
          {item.status === "failed" && (
            <Badge variant="outline" className="text-xs text-red-600 border-red-300 shrink-0">failed</Badge>
          )}
          {item.status === "running" && (
            <span className="text-xs text-blue-600 font-medium shrink-0">auditing…</span>
          )}
          {item.status === "pending" && (
            <span className="text-xs text-slate-400 shrink-0">queued</span>
          )}

          {item.status === "done" && (
            <ChevronDown className={`h-4 w-4 text-slate-500 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
          )}
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-2 mb-4">
          {item.status === "done" && item.result && (
            <div className="border border-slate-200 rounded-lg p-4 bg-white">
              <div className="flex items-center gap-2 mb-4">
                <ExternalLink className="h-4 w-4 text-slate-500" />
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline truncate"
                >
                  {item.url}
                </a>
              </div>
              <AuditResults report={item.result} auditUrl={item.url} />
            </div>
          )}
          {item.status === "failed" && (
            <div className="border border-red-200 rounded-lg p-4 bg-red-50">
              <p className="text-sm font-semibold text-red-800 mb-1">Audit failed</p>
              <pre className="text-xs text-red-700 whitespace-pre-wrap break-all font-mono bg-red-100/60 rounded p-2 overflow-auto max-h-32">
                {item.error ?? "Unknown error"}
              </pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function BulkAuditResults({ items, totalUrls, completedUrls, jobDone }: BulkAuditResultsProps) {
  const doneCount   = items.filter((i) => i.status === "done").length;
  const failedCount = items.filter((i) => i.status === "failed").length;
  const pct = totalUrls > 0 ? Math.round((completedUrls / totalUrls) * 100) : 0;

  return (
    <div className="space-y-3">
      {/* Progress header */}
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-slate-700">
          {jobDone ? "Bulk audit complete" : "Auditing in progress…"}
        </span>
        <span className="text-slate-500">
          {completedUrls} / {totalUrls} &nbsp;·&nbsp;
          <span className="text-green-600">{doneCount} done</span>
          {failedCount > 0 && <span className="text-red-500 ml-2">{failedCount} failed</span>}
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-slate-200 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all duration-500 ${jobDone ? "bg-green-500" : "bg-blue-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* URL rows */}
      <div className="space-y-2">
        {items.map((item, i) => (
          <BulkItemRow
            key={item.url}
            item={item}
            index={i}
            autoOpen={i === 0}
          />
        ))}
      </div>
    </div>
  );
}
