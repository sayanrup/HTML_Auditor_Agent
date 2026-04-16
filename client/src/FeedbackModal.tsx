import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Loader2, X } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

type FeedbackModalProps = {
  onClose: () => void;
};

export default function FeedbackModal({ onClose }: FeedbackModalProps) {
  const [text, setText] = useState("");
  const utils = trpc.useUtils();

  const listQuery = trpc.feedback.list.useQuery(undefined, {
    staleTime: 30_000,
  });

  const submitMutation = trpc.feedback.submit.useMutation({
    onSuccess: async () => {
      setText("");
      toast.success("Feedback posted");
      await utils.feedback.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Could not save feedback");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message) {
      toast.error("Please enter feedback");
      return;
    }
    submitMutation.mutate({ message });
  };

  const items = listQuery.data ?? [];

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="font-semibold text-lg text-gray-900">Feedback</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 border-b border-gray-200 shrink-0">
          <form onSubmit={handleSubmit} className="space-y-3">
            <label className="block text-xs text-gray-500 font-medium">
              Share feedback (visible to everyone using this app)
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Suggestions, issues, or ideas…"
              disabled={submitMutation.isPending}
              className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 resize-y min-h-[96px] focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 disabled:opacity-50"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={submitMutation.isPending}
                className="inline-flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm text-white font-medium transition disabled:opacity-50 shadow-sm"
              >
                {submitMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Submit"
                )}
              </button>
            </div>
          </form>
        </div>

        <div className="px-6 py-4 flex-1 min-h-0 flex flex-col">
          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            All feedback
          </h3>
          {listQuery.isLoading ? (
            <div className="flex items-center justify-center py-12 text-gray-500 text-sm gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              Loading…
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">
              No feedback yet. Be the first to post.
            </p>
          ) : (
            <ul className="overflow-y-auto space-y-3 pr-1 max-h-[min(40vh,320px)]">
              {items.map((row) => (
                <li
                  key={row.id}
                  className="rounded-lg border border-gray-100 bg-gray-50/80 px-3 py-2.5"
                >
                  <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                    {row.message}
                  </p>
                  <p className="text-xs text-gray-400 mt-2">
                    {format(new Date(row.createdAt), "PPp")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:text-gray-800 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
