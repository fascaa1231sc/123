import {
  VORFLUX_API_BASE,
  UPSTREAM_POLL_INTERVAL_MS,
  BATCH_TIMEOUT_MS,
} from "../utils/config";
import { UpstreamError } from "../models";

/**
 * Non-streaming provider: Vorflux AI Cloud Batch API.
 *
 * Runs a one-off prompt against a model without creating a full agent
 * session: `POST /api/v1/batch` then poll `GET /api/v1/batch/{id}` and fetch
 * `resultUrl` for the full text.
 */

export class BatchPermissionError extends Error {
  constructor() {
    super("The upstream API key lacks batch permissions");
  }
}

interface BatchStatusResponse {
  requestId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  resultUrl?: string;
  resultPreview?: string;
  errorMessage?: string;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.VORFLUX_API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function fetchResultText(resultUrl: string): Promise<string> {
  // Try authorized first, then the raw (possibly presigned) URL.
  for (const headers of [authHeaders(), {}]) {
    try {
      const res = await fetch(resultUrl, {
        headers,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const text = await res.text();
        // Some backends wrap the result in JSON.
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object") {
            for (const key of ["result", "content", "text", "output"]) {
              if (typeof parsed[key] === "string") return parsed[key];
            }
          }
        } catch {
          /* plain text */
        }
        return text;
      }
    } catch {
      /* try next mode */
    }
  }
  throw new UpstreamError("Failed to download the batch result");
}

export interface BatchResult {
  content: string;
}

export async function runBatchCompletion(
  prompt: string,
  model: string,
  signal?: AbortSignal
): Promise<BatchResult> {
  let createRes: Response;
  try {
    createRes = await fetch(`${VORFLUX_API_BASE}/batch`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt, model }),
      signal: signal || AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new UpstreamError(
      `Failed to submit batch request: ${(err as Error).message}`
    );
  }

  const createBody = (await createRes.json().catch(() => ({}))) as {
    requestId?: string;
    error?: string;
  };
  if (createRes.status === 401 || createRes.status === 403) {
    throw new BatchPermissionError();
  }
  if (!createRes.ok || !createBody.requestId) {
    throw new UpstreamError(
      `Batch request rejected (${createRes.status}): ${createBody.error || "unknown error"}`
    );
  }

  const requestId: string = createBody.requestId;
  const deadline = Date.now() + BATCH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new UpstreamError("Client aborted the request", 499);
    await sleep(UPSTREAM_POLL_INTERVAL_MS, signal);

    let pollRes: Response;
    try {
      pollRes = await fetch(`${VORFLUX_API_BASE}/batch/${requestId}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (signal?.aborted) throw new UpstreamError("Client aborted the request", 499);
      throw new UpstreamError(`Batch polling failed: ${(err as Error).message}`);
    }
    if (!pollRes.ok) {
      throw new UpstreamError(`Batch polling failed (${pollRes.status})`);
    }
    const state = (await pollRes.json()) as BatchStatusResponse;

    if (state.status === "COMPLETED") {
      let content = "";
      if (state.resultUrl) {
        try {
          content = await fetchResultText(state.resultUrl);
        } catch {
          content = state.resultPreview || "";
        }
      } else {
        content = state.resultPreview || "";
      }
      if (!content) {
        throw new UpstreamError("Batch completed but returned an empty result");
      }
      return { content };
    }
    if (state.status === "FAILED") {
      throw new UpstreamError(
        `Upstream batch request failed: ${state.errorMessage || "unknown error"}`
      );
    }
  }
  throw new UpstreamError("Batch request timed out", 504);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(t);
      reject(new UpstreamError("Client aborted the request", 499));
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
