/// <reference types="vite/client" />

/** Optional: same URL as SCM_REPO_URL, exposed to the browser (must use VITE_ prefix). */
interface ImportMetaEnv {
  readonly VITE_SCM_REPO_URL?: string;
}
