import {
  VORFLUX_API_BASE,
  UPSTREAM_POLL_INTERVAL_MS,
  SESSION_TIMEOUT_MS,
  THINKING_BUDGET_TOKENS,
} from "../utils/config";
import { UpstreamError } from "../models";
import { sleep } from "../utils/async";

/**
 * Streaming / thinking provider: Vorflux AI Cloud Sessions API.
 *
 * Each completion creates a GENERAL agent session with the prompt as the
 * initial message, then polls the message list. Agent `thought` messages are
 * surfaced as thinking content and `text` messages as the assistant reply.
 * `-thinking` requests enable extended thinking with a fixed token budget.
 */

export interface SessionCallbacks {
  /** New thinking content (delta). */
  onThought?: (delta: string) => void;
  /** New answer content (delta). */
  onText?: (delta: string) => void;
}

export interface SessionResult {
  content: string;
  thought: string;
  sessionId: string;
}

interface UpstreamMessage {
  id: string;
  messageType: string; // "input" | "text" | "thought" | "tool_call" | ...
  content?: string;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.VORFLUX_API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function archiveSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${VORFLUX_API_BASE}/sessions/${sessionId}/archive`, {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* best effort cleanup */
  }
}

/**
 * Run one completion through the Sessions API.
 *
 * @param prompt     Final upstream prompt (already built from OpenAI messages)
 * @param model      Real upstream model key (no `-thinking` suffix)
 * @param thinking   Enable extended thinking with the fixed budget
 */
export async function runSessionCompletion(
  prompt: string,
  model: string,
  options: {
    thinking: boolean;
    callbacks?: SessionCallbacks;
    signal?: AbortSignal;
  }
): Promise<SessionResult> {
  const { thinking, callbacks, signal } = options;

  const modelConfiguration = thinking
    ? {
        modelSelection: {
          modelKey: model,
          thinkingEnabled: true,
          thinkingBudgetTokens: THINKING_BUDGET_TOKENS,
        },
      }
    : { modelKey: model };

  let createRes: Response;
  try {
    createRes = await fetch(`${VORFLUX_API_BASE}/sessions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        initialMessage: prompt,
        sessionType: "GENERAL",
        modelConfiguration,
      }),
      signal: signal || AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (signal?.aborted) throw new UpstreamError("Client aborted the request", 499);
    throw new UpstreamError(
      `Failed to create upstream session: ${(err as Error).message}`
    );
  }
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new UpstreamError(
      `Upstream session creation failed (${createRes.status}): ${body.slice(0, 300)}`
    );
  }
  const { sessionId } = (await createRes.json()) as { sessionId: string };
  if (!sessionId) throw new UpstreamError("Upstream returned no session id");

  let emittedThought = "";
  let emittedText = "";

  const emitDeltas = (messages: UpstreamMessage[]): void => {
    let thought = "";
    let text = "";
    for (const m of messages) {
      if (typeof m.content !== "string") continue;
      if (m.messageType === "thought") thought += m.content;
      else if (m.messageType === "text") text += m.content;
    }
    // Emit only appended suffixes (messages are append-only in practice).
    if (thought.length > emittedThought.length && thought.startsWith(emittedThought)) {
      const delta = thought.slice(emittedThought.length);
      emittedThought = thought;
      callbacks?.onThought?.(delta);
    } else if (thought !== emittedThought) {
      emittedThought = thought; // replaced content: swallow silently
    }
    if (text.length > emittedText.length && text.startsWith(emittedText)) {
      const delta = text.slice(emittedText.length);
      emittedText = text;
      callbacks?.onText?.(delta);
    } else if (text !== emittedText) {
      emittedText = text;
    }
  };

  const deadline = Date.now() + SESSION_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new UpstreamError("Client aborted the request", 499);
      await sleep(UPSTREAM_POLL_INTERVAL_MS, signal);

      const msgRes = await fetch(
        `${VORFLUX_API_BASE}/sessions/${sessionId}/messages?limit=100`,
        { headers: authHeaders(), signal: AbortSignal.timeout(30_000) }
      );
      if (msgRes.ok) {
        const data = (await msgRes.json()) as { messages?: UpstreamMessage[] };
        emitDeltas(data.messages || []);
      }

      const statusRes = await fetch(`${VORFLUX_API_BASE}/sessions/${sessionId}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      if (statusRes.ok) {
        const { status } = (await statusRes.json()) as { status?: string };
        // ACTIVE / PENDING_START mean the agent is still working.
        if (status && status !== "ACTIVE" && status !== "PENDING_START") {
          // Final sweep for any messages produced after the last poll.
          const finalRes = await fetch(
            `${VORFLUX_API_BASE}/sessions/${sessionId}/messages?limit=100`,
            { headers: authHeaders(), signal: AbortSignal.timeout(30_000) }
          );
          if (finalRes.ok) {
            const data = (await finalRes.json()) as { messages?: UpstreamMessage[] };
            emitDeltas(data.messages || []);
          }
          break;
        }
      }
    }
  } finally {
    void archiveSession(sessionId);
  }

  if (!emittedText && !emittedThought) {
    throw new UpstreamError(
      "Upstream session finished without producing a reply",
      504
    );
  }

  return {
    content: emittedText,
    thought: emittedThought,
    sessionId,
  };
}
