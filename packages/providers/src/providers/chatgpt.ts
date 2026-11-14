import { CHATGPT_MODELS } from '../catalog/chatgpt.ts';
import type { ErrorInput, ErrorReading, ResponsesProfile } from '../formats/responses/profile.ts';
import { dataUrl } from '../formats/responses/request.ts';
import { createResponsesProvider } from '../formats/responses/provider.ts';
import {
  credentialFields,
  invalidRequest,
  isRecord,
  optionalCredential,
  requiredCredential,
  tokenCount,
} from '../shared.ts';

// The Codex backend, called as Codex calls it with a ChatGPT sign-in
// (openai/codex: core/src/client.rs, model-provider/src/bearer_auth_provider.rs).

/** Codex's own originator, which the backend attributes requests to. */
const ORIGINATOR = 'codex_cli_rs';
const ENCRYPTED_REASONING = 'reasoning.encrypted_content';

/**
 * Codex's errors on this route: a FastAPI `{ detail }` message for most
 * refusals, and `{ error: { type } }` for plan limits, with when they reset.
 */
function classifyError({
  status,
  message = '',
  code,
  type,
  error,
}: ErrorInput): ErrorReading | undefined {
  if (type === 'usage_limit_reached') {
    const seconds = tokenCount(error?.resets_in_seconds);
    const resetsAt = tokenCount(error?.resets_at);
    const retryAfterMs =
      seconds !== undefined
        ? seconds * 1000
        : resetsAt !== undefined
          ? Math.max(0, resetsAt * 1000 - Date.now())
          : undefined;
    return { kind: 'quota_exceeded', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  // The plan does not include Codex.
  if (type === 'usage_not_included') return { kind: 'quota_exceeded' };
  // "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."
  if (status === 400 && /^The '.+' model is not supported/i.test(message)) {
    return { kind: 'not_found', param: 'model' };
  }
  // Cloudflare's edge page, with no error object: what any request from a Worker gets.
  if (status === 403 && !message && code === undefined && type === undefined) {
    return {
      kind: 'invalid_request',
      message:
        "ChatGPT's edge refused the request with an HTML page. It refuses every request made " +
        'from a Cloudflare Worker; call it from another runtime.',
    };
  }
  // "Unsupported parameter: temperature"
  const param = /^Unsupported parameter: ([\w.]+)/i.exec(message)?.[1];
  if (param !== undefined) return { kind: 'invalid_request', param };
  return undefined;
}

export const chatGptProfile: ResponsesProfile<'chatgpt'> = {
  provider: 'chatgpt',
  label: 'ChatGPT',
  url: 'https://chatgpt.com/backend-api/codex/responses',
  // `system` messages are refused: "System messages are not allowed".
  systemRole: 'developer',
  catalog: CHATGPT_MODELS,
  fileData: dataUrl,
  // No Files API on this route.
  fileIds: false,
  customTools: true,
  // Echoes of the request, and hosted-tool counts that are always zero here.
  echoFields: ['prompt_cache_retention', 'tool_usage'],
  outputOnlyFields: [],
  // Token counts per input item: as long as the history, on every turn.
  usageEchoFields: ['attribution'],
  messageModel: 'request',
  streamed: true,
  fixedFields: { store: false },
  lite: true,
  classifyError,

  withDefaults(options) {
    const reasoning = isRecord(options.reasoning) ? options.reasoning : {};
    const include = Array.isArray(options.include) ? options.include : [];
    return {
      ...options,
      tool_choice: options.tool_choice ?? 'auto',
      parallel_tool_calls: options.parallel_tool_calls ?? false,
      reasoning: { context: 'all_turns', ...reasoning },
      include: include.includes(ENCRYPTED_REASONING) ? include : [...include, ENCRYPTED_REASONING],
    };
  },

  // Codex sends its thread ID as the cache key and as both headers.
  requestHeaders({ prompt_cache_key: key }) {
    return typeof key === 'string' && key ? { 'session-id': key, 'thread-id': key } : {};
  },

  credentials(value) {
    const fields = credentialFields('chatgpt', 'ChatGPT', value);
    const accountId = optionalCredential('chatgpt', fields, 'accountId');
    if (fields.fedramp !== undefined && typeof fields.fedramp !== 'boolean') {
      throw invalidRequest('chatgpt', 'credentials.fedramp must be a boolean.');
    }
    return {
      accessToken: requiredCredential('chatgpt', fields, 'accessToken'),
      ...(accountId !== undefined ? { accountId } : {}),
      ...(fields.fedramp === true ? { fedramp: true } : {}),
    };
  },

  headers({ accessToken, accountId, fedramp }) {
    return {
      authorization: `Bearer ${accessToken}`,
      originator: ORIGINATOR,
      'x-openai-internal-codex-responses-lite': 'true',
      ...(accountId !== undefined ? { 'chatgpt-account-id': accountId } : {}),
      ...(fedramp ? { 'x-openai-fedramp': 'true' } : {}),
    };
  },
};

export const chatgpt = createResponsesProvider(chatGptProfile);
