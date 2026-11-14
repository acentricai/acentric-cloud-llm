// ChatGPT: the Codex backend (`POST https://chatgpt.com/backend-api/codex/responses`),
// called with a ChatGPT sign-in as Codex does. Its requests are Codex's
// Responses Lite: always streamed and never stored, tools in an
// `additional_tools` item, no hosted tools. Written from the Codex source
// (openai/codex, 2026-10-21) and live calls on 2026-10-21. The backend refuses
// unknown fields by name. See docs/providers/chatgpt.md.

import type { JsonObject } from '../json.ts';
import type {
  ResponsesCompaction,
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesStatus,
} from '../formats/responses.ts';
import type {
  OpenAiAdditionalTools,
  OpenAiReasoningEffort,
  OpenAiTextFormat,
  OpenAiToolSearchCall,
  OpenAiToolSearchOutput,
} from './openai.ts';

export interface ChatGptCredentials {
  /**
   * A ChatGPT sign-in's OAuth access token (`tokens.access_token` in Codex's
   * `auth.json`), sent as `Authorization: Bearer`. It expires; refreshing it
   * is the caller's job.
   */
  readonly accessToken: string;
  /**
   * The ChatGPT account (workspace) to bill, sent as `ChatGPT-Account-ID`
   * (`tokens.account_id`). Codex always sends it; without it the token's
   * default account is used.
   */
  readonly accountId?: string;
  /** A FedRAMP account, sent as `X-OpenAI-Fedramp: true`, as Codex does. */
  readonly fedramp?: boolean;
}

// ---- Items: the shared format's, plus what Codex sends and reads.

/** No compaction items here: the backend's compaction is its own route. */
type SharedOutputItem = Exclude<ResponsesOutputItem, ResponsesCompaction>;

export type ChatGptOutputItem = SharedOutputItem | OpenAiToolSearchCall | OpenAiToolSearchOutput;

/** An item a `native` message may carry, such as tools added mid-conversation. */
export type ChatGptInputItem =
  Exclude<ResponsesInputItem, ResponsesCompaction> | ChatGptOutputItem | OpenAiAdditionalTools;

// ---- Request options: what Codex sends, minus `model` and `input`, which the
// request owns, and `store` and `stream`, which the adapter sets (`false` and
// `true`). Every other field is refused by name ("Unsupported parameter: ...").

/**
 * A native tool, sent beside the request's own tools in the `additional_tools`
 * item: a `namespace` of function and custom tools, or client tool search.
 * Hosted tools (web search, image generation, ...) are refused.
 */
export type ChatGptTool = {
  readonly type: 'function' | 'custom' | 'namespace' | 'tool_search' | (string & {});
  readonly [key: string]: unknown;
};

export interface ChatGptOptions {
  /** Native tools, after the request's own `functions` namespace in the `additional_tools` item. */
  readonly tools?: readonly ChatGptTool[];
  /** Default `"auto"`, as Codex sends. */
  readonly tool_choice?: 'none' | 'auto' | 'required' | ({ readonly type: string } & JsonObject);
  /** Default `false`, as Codex sends for Responses Lite. */
  readonly parallel_tool_calls?: boolean;
  /**
   * The models take `low` to `max`, and `ultra` on some. `context` defaults to
   * `"all_turns"`, as Codex sends. Reasoning comes back encrypted.
   */
  readonly reasoning?: {
    readonly effort?: OpenAiReasoningEffort | 'ultra' | null;
    readonly summary?: 'auto' | 'concise' | 'detailed' | null;
    readonly context?: 'auto' | 'current_turn' | 'all_turns' | null;
  };
  readonly text?: {
    readonly format?: OpenAiTextFormat;
    readonly verbosity?: 'low' | 'medium' | 'high' | null;
  };
  /** Always includes `reasoning.encrypted_content`, which replay needs since nothing is stored. */
  readonly include?: readonly ('reasoning.encrypted_content' | (string & {}))[];
  /**
   * Codex sends its thread ID. Also sent as the `session-id` and `thread-id`
   * headers, as Codex does for a top-level thread. Without it the backend
   * picks a fresh key, and nothing is cached across requests.
   */
  readonly prompt_cache_key?: string;
  /** Codex sends `priority` for fast mode, when the plan offers it. */
  readonly service_tier?: 'auto' | 'default' | 'flex' | 'priority' | (string & {});
  /** Codex's request attribution (`x-codex-installation-id`, ...). */
  readonly client_metadata?: Readonly<Record<string, string>>;
}

/** The response's own fields, kept in `native`. */
export interface ChatGptNativeResponse {
  readonly status: ResponsesStatus;
  readonly created_at?: number;
  readonly completed_at?: number | null;
  readonly incomplete_details?: { readonly reason?: string } | null;
  /** The tier actually used. */
  readonly service_tier?: string | null;
  /** The effective reasoning settings. */
  readonly reasoning?: JsonObject | null;
  readonly [key: string]: unknown;
}

/** Catalog model IDs: the models the backend lists for ChatGPT plans. Any other ID works too. */
export type ChatGptModelId =
  | 'gpt-6.1-sol'
  | 'gpt-6-astra'
  | 'gpt-6-sol'
  | 'gpt-6-luna'
  | 'gpt-5.6-sol'
  | 'gpt-5.6-terra'
  | 'gpt-5.6-luna';

export interface ChatGptSpec {
  readonly api: 'openai-responses';
  readonly credentials: ChatGptCredentials;
  readonly options: ChatGptOptions;
  readonly inputItem: ChatGptInputItem;
  readonly outputItem: ChatGptOutputItem;
  readonly response: ChatGptNativeResponse;
  readonly modelId: ChatGptModelId;
}
