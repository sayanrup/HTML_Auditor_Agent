import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Settings, Info } from "lucide-react";
import { toast } from "sonner";
import AuditResults from "@/components/AuditResults";
import SettingsModal from "@/SettingModal";

type Config = {
  llm_api_key?: string;
  llm_model?: string;
};

export default function AuditPage() {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [auditReport, setAuditReport] = useState<any>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const performAuditMutation = trpc.audit.performAudit.useMutation({
    onSuccess: (data) => {
      setAuditReport(data);
      setIsLoading(false);
      toast.success("Audit completed successfully!");
    },
    onError: (error) => {
      setIsLoading(false);
      toast.error(error.message || "Failed to perform audit");
    },
  });

  const handleAudit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url.trim()) {
      toast.error("Please enter a URL");
      return;
    }

    if (!config?.llm_api_key || !config?.llm_model) {
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
    performAuditMutation.mutate({ url , llm_api_key: config!.llm_api_key!, llm_model: config!.llm_model!});
  };

  const handleSaveConfig = async (newCfg: Config) => {
    try {
      setConfig(newCfg);
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

          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg hover:bg-gray-100 transition text-gray-700 hover:text-gray-900"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>

        {/* Audit Form */}
        <Card className="mb-8 shadow-lg">
          <CardHeader>
            <CardTitle>Audit a Page</CardTitle>
            <CardDescription>Enter a URL to start the comprehensive audit</CardDescription>
          </CardHeader>
          <CardContent>
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
                    Auditing...
                  </>
                ) : (
                  "Audit"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Results */}
        {auditReport && <AuditResults report={auditReport} />}

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
