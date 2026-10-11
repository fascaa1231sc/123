import { Request, Response } from "express";
import * as crypto from "crypto";
import { ChatCompletionRequest, ChatMessage } from "../types";
import { resolveModel, UpstreamError } from "../models";
import { buildPrompt, estimateTokens } from "../utils/prompt";
import {
  setSSEHeaders,
  writeJSONEvent,
  startKeepalive,
  finishSSE,
} from "../utils/sse";
import { SSE_KEEPALIVE_INTERVAL_MS } from "../utils/config";
import { runBatchCompletion, BatchPermissionError } from "../providers/openai";
import { runSessionCompletion } from "../providers/anthropic";

const THINKING_OPEN = "<think>\n";
const THINKING_CLOSE = "\n</think>\n";

function errorResponse(
  res: Response,
  status: number,
  message: string,
  type = "invalid_request_error",
  code?: string
): void {
  res.status(status).json({ error: { message, type, code } });
}

function newCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** POST /v1/chat/completions — OpenAI-compatible chat endpoint. */
export async function chatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const body = req.body as ChatCompletionRequest;

  if (!body || typeof body !== "object") {
    return errorResponse(res, 400, "Request body must be a JSON object.");
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    return errorResponse(res, 400, "'model' is a required string field.");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(res, 400, "'messages' must be a non-empty array.");
  }
  for (const m of body.messages as ChatMessage[]) {
    if (!m || typeof m.role !== "string") {
      return errorResponse(res, 400, "Every message requires a 'role' field.");
    }
  }

  // Output token policy: default and maximum are 64000. The upstream API has
  // no max_tokens knob, so anything the client sends beyond 64000 has no
  // effect — 64000 is the advertised hard limit of this node.

  // Model resolution (validates against the live upstream catalog).
  let resolved;
  try {
    resolved = await resolveModel(body.model);
  } catch (err) {
    return errorResponse(
      res,
      502,
      `Failed to resolve model: ${(err as Error).message}`,
      "api_error"
    );
  }
  if (!resolved) {
    return errorResponse(
      res,
      404,
      `The model '${body.model}' does not exist or is not available on this node.`,
      "invalid_request_error",
      "model_not_found"
    );
  }

  const prompt = buildPrompt(body.messages);
  if (!prompt.trim()) {
    return errorResponse(res, 400, "Message content is empty.");
  }

  const stream = body.stream === true;
  // stream_options.include_usage is always honored: a usage chunk is sent on
  // every stream even when the client did not ask for it.
  const completionId = newCompletionId();
  const created = Math.floor(Date.now() / 1000);

  // Thinking requests must run through the Sessions API (thinking budget);
  // plain non-streaming requests go through the lighter Batch API.
  const useSessions = resolved.thinking || stream;

  if (stream) {
    res.status(200);
    setSSEHeaders(res);
    const stopKeepalive = startKeepalive(res, SSE_KEEPALIVE_INTERVAL_MS);

    const sendChunk = (delta: Record<string, unknown>, finishReason: string | null): void => {
      writeJSONEvent(res, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: resolved.requestedModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
    };

    // Initial role chunk.
    sendChunk({ role: "assistant", content: "" }, null);

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    let thoughtOpen = false;
    let thoughtClosed = false;
    let fullText = "";
    let fullThought = "";

    try {
      const result = await runSessionCompletion(prompt, resolved.upstreamModel, {
        thinking: resolved.thinking,
        signal: controller.signal,
        callbacks: {
          onThought: (delta) => {
            if (!thoughtOpen) {
              thoughtOpen = true;
              sendChunk({ content: THINKING_OPEN }, null);
            }
            sendChunk({ content: delta }, null);
            fullThought += delta;
          },
          onText: (delta) => {
            if (thoughtOpen && !thoughtClosed) {
              thoughtClosed = true;
              sendChunk({ content: THINKING_CLOSE }, null);
            }
            sendChunk({ content: delta }, null);
            fullText += delta;
          },
        },
      });

      if (thoughtOpen && !thoughtClosed) {
        sendChunk({ content: THINKING_CLOSE }, null);
      }
      fullText = result.content || fullText;
      fullThought = result.thought || fullThought;

      // Finish chunk.
      sendChunk({}, "stop");
      // Usage chunk (always included, per injected stream_options.include_usage).
      writeJSONEvent(res, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: resolved.requestedModel,
        choices: [],
        usage: {
          prompt_tokens: estimateTokens(prompt),
          completion_tokens: estimateTokens(fullText + fullThought),
          total_tokens:
            estimateTokens(prompt) + estimateTokens(fullText + fullThought),
        },
      });
      finishSSE(res);
    } catch (err) {
      stopKeepalive();
      if (!res.writableEnded) {
        writeJSONEvent(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: resolved.requestedModel,
          choices: [
            {
              index: 0,
              delta: {
                content: `\n[proxy error] ${(err as Error).message}`,
              },
              finish_reason: "stop",
            },
          ],
        });
        finishSSE(res);
      }
      return;
    }
    stopKeepalive();
    return;
  }

  // ---- Non-streaming ----
  // Abort upstream polling if the client disconnects mid-request.
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  try {
    let content: string;
    let thought = "";

    if (useSessions) {
      const result = await runSessionCompletion(prompt, resolved.upstreamModel, {
        thinking: resolved.thinking,
        signal: controller.signal,
      });
      content = result.content;
      thought = result.thought;
    } else {
      try {
        const result = await runBatchCompletion(
          prompt,
          resolved.upstreamModel,
          controller.signal
        );
        content = result.content;
      } catch (err) {
        if (err instanceof BatchPermissionError) {
          // Upstream key lacks batch permissions — fall back to the Sessions API.
          const result = await runSessionCompletion(prompt, resolved.upstreamModel, {
            thinking: false,
            signal: controller.signal,
          });
          content = result.content;
        } else {
          throw err;
        }
      }
    }

    const finalContent = thought
      ? `${THINKING_OPEN}${thought}${THINKING_CLOSE}${content}`
      : content;

    res.json({
      id: completionId,
      object: "chat.completion",
      created,
      model: resolved.requestedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: finalContent },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(finalContent),
        total_tokens: estimateTokens(prompt) + estimateTokens(finalContent),
      },
    });
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status || 502 : 502;
    errorResponse(
      res,
      status >= 500 ? status : 502,
      `Upstream completion failed: ${(err as Error).message}`,
      "api_error"
    );
  }
}
