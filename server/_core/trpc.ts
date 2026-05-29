import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // Always forward the original error message to the client so UI can show
  // the exact LLM provider response, URL-fetch failure, etc.
  // Without this, tRPC replaces plain Error messages with "INTERNAL_SERVER_ERROR"
  // in non-development environments.
  errorFormatter({ shape, error }) {
    const msg =
      error.cause instanceof Error ? error.cause.message : error.message;
    return { ...shape, message: msg };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
