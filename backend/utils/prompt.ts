import { ChatMessage, ContentPart, ImageSource } from "../types";

/**
 * OpenAI request -> upstream prompt conversion.
 *
 * Rules (per spec):
 * - A single user message is passed through verbatim — no role prefixes, no wrapping.
 * - Multi-turn history is compressed into one prompt with clear role labels
 *   (`System:` / `User:` / `Assistant:` / `Tool:`).
 * - `image_url` parts are converted to Anthropic-style image sources
 *   (base64 data URI -> `{type:"base64"}`, HTTPS URL -> `{type:"url"}`) and
 *   serialized as markdown image references, since the upstream accepts text prompts.
 */

const MAX_INLINE_BASE64_CHARS = 2_000_000; // ~1.5 MB binary

/** OpenAI `image_url` -> Anthropic image source shape. */
export function convertImageUrl(url: string): ImageSource | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const mData = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (mData) {
    return { type: "base64", mediaType: mData[1], data: mData[2] };
  }
  if (/^https:\/\//i.test(url)) {
    return { type: "url", url };
  }
  return null;
}

interface NormalizedContent {
  text: string;
  images: ImageSource[];
}

function normalizeContent(message: ChatMessage): NormalizedContent {
  const content = message.content;
  if (typeof content === "string") return { text: content, images: [] };
  if (Array.isArray(content)) {
    let text = "";
    const images: ImageSource[] = [];
    for (const part of content as ContentPart[]) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
        text += (text ? "\n" : "") + (part as { text: string }).text;
      } else if (part.type === "image_url") {
        const url = (part as { image_url?: { url?: string } }).image_url?.url;
        const img = url ? convertImageUrl(url) : null;
        if (img) images.push(img);
      }
    }
    return { text, images };
  }
  return { text: "", images: [] };
}

function imagesToMarkdown(images: ImageSource[]): string {
  if (images.length === 0) return "";
  return images
    .map((img) => {
      if (img.type === "url") return `![image](${img.url})`;
      const data = img.data || "";
      if (data.length > MAX_INLINE_BASE64_CHARS) {
        return `[image: base64 ${img.mediaType || "data"} omitted — too large for a text prompt]`;
      }
      return `![image](data:${img.mediaType || "image/png"};base64,${data})`;
    })
    .join("\n");
}

function joinTextImages(c: NormalizedContent): string {
  const md = imagesToMarkdown(c.images);
  if (!md) return c.text;
  if (!c.text) return md;
  return `${c.text}\n\n${md}`;
}

const ROLE_LABELS: Record<string, string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  function: "Tool",
};

/** Build the upstream prompt from an OpenAI messages array. */
export function buildPrompt(messages: ChatMessage[]): string {
  const normalized = messages.map((m) => ({
    role: String(m.role || "user"),
    content: normalizeContent(m),
    toolCalls: m.tool_calls,
  }));

  // Single user message: pass through directly, no prefixes or wrapping.
  if (
    normalized.length === 1 &&
    normalized[0].role === "user" &&
    (!normalized[0].toolCalls || normalized[0].toolCalls.length === 0)
  ) {
    return joinTextImages(normalized[0].content);
  }

  // Multi-turn history: compress with clear role labels.
  const lines = normalized.map((m) => {
    const label = ROLE_LABELS[m.role] || "User";
    let body = joinTextImages(m.content);
    if (m.toolCalls && m.toolCalls.length > 0) {
      const calls = m.toolCalls
        .map((c) => {
          const fn = c as { function?: { name?: string; arguments?: string } };
          return `${fn.function?.name || "unknown"}(${fn.function?.arguments || ""})`;
        })
        .join("; ");
      body += `${body ? "\n" : ""}[tool calls: ${calls}]`;
    }
    return `${label}: ${body || "(empty)"}`;
  });
  return lines.join("\n\n");
}

/** Rough token estimate (~4 chars per token) for usage reporting. */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil((text || "").length / 4));
}
