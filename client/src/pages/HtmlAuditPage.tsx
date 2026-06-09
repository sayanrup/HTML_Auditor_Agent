import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Bot, Code2, AlertCircle, X, Eye, EyeOff, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import AuditResults from "@/components/AuditResults";
import { loadAuditLlmSettings, saveAuditLlmSettings } from "@/lib/auditLlmSettings";

const OPENROUTER_MODELS = [
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1",
  "anthropic/claude-3.5-haiku",
  "anthropic/claude-3.7-sonnet",
  "google/gemini-2.0-flash-001",
];

const OPENROUTER_DOCS = "https://openrouter.ai/keys";

export default function HtmlAuditPage() {
  const [html, setHtml] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("openai/gpt-4.1-mini");
  const [showKey, setShowKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [auditReport, setAuditReport] = useState<any>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);

  // Load saved settings on mount
  useEffect(() => {
    const saved = loadAuditLlmSettings();
    if (saved?.llm_api_key) setApiKey(saved.llm_api_key);
    if (saved?.llm_model) setModel(saved.llm_model);
  }, []);

  // Persist key + model whenever they change
  useEffect(() => {
    saveAuditLlmSettings({ llm_api_key: apiKey, llm_model: model });
  }, [apiKey, model]);

  const useAi = apiKey.trim().length > 0;

  const pollQuery = trpc.audit.pollJob.useQuery(
    { jobId: jobId! },
    {
      enabled: !!jobId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        if (status === "done" || status === "failed") return false;
        return 3000;
      },
    }
  );

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
      toast.success("Audit complete!");
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

  const startMutation = trpc.audit.startHtmlDirectAudit.useMutation({
    onSuccess: ({ jobId: id }) => {
      setJobId(id);
      setProgressMsg(useAi ? "Running AI audit…" : "Running rule-based audit…");
    },
    onError: (err) => {
      setIsLoading(false);
      const msg = err.message || "Failed to start audit";
      setAuditError(msg);
      toast.error(msg);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!html.trim()) {
      toast.error("Paste some HTML first");
      return;
    }
    setIsLoading(true);
    setAuditError(null);
    setAuditReport(null);
    startMutation.mutate({
      html: html.trim(),
      llm_api_key: useAi ? apiKey.trim() : undefined,
      llm_model: useAi ? model.trim() : undefined,
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-slate-900">HTML Audit Agent</h1>
          </div>
          <p className="text-slate-600 ml-[52px]">
            Paste any HTML below. The agent audits it against LLM-friendliness, W3C compliance,
            SEO, semantic HTML, and accessibility rules.
          </p>
        </div>

        {/* OpenRouter config card */}
        <Card className="mb-5 border-indigo-100 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Bot className="w-4 h-4 text-indigo-500" />
                OpenRouter API Key
                <span className={`text-xs font-normal px-2 py-0.5 rounded-full ${
                  useAi
                    ? "bg-indigo-100 text-indigo-700"
                    : "bg-slate-100 text-slate-500"
                }`}>
                  {useAi ? "AI audit enabled" : "No key — rule-based audit"}
                </span>
              </CardTitle>
              <a
                href={OPENROUTER_DOCS}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-indigo-500 hover:text-indigo-700 flex items-center gap-1 transition-colors"
              >
                Get a key <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <CardDescription className="text-xs">
              Leave blank to run a deterministic rule-based audit with no API key required.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              {/* Key input */}
              <div className="relative flex-1">
                <Input
                  type={showKey ? "text" : "password"}
                  placeholder="sk-or-v1-… (optional)"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="pr-9 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Model selector */}
              <div className="w-64">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={!useAi}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                >
                  {OPENROUTER_MODELS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* HTML input card */}
        <Card className="mb-5 shadow-lg">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Code2 className="w-4 h-4 text-slate-500" />
              HTML to Audit
            </CardTitle>
            <CardDescription className="text-xs">
              Paste the full HTML of a page or any fragment you want audited.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-3">
              <textarea
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                disabled={isLoading}
                placeholder={"<!DOCTYPE html>\n<html lang=\"en\">\n  <head>…</head>\n  <body>…</body>\n</html>"}
                className="w-full h-72 rounded-md border border-input bg-slate-50 px-3 py-2.5 text-xs font-mono text-slate-800 placeholder-slate-300 shadow-sm resize-y focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                spellCheck={false}
              />

              <div className="flex items-center justify-between">
                {/* Mode badge */}
                <div className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium ${
                  useAi
                    ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                    : "bg-slate-100 text-slate-600 border border-slate-200"
                }`}>
                  {useAi ? (
                    <><Bot className="w-3.5 h-3.5" /> AI audit via OpenRouter</>
                  ) : (
                    <><Code2 className="w-3.5 h-3.5" /> Rule-based audit (no AI)</>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {html.trim() && (
                    <span className="text-xs text-slate-400">
                      {html.trim().length.toLocaleString()} chars
                    </span>
                  )}
                  <Button type="submit" disabled={isLoading || !html.trim()} className="px-6">
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {progressMsg ?? "Running…"}
                      </>
                    ) : (
                      "Audit HTML"
                    )}
                  </Button>
                </div>
              </div>
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
            auditUrl="Pasted HTML"
          />
        )}
      </div>
    </div>
  );
}
