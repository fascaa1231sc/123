import { VORFLUX_API_BASE, MODELS_CACHE_TTL_MS } from "./utils/config";
import { UpstreamModel } from "./types";

/**
 * Model catalog.
 *
 * The list is never hardcoded: on start (and whenever the cache expires) the
 * proxy pulls the live model list from Vorflux AI Cloud (`GET /api/v1/models`)
 * and converts it to the OpenAI `/v1/models` shape. Claude-series models that
 * support thinking additionally get a `<model>-thinking` variant injected.
 */

interface ModelsCache {
  fetchedAt: number; // epoch ms
  createdAt: number; // epoch seconds for OpenAI `created` fields
  models: UpstreamModel[];
}

let cache: ModelsCache | null = null;
let refreshPromise: Promise<UpstreamModel[]> | null = null;

export class UpstreamError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.VORFLUX_API_KEY}` };
}

/** Fetch the live model list from Vorflux AI Cloud (cached). */
export async function getUpstreamModels(
  force: boolean = false
): Promise<UpstreamModel[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return cache.models;
  }
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    let res: Response;
    try {
      res = await fetch(`${VORFLUX_API_BASE}/models`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      refreshPromise = null;
      throw new UpstreamError(
        `Failed to reach Vorflux AI Cloud model list: ${(err as Error).message}`
      );
    }
    if (!res.ok) {
      refreshPromise = null;
      const body = await res.text().catch(() => "");
      throw new UpstreamError(
        `Upstream model list request failed (${res.status}): ${body.slice(0, 300)}`,
        res.status === 401 || res.status === 403 ? 502 : 502
      );
    }
    const data = (await res.json()) as { models?: UpstreamModel[] };
    const models = (data.models || [])
      .filter((m) => m && typeof m.modelKey === "string")
      .map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName || m.modelKey,
        supportsThinking: !!m.supportsThinking,
      }));
    cache = {
      fetchedAt: Date.now(),
      createdAt: Math.floor(Date.now() / 1000),
      models,
    };
    refreshPromise = null;
    return models;
  })();

  return refreshPromise;
}

export function isClaudeModel(modelKey: string): boolean {
  return /^claude/i.test(modelKey);
}

const THINKING_SUFFIX = "-thinking";

/** OpenAI-format model entries, with `-thinking` variants injected for Claude models. */
export async function getOpenAiModels(): Promise<
  Array<{ id: string; object: string; created: number; owned_by: string }>
> {
  const upstream = await getUpstreamModels();
  const created = cache?.createdAt || Math.floor(Date.now() / 1000);
  const out: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
  for (const m of upstream) {
    out.push({ id: m.modelKey, object: "model", created, owned_by: "vorflux" });
    if (isClaudeModel(m.modelKey) && m.supportsThinking) {
      out.push({
        id: `${m.modelKey}${THINKING_SUFFIX}`,
        object: "model",
        created,
        owned_by: "vorflux",
      });
    }
  }
  return out;
}

export interface ResolvedModel {
  /** Real upstream model key (suffix stripped). */
  upstreamModel: string;
  /** Model id exactly as the client requested it. */
  requestedModel: string;
  /** True when the `-thinking` variant was requested. */
  thinking: boolean;
}

/**
 * Validate a requested model and resolve thinking variants.
 * Returns null when the model (or its thinking variant) does not exist upstream.
 */
export async function resolveModel(
  requested: string
): Promise<ResolvedModel | null> {
  const upstream = await getUpstreamModels();
  let thinking = false;
  let key = requested;
  if (requested.endsWith(THINKING_SUFFIX)) {
    key = requested.slice(0, -THINKING_SUFFIX.length);
    thinking = true;
  }
  const found = upstream.find((m) => m.modelKey === key);
  if (!found) return null;
  if (thinking && !found.supportsThinking) return null;
  return { upstreamModel: key, requestedModel: requested, thinking };
}

/** Grouped catalog for the status page (vendor buckets). */
export async function getStatusModels(): Promise<{
  updatedAt: number;
  total: number;
  groups: Array<{ vendor: string; models: string[] }>;
}> {
  const models = await getOpenAiModels();
  const groups = new Map<string, string[]>();
  for (const m of models) {
    const vendor = vendorFor(m.id);
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor)!.push(m.id);
  }
  return {
    updatedAt: cache?.fetchedAt || Date.now(),
    total: models.length,
    groups: [...groups.entries()]
      .map(([vendor, ids]) => ({ vendor, models: ids.sort() }))
      .sort((a, b) => a.vendor.localeCompare(b.vendor)),
  };
}

function vendorFor(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith("claude")) return "Anthropic (Claude)";
  if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3")) return "OpenAI";
  if (id.startsWith("gemini")) return "Google (Gemini)";
  if (id.startsWith("deepseek")) return "DeepSeek";
  if (id.startsWith("glm")) return "Zhipu (GLM)";
  if (id.startsWith("grok")) return "xAI (Grok)";
  return "Other";
}
