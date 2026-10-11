/** OpenAI-compatible request types (subset used by this proxy). */

export type ChatRole = "system" | "user" | "assistant" | "tool" | "function";

export interface ImageUrlPart {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

export interface TextPart {
  type: "text";
  text: string;
}

export type ContentPart = TextPart | ImageUrlPart | { type: string } & Record<string, unknown>;

export interface ChatMessage {
  role: ChatRole | string;
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: Array<Record<string, unknown>>;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean } | null;
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

/** Anthropic-style image source produced by the conversion layer. */
export interface ImageSource {
  type: "base64" | "url";
  mediaType?: string;
  data?: string;
  url?: string;
}

export interface OpenAiErrorPayload {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

export interface UpstreamModel {
  modelKey: string;
  displayName: string;
  supportsThinking: boolean;
}
