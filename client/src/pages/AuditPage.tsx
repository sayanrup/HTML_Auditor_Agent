import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import {
  loadAuditLlmSettings,
  saveAuditLlmSettings,
} from "@/lib/auditLlmSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Settings, Info, Bot, Code2, AlertCircle, X } from "lucide-react";
import { toast } from "sonner";
import AuditResults from "@/components/AuditResults";
import SettingsModal from "@/SettingModal";
import InfoModal from "@/InfoModal";
import FeedbackModal from "@/FeedbackModal";

type AuditMode = "ai" | "rules";

type Config = {
  llm_api_key?: string;
  llm_model?: string;
};

/** Vite only exposes env vars prefixed with `VITE_` to the client. Optional mirror of `SCM_REPO_URL`. */
const scmRepoUrlFromVite = import.meta.env.VITE_SCM_REPO_URL?.trim() || null;

export default function AuditPage() {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [auditReport, setAuditReport] = useState<any>(null);
  const [config, setConfig] = useState<Config | null>(() =>
    loadAuditLlmSettings()
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [auditMode, setAuditMode] = useState<AuditMode>("ai");
  const [auditError, setAuditError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);

  const publicInfoQuery = trpc.system.publicInfo.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });

  // Poll the running job every 2 s until done or failed
  const pollQuery = trpc.audit.pollJob.useQuery(
    { jobId: jobId! },
    {
      enabled: !!jobId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        if (status === "done" || status === "failed") return false;
        return 5000;
      },
    }
  );

  // React to poll results outside the query hook (tRPC v11 removed onSuccess/onError from useQuery)
  useEffect(() => {
    const data = pollQuery.data;
    if (!data) return;
    if (data.progress) setProgressMsg(data.progress);
    if (data.status === "done") {
      setAuditReport(data.result);
      setAuditError(null);
      setIsLoading(false);
      setJobId(null);
      setProgressMsg(null);
      toast.success("Audit completed successfully!");
    } else if (data.status === "failed") {
      const msg = data.error || "Audit failed";
      setAuditError(msg);
      setIsLoading(false);
      setJobId(null);
      setProgressMsg(null);
      toast.error(msg);
    }
  }, [pollQuery.data]);

  useEffect(() => {
    if (!pollQuery.error) return;
    const msg = pollQuery.error.message || "Failed to poll audit status";
    setAuditError(msg);
    setIsLoading(false);
    setJobId(null);
    setProgressMsg(null);
    toast.error(msg);
  }, [pollQuery.error]);

  const startAuditMutation = trpc.audit.startAudit.useMutation({
    onSuccess: ({ jobId: id }) => {
      setJobId(id);
      setProgressMsg("Starting audit…");
    },
    onError: (error) => {
      setIsLoading(false);
      const msg = error.message || "Failed to start audit";
      setAuditError(msg);
      toast.error(msg);
    },
  });

  const startRuleBasedAuditMutation = trpc.audit.startRuleBasedAudit.useMutation({
    onSuccess: ({ jobId: id }) => {
      setJobId(id);
      setProgressMsg("Starting audit…");
    },
    onError: (error) => {
      setIsLoading(false);
      const msg = error.message || "Failed to start rule-based audit";
      setAuditError(msg);
      toast.error(msg);
    },
  });

  const applyDirMutation = trpc.audit.applyRecommendationsToDir.useMutation({
    onSuccess: (data) => {
      const longToast = { duration: 30_000 } as const;

      if (data.pushed) {
        const msg = `Pushed branch "${data.branch}" (${data.issuesApplied} file change(s)).`;
        console.info("[DIR apply]", msg, data);
        toast.success(msg, longToast);
      } else {
        const msg = data.locationSummary
          ? `Nothing pushed. ${data.locationSummary}`
          : "No unique source match in DIR repo. Nothing committed or pushed.";
        console.info("[DIR apply]", msg, data);
        toast.message(msg, longToast);
      }
      if (data.skipped.length > 0) {
        const skipMsg = `${data.skipped.length} issue(s) skipped: ${data.skipped
          .map((s) => s.reason)
          .join(" | ")}`;
        console.info("[DIR apply]", skipMsg);
        toast.message(skipMsg, longToast);
      }
    },
    onError: (e) => {
      const msg = e.message || "DIR apply failed";
      console.error("[DIR apply]", msg, e);
      toast.error(msg, { duration: 30_000 });
    },
  });

  const handleAudit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url.trim()) {
      toast.error("Please enter a URL");
      return;
    }

    if (auditMode === "ai" && (!config?.llm_api_key || !config?.llm_model)) {
      toast.error("Please enter your API key and Model in top right settings");
      return;
    }

    // Basic URL validation
    try {
      new URL(url);
    } catch {
      toast.error("Please enter a valid URL (e.g., https://example.com)");
      return;
    }

    setIsLoading(true);
    setAuditError(null);
    setAuditReport(null);
    if (auditMode === "ai") {
      startAuditMutation.mutate({ url, llm_api_key: config!.llm_api_key!, llm_model: config!.llm_model! });
    } else {
      startRuleBasedAuditMutation.mutate({ url });
    }
  };

  const handleSaveConfig = async (newCfg: Config) => {
    try {
      setConfig(newCfg);
      saveAuditLlmSettings({
        llm_api_key: newCfg.llm_api_key ?? "",
        llm_model: newCfg.llm_model ?? "",
      });
      toast.success("Settings saved!");
    } catch (err: any) {
      toast.error(err?.message || "Error saving settings");
      throw err; // important → lets modal handle failure
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900 mb-2">
              Page Audit Agent
            </h1>
            <p className="text-lg text-slate-600">
              Analyze and score web pages on LLM-friendliness, W3C compliance,
              SEO, semantic HTML, and accessibility.
            </p>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setFeedbackOpen(true)}
              className="p-2 rounded-lg hover:bg-gray-100 transition opacity-90 hover:opacity-100"
              title="Feedback"
              aria-label="Feedback"
            >
              <img
                src={`${import.meta.env.BASE_URL}feedback-icon.png`}
                alt=""
                width={28}
                height={28}
                className="w-7 h-7 object-contain block"
                aria-hidden
              />
            </button>
            <button
              type="button"
              onClick={() => setInfoOpen(true)}
              className="p-2 rounded-lg hover:bg-gray-100 transition text-gray-700 hover:text-gray-900"
              title="Repository info"
              aria-label="Repository info"
            >
              <Info className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-lg hover:bg-gray-100 transition text-gray-700 hover:text-gray-900"
              title="Settings"
              aria-label="Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Audit Form */}
        <Card className="mb-8 shadow-lg">
          <CardHeader>
            <CardTitle>Audit a Page</CardTitle>
            <CardDescription>Enter a URL to start the comprehensive audit</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Mode toggle */}
            <div className="flex gap-2 p-1 bg-slate-100 rounded-lg w-fit">
              <button
                type="button"
                onClick={() => { setAuditMode("ai"); setAuditReport(null); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  auditMode === "ai"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                <Bot className="w-4 h-4" />
                AI Audit
              </button>
              <button
                type="button"
                onClick={() => { setAuditMode("rules"); setAuditReport(null); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  auditMode === "rules"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                <Code2 className="w-4 h-4" />
                Rule-based
              </button>
            </div>

            {auditMode === "rules" && (
              <p className="text-xs text-slate-500">
                Rule-based audit runs entirely on the server with no AI or API key required. Results are deterministic.
              </p>
            )}

            <form onSubmit={handleAudit} className="flex gap-2">
              <Input
                type="url"
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={isLoading}
                className="flex-1"
              />
              <Button type="submit" disabled={isLoading} className="px-6">
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {progressMsg ?? "Auditing..."}
                  </>
                ) : (
                  "Audit"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Error */}
        {auditError && (
          <Card className="mb-6 border border-red-300 bg-red-50">
            <CardContent className="pt-4 pb-4 flex gap-3 items-start">
              <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-red-800 mb-1">Audit failed</p>
                <pre className="text-xs text-red-700 whitespace-pre-wrap break-all font-mono bg-red-100/60 rounded p-2 overflow-auto max-h-48">
                  {auditError}
                </pre>
              </div>
              <button
                type="button"
                onClick={() => setAuditError(null)}
                className="shrink-0 text-red-400 hover:text-red-600 transition-colors"
                aria-label="Dismiss error"
              >
                <X className="h-4 w-4" />
              </button>
            </CardContent>
          </Card>
        )}

        {/* Results */}
        {auditReport && (
          <AuditResults
            report={auditReport}
            auditUrl={url}
            dirRepoReady={publicInfoQuery.data?.dirRepoReady}
            dirFixPending={applyDirMutation.isPending}
            onApplyDirFixes={() => {
              if (!config?.llm_api_key || !config?.llm_model) {
                toast.error("Add LLM API key and model in Settings first.");
                return;
              }
              applyDirMutation.mutate({
                report: auditReport,
                llm_api_key: config.llm_api_key,
                llm_model: config.llm_model,
                branchName: "html-audit-suggestion",
                auditedPageUrl: url.trim() || undefined,
              });
            }}
          />
        )}

        {/* Empty State */}
        {!auditReport && !isLoading && (
          <Card className="border-dashed">
            <CardContent className="pt-12 pb-12 text-center">
              <div className="text-slate-400 mb-4">
                <Info className="h-12 w-12 mx-auto" />
              </div>
              <p className="text-slate-600">Enter a URL above to begin auditing</p>
            </CardContent>
          </Card>
        )}

        {/* Settings Modal */}
        {infoOpen && (
          <InfoModal
            scmRepoUrl={
              publicInfoQuery.data?.scmRepoUrl ?? scmRepoUrlFromVite
            }
            isLoading={
              publicInfoQuery.isLoading && !scmRepoUrlFromVite
            }
            onClose={() => setInfoOpen(false)}
          />
        )}

        {feedbackOpen && (
          <FeedbackModal onClose={() => setFeedbackOpen(false)} />
        )}

        {settingsOpen && (
          <SettingsModal
            config={config || undefined}
            onSave={handleSaveConfig}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
