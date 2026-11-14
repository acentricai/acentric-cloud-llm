# ChatGPT

Provider ID `chatgpt`, API format `openai-responses`: the Codex backend
(`POST https://chatgpt.com/backend-api/codex/responses`), called with a
ChatGPT sign-in exactly as Codex calls it, and billed to the ChatGPT plan.
Verified against the Codex source (openai/codex at `c7234c1174`,
2026-10-21) and live calls on 2026-10-21 with a Codex login. The research is
in [`../research/chatgpt/`](../research/chatgpt/).

ChatGPT is a profile on the base Responses adapter, like [OpenAI](openai.md).
Its requests are Codex's **Responses Lite**: every model the backend lists for
a ChatGPT plan uses it. This page records what differs from OpenAI.

This route is undocumented: it is ChatGPT's own backend for Codex, not the
public API. It can change without notice; the live script is the check.

**Direct mode only.** chatgpt.com answers every request that carries
Cloudflare's `CF-Worker` header with a 403 HTML page, and Cloudflare adds that
header to every request a Worker makes. The gateway therefore refuses
`chatgpt` with an `invalid_request` that says so, and leaves its models out
of `/v1/models`. Use `createDirectClient` from `@acentric-cloud/llm/direct`
in a runtime that is not a Cloudflare Worker.

## Credentials

`{ accessToken, accountId?, fedramp? }`, nothing stored:

- `accessToken`: the sign-in's OAuth access token (`tokens.access_token` in
  Codex's `~/.codex/auth.json`), sent as `Authorization: Bearer`. Issued by
  `auth.openai.com` to Codex's client; it expires, and refreshing it is the
  caller's job. An expired or invalid token is a 401 `auth`.
- `accountId`: the ChatGPT account (workspace) to bill (`tokens.account_id`),
  sent as `ChatGPT-Account-ID`. Codex always sends it; without it the token's
  default account is used.
- `fedramp`: sends `X-OpenAI-Fedramp: true`, as Codex does for FedRAMP accounts.

Every request also carries Codex's `originator: codex_cli_rs` and
`X-OpenAI-Internal-Codex-Responses-Lite: true`.

## Request

As for OpenAI, except:

| Ours                    | Codex backend                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| request `tools`         | not top-level: the first input item, `{type: "additional_tools", role: "developer", tools: [{type: "namespace", name: "functions", description: "", tools}]}` |
| `providerOptions.tools` | in the same item, after the `functions` namespace; a native `functions` namespace is merged into it, as Codex does                                            |
| `instructions`          | not top-level: a developer message after the tools item, `{type: "message", role: "developer", content: [input_text]}`                                        |
| `system` message        | `{type: "message", role: "developer", content}`: `system` is refused ("System messages are not allowed")                                                      |
| file part               | `input_file` with `file_url`, or `file_data` as a `data:` URL (PDFs work)                                                                                     |
| image, file ID          | refused: no Files API on this route                                                                                                                           |
| `stream`, `store`       | always `true` and `false`, set by the adapter; refused in `providerOptions`                                                                                   |

The adapter streams the call itself and reads the events into one finished
response (see [Response](#response)); callers never see a stream.

**Codex's constants** fill in what `providerOptions` leaves out. The caller's
value wins where it sets one:

| Field                 | Default                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `tool_choice`         | `"auto"`                                                                                     |
| `parallel_tool_calls` | `false`; Responses Lite refuses anything else ("requires `parallel_tool_calls` to be false") |
| `reasoning.context`   | `"all_turns"`, merged into the caller's `reasoning`                                          |
| `include`             | always has `reasoning.encrypted_content`: nothing is stored, so replay needs it              |

**`prompt_cache_key`** is Codex's thread ID. When it is set, the adapter also
sends it as the `session-id` and `thread-id` headers, as Codex does for a
top-level thread. Without it the backend picks a fresh key on every request,
so set one per conversation.

Accepted `providerOptions`, from what Codex sends: `tools`, `tool_choice`,
`parallel_tool_calls`, `reasoning` (`effort` `low` to `max`, and `ultra` on
most models; `summary`; `context`), `text` (`format`, `verbosity`),
`include`, `prompt_cache_key`, `service_tier` (Codex sends `priority` for fast
mode) and `client_metadata`.

### Refused

- By the adapter, before sending: `store`, `stream`, `background` and owned
  fields in `providerOptions`; image and file parts by file ID; a native tool
  that is not `function`, `custom`, `namespace` or `tool_search` with
  `execution: "client"`. The backend refuses hosted tools at the top level
  ("only supports function tools, custom tools, and client-executed tool
  search") but **ignores them in `additional_tools` without an error**, so
  the adapter refuses them itself.
- By the backend, by name: every other field. `temperature`, `metadata`,
  `previous_response_id`, a misspelling: "Unsupported parameter: X", which
  arrives as `invalid_request` with `providerParam: "X"`. `max_output_tokens`
  is accepted, though Codex never sends it; whether it applies is unchecked.

### Worth knowing

- **Nothing is stored.** Send the whole history every turn; there is no
  `previous_response_id`. Codex does the same.
- **Replay is verbatim**, with or without item IDs. Reasoning items carry
  `encrypted_content`; ciphertext from another account, model or provider
  fails mid-stream with `invalid_encrypted_content` on `input`.
- **Function calls come back without a namespace**, though the tools went in
  the `functions` namespace; their results are plain `function_call_output`.
- **Models:** only the ones the plan lists. `gpt-5.5`, which Codex catalogs,
  is "not supported when using Codex with a ChatGPT account" (400, read as
  `not_found` on `model`).
- **Image `detail`** passes through the part's `providerOptions` and is
  accepted. Codex leaves it out for Responses Lite models.

## Response

The backend answers with server-sent events: `response.created`,
`response.in_progress`, `response.output_item.added` / `.done`, text and
argument deltas, `response.metadata` (moderation results), and one terminal
event. The response has no `content-type` header.

| Terminal event        | Result                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `response.completed`  | the response; its `output` is the message (rebuilt from `output_item.done` events if empty) |
| `response.incomplete` | the response, with a `length` or `content_filter` stop                                      |
| `response.failed`     | an `LlmError` from its `error`, with any usage                                              |
| `error`               | an `LlmError` from its `error`, on HTTP 200                                                 |
| none                  | `provider_error` (retryable): the stream ended before the response finished                 |

From there it is OpenAI's mapping: the assistant message is the output,
verbatim; the stop reason is derived the same way; messages have `phase`.

| Ours           | Codex backend                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `usage`        | as for OpenAI; `cache_write_tokens` is reported, as 0 so far                                             |
| `usage.cost`   | none: billed to the plan                                                                                 |
| `native`       | `status`, `created_at`, `completed_at`, the effective `reasoning`, `service_tier`                        |
| `native.usage` | nothing so far: `usage.attribution` (tokens per input item) is left out, since it grows with the history |

Echoes left out of `native`, beyond the format's: `prompt_cache_retention` and
`tool_usage` (hosted tool counts, always zero here).

The response headers carry the plan's usage (`x-codex-primary-used-percent`,
`x-codex-primary-reset-at`, `x-codex-plan-type`, credits, ...) and a sticky
routing token (`x-codex-turn-state`), which Codex sends back within a turn.
Neither is read yet.

### Errors

Most refusals are FastAPI's `{"detail": "..."}`; Responses-layer errors are
`{error: {message, type, param, code}}`; plan limits are
`{error: {type: "usage_limit_reached", plan_type, resets_at, resets_in_seconds}}`.
`requestId` comes from `x-oai-request-id`.

| Signal                                                           | Kind                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 401 `{detail}` (unparsable, expired or revoked token)            | `auth`                                                                   |
| 400 "The 'X' model is not supported when using Codex ..."        | `not_found` (`providerParam: "model"`)                                   |
| 400 "Unsupported parameter: X"                                   | `invalid_request` (`providerParam: "X"`)                                 |
| 400 `unsupported_value` with `param` (Lite refusals)             | `invalid_request`                                                        |
| `usage_limit_reached` (429, or on a failed response)             | `quota_exceeded`, `retryAfterMs` from `resets_in_seconds` or `resets_at` |
| `usage_not_included` (the plan has no Codex)                     | `quota_exceeded`                                                         |
| 403 HTML page with no error (a request from a Cloudflare Worker) | `invalid_request`, with a message that says so                           |
| other 429                                                        | `rate_limited`                                                           |
| `invalid_encrypted_content` and other codes mid-stream           | `invalid_request`                                                        |
| 5xx, `server_is_overloaded`                                      | as for OpenAI                                                            |

Live, the 400, 401 and 403 rows and the mid-stream error were seen; the plan
limit rows are from the Codex source.

## Models

Any model ID works. The catalog holds the models the backend listed for a
ChatGPT plan on 2026-10-21 (`GET /backend-api/codex/models`, visibility
`list`): GPT-6.1-Sol (500K context), GPT-6-Astra, GPT-6-Sol, GPT-6-Luna,
GPT-5.6-Sol, GPT-5.6-Terra and GPT-5.6-Luna (272K). There is no pricing:
usage counts against the plan's limits, not dollars. The list differs by plan
and account.

## Extractors

The Responses extractors, unchanged: `outputText` skips commentary,
`pendingToolCalls` lists `function_call` and `custom_tool_call` items, and
`reasoningSummary` returns the summaries when `reasoning.summary` asks for
them.

## Not supported

- The gateway (above).
- Refreshing tokens, signing in, and the backend's other routes (models,
  compaction, usage).
- WebSockets, which Codex prefers when the model allows; HTTP with SSE is
  what Codex uses otherwise.
- Codex's turn metadata headers (`x-codex-turn-metadata`, `x-codex-window-id`,
  ...), attestation and `x-codex-turn-state`.
