import path from "path";
import { config } from "dotenv";

/** Load `.env` from the repo root so `SCM_REPO_URL` and friends work even when `cwd` is not the project directory. */
config({
  path: path.resolve(import.meta.dirname, "..", "..", ".env"),
});
