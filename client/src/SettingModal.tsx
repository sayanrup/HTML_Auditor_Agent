import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

type Config = {
  llm_api_key?: string;
  llm_model?: string;
};

type FormState = {
  llm_api_key: string;
  llm_model: string;
};

type SettingsModalProps = {
  config?: Config;
  onSave: (form: FormState) => Promise<void> | void;
  onClose: () => void;
};

export default function SettingsModal({
  config,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [form, setForm] = useState<FormState>({
    llm_api_key: "",
    llm_model: "openai/gpt-4.1",
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useRef(true);

  // Prevent state update after unmount
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  // Sync config → form (fixes stale modal data)
  useEffect(() => {
    if (config) {
      setForm({
        llm_api_key: config.llm_api_key || "",
        llm_model: config.llm_model || "openai/gpt-4.1",
      });
    }
  }, [config]);

  const update = (key: keyof FormState, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const validate = (): string | null => {
    if (!form.llm_model.trim()) return "Model is required";
    if (!form.llm_api_key.trim()) return "API key is required";
    return null;
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    try {
      setSaving(true);
      setError(null);

      await onSave(form);

      // Only close if save succeeds
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to save settings");
    } finally {
      if (isMounted.current) {
        setSaving(false);
      }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-auto shadow-xl">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-lg text-gray-900">Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 font-medium mb-1">
                LLM Model
              </label>
              <input
                type="text"
                value={form.llm_model}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  update("llm_model", e.target.value)
                }
                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                placeholder="openai/gpt-4.1"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 font-medium mb-1">
                LLM API Key
              </label>
              <input
                type="password"
                value={form.llm_api_key}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  update("llm_api_key", e.target.value)
                }
                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                placeholder="sk-..."
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-700 transition disabled:opacity-50"
          >
            Cancel
          </button>

          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm text-white font-medium transition disabled:opacity-50 shadow-sm"
          >
            {saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}