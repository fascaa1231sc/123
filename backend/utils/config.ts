import * as fs from "fs";
import * as path from "path";

/**
 * Minimal .env loader (no external dependency).
 * Looks for backend/.env then .env at the repo root. Does not override
 * variables that are already present in the process environment.
 */
function loadDotEnv(): void {
  const candidates = [
    path.join(__dirname, "..", "..", "backend", ".env"), // dist/ -> backend/.env
    path.join(process.cwd(), "backend", ".env"),
    path.join(process.cwd(), ".env"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (process.env[m[1]] !== undefined) continue; // real env wins
      let value = m[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  }
}

loadDotEnv();

export const PORT = parseInt(process.env.PORT || "8787", 10);
export const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
export const VORFLUX_API_KEY = process.env.VORFLUX_API_KEY || "";
export const VORFLUX_API_BASE =
  process.env.VORFLUX_API_BASE || "https://us1.vorflux.com/api/v1";

/** Default and maximum output tokens advertised to clients. */
export const MAX_OUTPUT_TOKENS = 64000;
/** Thinking budget (tokens) used for `-thinking` model variants. */
export const THINKING_BUDGET_TOKENS = 16000;
/** Upstream model list cache TTL (ms). */
export const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
/** Poll interval for upstream Batch / Sessions results (ms). */
export const UPSTREAM_POLL_INTERVAL_MS = 2000;
/** Hard timeouts for a single upstream completion (ms). */
export const BATCH_TIMEOUT_MS = 10 * 60 * 1000;
export const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
/** SSE keepalive heartbeat interval (ms) — keeps gateways from cutting the connection during extended thinking. */
export const SSE_KEEPALIVE_INTERVAL_MS = 5000;
