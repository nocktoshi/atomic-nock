/**
 * Runtime-agnostic env access. The web app runs under Vite (`import.meta.env`,
 * statically injected); the solver daemon runs under Node (`process.env`). Both
 * use the same VITE_-prefixed names so one .env file serves both runtimes.
 */

type EnvMap = Record<string, string | undefined>;

function viteEnv(): EnvMap | undefined {
  // Access defensively: under Vite `import.meta.env` is injected; under Node's
  // type context `import.meta` has no `env`, so reach it through a cast.
  return (import.meta as { env?: EnvMap }).env;
}

function nodeEnv(): EnvMap | undefined {
  // Reach process via globalThis so the web tsconfig needs no @types/node.
  const proc = (globalThis as { process?: { env?: EnvMap } }).process;
  return proc?.env;
}

/** Read an env var by name (Vite first, then process.env). */
export function readEnv(key: string): string | undefined {
  return viteEnv()?.[key] ?? nodeEnv()?.[key];
}

/** Production build (Vite PROD) or NODE_ENV=production under Node. */
export function isProd(): boolean {
  const vite = viteEnv();
  if (vite && (vite as { PROD?: unknown }).PROD != null) {
    return Boolean((vite as { PROD?: unknown }).PROD);
  }
  return nodeEnv()?.NODE_ENV === "production";
}

/** Dev server (Vite DEV) or non-production Node. */
export function isDev(): boolean {
  const vite = viteEnv();
  if (vite && vite.DEV != null) return Boolean(vite.DEV);
  return !isProd();
}
