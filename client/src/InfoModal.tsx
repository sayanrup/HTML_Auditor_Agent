import { ExternalLink, X } from "lucide-react";

type InfoModalProps = {
  scmRepoUrl: string | null;
  isLoading?: boolean;
  onClose: () => void;
};

export default function InfoModal({
  scmRepoUrl,
  isLoading,
  onClose,
}: InfoModalProps) {
  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-lg text-gray-900">About</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-3">
          <p className="text-sm text-gray-600">
            Source repository for this deployment. This path contains the prompt used for the audit.
            .
          </p>
          {isLoading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : scmRepoUrl ? (
            <a
              href={scmRepoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-700 break-all"
            >
              {scmRepoUrl}
              <ExternalLink className="w-4 h-4 shrink-0" />
            </a>
          ) : (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              No repository URL is configured. Add{" "}
              <code className="text-xs">SCM_REPO_URL</code> to{" "}
              <code className="text-xs">.env</code> (server) or{" "}
              <code className="text-xs">VITE_SCM_REPO_URL</code> for the client,
              then restart the dev server.
            </p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm text-white font-medium transition shadow-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
