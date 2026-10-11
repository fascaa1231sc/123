import { Response } from "express";

/** Standard SSE response headers (spec: no buffering at any proxy layer). */
export function setSSEHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

/** Write a raw string to the SSE stream and flush immediately. */
export function writeRaw(res: Response, data: string): boolean {
  if (res.writableEnded) return false;
  res.write(data);
  // Express (no compression middleware) writes straight to the socket;
  // call flush() when available anyway (compression interplay).
  const anyRes = res as unknown as { flush?: () => void };
  if (typeof anyRes.flush === "function") anyRes.flush();
  return true;
}

/** Write one SSE `data:` event containing a JSON payload. */
export function writeJSONEvent(res: Response, payload: unknown): boolean {
  return writeRaw(res, `data: ${JSON.stringify(payload)}\n\n`);
}

/** SSE comment heartbeat: `: ping` — invisible to EventSource clients. */
export function writePing(res: Response): boolean {
  return writeRaw(res, ": ping\n\n");
}

/** Start a keepalive heartbeat. Returns a stop function. */
export function startKeepalive(
  res: Response,
  intervalMs: number
): () => void {
  const timer = setInterval(() => {
    if (!writePing(res)) stop();
  }, intervalMs);
  function stop(): void {
    clearInterval(timer);
  }
  return stop;
}

/** Terminate the stream with the OpenAI-style `[DONE]` sentinel. */
export function finishSSE(res: Response): void {
  writeRaw(res, "data: [DONE]\n\n");
  res.end();
}
