import {
  VORFLUX_API_BASE,
  UPSTREAM_POLL_INTERVAL_MS,
  BATCH_TIMEOUT_MS,
} from "../utils/config";
import { UpstreamError } from "../models";
import { sleep } from "../utils/async";

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
  // Only send the account key when the URL is on the Vorflux API host;
  // other hosts get an anonymous request (presigned URLs need no auth).
  let host: string;
  try {
    host = new URL(resultUrl).host;
  } catch {
    throw new UpstreamError("Batch result URL is invalid");
  }
  const isVorfluxHost = /\.vorflux\.com$/i.test(host);
  const attempts: Array<Record<string, string>> = isVorfluxHost
    ? [authHeaders(), {}]
    : [{}];
  for (const headers of attempts) {
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
  // Tolerate transient poll errors (network blips, gateway 5xx, bad JSON)
  // during long-running jobs before giving up.
  let transientFailures = 0;
  const MAX_TRANSIENT_FAILURES = 5;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new UpstreamError("Client aborted the request", 499);
    await sleep(UPSTREAM_POLL_INTERVAL_MS, signal);

    let state: BatchStatusResponse | null = null;
    try {
      const pollRes = await fetch(`${VORFLUX_API_BASE}/batch/${requestId}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      if (pollRes.ok) {
        state = (await pollRes.json()) as BatchStatusResponse;
        transientFailures = 0;
      } else if (pollRes.status >= 500 || pollRes.status === 429) {
        transientFailures++;
      } else {
        throw new UpstreamError(`Batch polling failed (${pollRes.status})`);
      }
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if (signal?.aborted) throw new UpstreamError("Client aborted the request", 499);
      transientFailures++;
    }
    if (!state) {
      if (transientFailures >= MAX_TRANSIENT_FAILURES) {
        throw new UpstreamError(
          "Batch polling failed repeatedly (transient upstream errors)"
        );
      }
      continue;
    }

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

