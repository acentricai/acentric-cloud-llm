# ChatGPT (the Codex backend): research

What Codex sends to `https://chatgpt.com/backend-api/codex/responses` when
signed in with ChatGPT, and what the backend answered to live calls on
2026-10-21. The provider note, [`../../providers/chatgpt.md`](../../providers/chatgpt.md),
is the summary; this page is the evidence.

Source: [openai/codex](https://github.com/openai/codex) at `c7234c1174`
(2026-10-21). Live calls: a Codex login (`~/.codex/auth.json`, plan type
`prolite`), `gpt-6-luna` and `gpt-6.1-sol`, plain `fetch` from Node.

## Two routes

The Sign in with ChatGPT docs
([models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations))
describe a public route: `POST https://api.openai.com/v1/responses` with a
token from a dynamically registered client (scope `chatgpt.tokens.use.direct`).
Codex's own ChatGPT login uses another: its base URL is
`CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"` whenever the
auth mode is ChatGPT (`model-provider-info/src/lib.rs`, `to_api_provider`).
We implement the second, as Codex uses it. The Codex login's access token is
issued by `https://auth.openai.com` to client `app_EMoamEEZ73f0CkXaXp7hrann`,
audience `https://api.openai.com/v1`, and carries the account in
`https://api.openai.com/auth.chatgpt_account_id`; it lasts about ten days.

## What Codex sends

`core/src/client.rs`, `build_responses_request`, for a model with
`use_responses_lite: true` (every model in `models-manager/models.json`
except `gpt-5.5`):

```json
{
  "model": "gpt-6.1-sol",
  "stream": true,
  "input": [
    { "type": "additional_tools", "role": "developer", "tools": [
      { "type": "namespace", "name": "functions", "description": "", "tools": [ ...functions and custom tools ] },
      ...other namespaces, client tool_search
    ] },
    { "type": "message", "role": "developer", "content": [{ "type": "input_text", "text": "<base instructions>" }] },
    ...history
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "reasoning": { "effort": "low", "summary": "auto", "context": "all_turns" },
  "store": false,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<thread id>",
  "text": { "verbosity": "low" },
  "client_metadata": { ... }
}
```

- No top-level `tools` or `instructions` under Lite
  (`create_tools_json_for_responses_lite` in `tools/src/tool_spec.rs`; tests in
  `core/tests/suite/responses_lite.rs`). The tools item and the instructions
  message get deterministic IDs (UUIDv5 of their content) so caches stay warm;
  the backend works without them.
- Hosted tools are never sent under Lite (`hosted_model_tool_specs` returns
  none); image `detail` is removed (`normalize_image_detail`).
- Headers: `Authorization: Bearer`, `ChatGPT-Account-ID`,
  `X-OpenAI-Fedramp` when applicable (`model-provider/src/bearer_auth_provider.rs`),
  `originator: codex_cli_rs` and a `codex_cli_rs/<version> (...)` User-Agent
  (`login/src/auth/default_client.rs`), `X-OpenAI-Internal-Codex-Responses-Lite: true`,
  `session-id` and `thread-id` (both the thread ID for a top-level thread),
  `x-codex-turn-state` echoed within a turn, and turn metadata headers.
- The stream is read by `codex-api/src/sse/responses.rs`: items from
  `response.output_item.done`, the ID and usage from `response.completed`;
  `response.failed` and `error` events are errors
  (`sse/responses_error.rs`); HTTP 429 `usage_limit_reached` carries
  `plan_type` and `resets_at` (`codex-api/src/api_bridge.rs`).

## What the backend answered

| Request                                                                               | Answer                                                                                                            |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Codex's shape, above                                                                  | 200, events; `response.completed` carries the full `output` and `usage` with `attribution`                        |
| top-level `instructions` instead of a developer message                               | 200                                                                                                               |
| without the Lite header                                                               | 200                                                                                                               |
| without `ChatGPT-Account-ID`, without `originator`                                    | 200                                                                                                               |
| tools top-level, in a top-level namespace, or in `additional_tools`                   | 200, the same `function_call` (no `namespace` on the call)                                                        |
| `stream: false`                                                                       | 400 `{"detail":"Stream must be set to true"}`                                                                     |
| `store: true`                                                                         | 400 `{"detail":"Store must be set to false"}`                                                                     |
| a `role: "system"` message                                                            | 400 `{"detail":"System messages are not allowed"}`                                                                |
| `parallel_tool_calls` left out (defaults to true)                                     | 400 `unsupported_value` on `parallel_tool_calls` (Lite requires false)                                            |
| `temperature`, `metadata`, `previous_response_id`, `banana`                           | 400 `{"detail":"Unsupported parameter: <name>"}`                                                                  |
| `max_output_tokens`, `service_tier: "priority"`, `text.verbosity`, `prompt_cache_key` | 200                                                                                                               |
| `tools: [{type: "web_search"}]` top-level                                             | 400 `unsupported_value` on `tools`: "only supports function tools, custom tools, and client-executed tool search" |
| `web_search` inside `additional_tools`                                                | 200, ignored: `tool_usage.web_search.num_requests` 0                                                              |
| `gpt-5.5`, an unknown model                                                           | 400 `{"detail":"The '<id>' model is not supported when using Codex with a ChatGPT account."}`                     |
| an invalid token                                                                      | 401 `{"detail":"Could not parse your authentication token. Please try signing in again."}`                        |
| a reasoning item with foreign ciphertext                                              | 200, then an `error` event: `invalid_encrypted_content` on `input`                                                |
| any request with a `CF-Worker` header (every Worker subrequest)                       | 403, Cloudflare's HTML block page                                                                                 |
| images (`data:` URL, with and without `detail`), a PDF as `file_data`                 | 200, read correctly                                                                                               |
| a custom tool in the `functions` namespace                                            | 200, `custom_tool_call` with the raw `input`                                                                      |
| a three-turn tool loop, replayed verbatim, with and without item IDs                  | 200 each turn                                                                                                     |
| reasoning with `summary: "auto"`, replayed next turn                                  | 200; reasoning items carry `encrypted_content` and the summary                                                    |

Responses always had no `content-type` header. Response headers include
`x-oai-request-id`, `cf-ray`, the plan's usage (`x-codex-plan-type`,
`x-codex-primary-used-percent`, `x-codex-primary-window-minutes`,
`x-codex-primary-reset-at`, `x-codex-secondary-*`, `x-codex-credits-*`,
`x-codex-active-limit`) and `x-codex-turn-state`. The echoed response sets
`prompt_cache_retention: "24h"`, `safety_identifier` (per user),
`service_tier: "auto"`, and `reasoning.mode: "standard"`.

`GET /backend-api/codex/models?client_version=<v>` with the same headers lists
the plan's models: `gpt-6.1-sol` (context 500,000), `gpt-6-astra`,
`gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
`gpt-daybreak-blue-latest` (272,000; visibility `list`), and hidden
`gpt-reserve` and `codex-auto-review`. All have `use_responses_lite: true`.
