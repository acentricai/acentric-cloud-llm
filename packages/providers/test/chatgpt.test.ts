import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LlmError,
  type CompletionRequest,
  type Message,
  type ToolDefinition,
} from '@acentric-llm/contracts';
import { complete, convert, pendingToolCalls, toolResult } from '../src/index.ts';
import { fakeFetch } from './support.ts';

const MODEL = 'gpt-6-luna';

function request(
  overrides: Partial<CompletionRequest<'chatgpt'>> = {},
): CompletionRequest<'chatgpt'> {
  return {
    provider: 'chatgpt',
    credentials: { accessToken: 'token-1', accountId: 'account-1' },
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] }],
    ...overrides,
  } as CompletionRequest<'chatgpt'>;
}

const weather: ToolDefinition = {
  type: 'function',
  name: 'get_weather',
  description: 'Get the weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  strict: true,
};
const patch: ToolDefinition = {
  type: 'custom',
  name: 'apply_patch',
  description: 'Apply a patch.',
};

/** A server-sent event stream, as the Codex backend writes it. */
function sse(events: readonly Record<string, unknown>[], separator = '\n'): string {
  return events
    .map((event) => `event: ${String(event.type)}${separator}data: ${JSON.stringify(event)}`)
    .join(separator + separator)
    .concat(separator + separator);
}

// Shapes as the Codex backend answered live on 2026-10-21 (IDs and ciphertext shortened).
const answer = {
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Paris', annotations: [], logprobs: [] }],
  phase: 'final_answer',
};
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA-opaque' };
const call = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'get_weather',
  arguments: '{"city":"Paris"}',
  status: 'completed',
};
const custom = {
  type: 'custom_tool_call',
  id: 'ctc_1',
  call_id: 'call_2',
  name: 'apply_patch',
  input: '*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch\n',
  status: 'completed',
};

function response(output: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1792567292,
    completed_at: 1792567294,
    status: 'completed',
    background: false,
    frequency_penalty: 0,
    presence_penalty: 0,
    moderation: null,
    model: MODEL,
    access_programs: null,
    previous_response_id: null,
    instructions: null,
    output,
    error: null,
    incomplete_details: null,
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    prompt_cache_key: 'key-1',
    prompt_cache_retention: '24h',
    text: { format: { type: 'text' }, verbosity: 'medium' },
    top_p: 0.98,
    top_logprobs: 0,
    temperature: 1,
    reasoning: { effort: 'low', context: 'all_turns', summary: null, mode: 'standard' },
    user: null,
    usage: {
      input_tokens: 19,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 24,
      attribution: { items: { msg_0: { input_tokens: 8, output_tokens: 0 } } },
    },
    tool_usage: { web_search: { num_requests: 0 } },
    safety_identifier: 'user-1',
    store: false,
    metadata: {},
    max_output_tokens: null,
    max_tool_calls: null,
    service_tier: 'auto',
    truncation: 'disabled',
    ...extra,
  };
}

/** A whole stream: created, the items, then the terminal event. */
function stream(output: unknown[], terminal: Record<string, unknown> = {}): string {
  const inProgress = response([], { status: 'in_progress', usage: null, completed_at: null });
  return sse([
    { type: 'response.created', sequence_number: 0, response: inProgress },
    { type: 'response.in_progress', sequence_number: 1, response: inProgress },
    ...output.flatMap((item, index) => [
      {
        type: 'response.output_item.added',
        output_index: index,
        item: { ...(item as object), status: 'in_progress' },
      },
      { type: 'response.output_item.done', output_index: index, item },
    ]),
    { type: 'response.metadata', response_id: 'resp_1', metadata: {} },
    { type: 'response.completed', sequence_number: 9, response: response(output), ...terminal },
  ]);
}

test('sends Codex Responses Lite: tools and instructions as input items, streamed, unstored', async () => {
  const { fetch, sent } = fakeFetch(stream([call]));
  await complete(
    request({
      instructions: 'Be brief.',
      tools: [weather, patch],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
        { role: 'system', content: [{ type: 'text', text: 'Use the tool.' }] },
      ],
      providerOptions: {
        reasoning: { effort: 'high' },
        include: ['message.output_text.logprobs'],
        prompt_cache_key: 'thread-1',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            description: 'Local tools.',
            tools: [{ type: 'function', name: 'exec' }],
          },
          { type: 'namespace', name: 'calendar', description: 'Calendar.', tools: [] },
          { type: 'tool_search', execution: 'client', description: 'Find tools.', parameters: {} },
        ],
      },
    }),
    { fetch },
  );
  const [{ url, headers, body }] = sent as [(typeof sent)[number]];
  assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(headers.get('authorization'), 'Bearer token-1');
  assert.equal(headers.get('chatgpt-account-id'), 'account-1');
  assert.equal(headers.get('originator'), 'codex_cli_rs');
  assert.equal(headers.get('x-openai-internal-codex-responses-lite'), 'true');
  assert.equal(headers.get('accept'), 'text/event-stream');
  assert.equal(headers.get('session-id'), 'thread-1');
  assert.equal(headers.get('thread-id'), 'thread-1');
  assert.equal(headers.get('x-openai-fedramp'), null);

  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.equal(body.instructions, undefined);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.reasoning, { context: 'all_turns', effort: 'high' });
  assert.deepEqual(body.include, ['message.output_text.logprobs', 'reasoning.encrypted_content']);
  assert.equal(body.prompt_cache_key, 'thread-1');
  assert.deepEqual(body.input, [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [
        {
          type: 'namespace',
          name: 'functions',
          description: 'Local tools.',
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              description: weather.description,
              parameters: (weather as { parameters: unknown }).parameters,
              strict: true,
            },
            { type: 'custom', name: 'apply_patch', description: 'Apply a patch.' },
            { type: 'function', name: 'exec' },
          ],
        },
        { type: 'namespace', name: 'calendar', description: 'Calendar.', tools: [] },
        { type: 'tool_search', execution: 'client', description: 'Find tools.', parameters: {} },
      ],
    },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Be brief.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather in Paris?' }] },
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Use the tool.' }],
    },
  ]);
});

test("the caller's values win over Codex's defaults; no tools means no tools item", async () => {
  const { fetch, sent } = fakeFetch(stream([answer]));
  await complete(
    request({
      credentials: { accessToken: 'token-1', fedramp: true },
      providerOptions: {
        tool_choice: 'none',
        parallel_tool_calls: true,
        reasoning: { context: 'current_turn' },
        include: ['reasoning.encrypted_content'],
      },
    }),
    { fetch },
  );
  const [{ headers, body }] = sent as [(typeof sent)[number]];
  assert.equal(headers.get('chatgpt-account-id'), null);
  assert.equal(headers.get('x-openai-fedramp'), 'true');
  assert.equal(headers.get('session-id'), null);
  assert.equal(body.tool_choice, 'none');
  assert.equal(body.parallel_tool_calls, true);
  assert.deepEqual(body.reasoning, { context: 'current_turn' });
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather in Paris?' }] },
  ]);
});

test('reads the stream into one response, without the usage breakdown or echoes', async () => {
  const { fetch } = fakeFetch(stream([reasoning, answer]));
  const result = await complete(request(), { fetch });
  assert.equal(result.id, 'resp_1');
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.message, {
    role: 'assistant',
    provider: 'chatgpt',
    api: 'openai-responses',
    model: MODEL,
    id: 'resp_1',
    timestamp: result.timestamp,
    content: [reasoning, answer],
  });
  assert.deepEqual(result.usage, {
    totalInput: 19,
    input: 19,
    output: 5,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(result.native, {
    status: 'completed',
    created_at: 1792567292,
    completed_at: 1792567294,
    reasoning: { effort: 'low', context: 'all_turns', summary: null, mode: 'standard' },
    service_tier: 'auto',
  });
});

test('rebuilds the output from the item events when the terminal response has none', async () => {
  const events = stream([reasoning, call]).replace(/"type":"response\.completed".*$/m, (line) =>
    line.replace(/"output":\[.*?\],"error"/, '"output":[],"error"'),
  );
  const { fetch } = fakeFetch(events);
  const result = await complete(request(), { fetch });
  assert.deepEqual(result.message.content, [reasoning, call]);
  assert.equal(result.stopReason, 'tool_use');
});

test('reads CRLF event streams', async () => {
  const { fetch } = fakeFetch(
    sse([{ type: 'response.completed', response: response([answer]) }], '\r\n'),
  );
  assert.equal((await complete(request(), { fetch })).stopReason, 'stop');
});

test('an incomplete response is a length stop', async () => {
  const body = sse([
    {
      type: 'response.incomplete',
      response: response([], {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    },
  ]);
  const { fetch } = fakeFetch(body);
  const result = await complete(request(), { fetch });
  assert.equal(result.stopReason, 'length');
  assert.equal(result.providerStopReason, 'max_output_tokens');
});

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(LlmError.is(error), String(error));
    return error;
  }
  assert.fail('expected an error');
}

test('an error event on HTTP 200 is an LlmError with its code and field', async () => {
  // Sent live for reasoning whose ciphertext the backend cannot read.
  const { fetch } = fakeFetch(
    sse([
      {
        type: 'error',
        error: {
          message: 'The encrypted content for item rs_1 could not be verified.',
          type: 'invalid_request_error',
          param: 'input',
          code: 'invalid_encrypted_content',
        },
      },
    ]),
  );
  const error = await failure(complete(request(), { fetch }));
  assert.equal(error.kind, 'invalid_request');
  assert.equal(error.providerCode, 'invalid_encrypted_content');
  assert.equal(error.providerParam, 'input');
  assert.equal(error.requestId, 'req_test');
});

test('a failed response mid-stream keeps its usage; a plan limit there is quota_exceeded', async () => {
  const { fetch } = fakeFetch(
    sse([
      {
        type: 'response.failed',
        response: response([], {
          status: 'failed',
          error: {
            type: 'usage_limit_reached',
            message: 'The usage limit has been reached',
            resets_in_seconds: 60,
          },
        }),
      },
    ]),
  );
  const error = await failure(complete(request(), { fetch }));
  assert.equal(error.kind, 'quota_exceeded');
  assert.equal(error.retryable, false);
  assert.equal(error.retryAfterMs, 60_000);
  assert.equal(error.usage?.totalInput, 19);
});

test('a stream that ends before the response finished is a retryable provider error', async () => {
  const { fetch } = fakeFetch(stream([answer]).split('event: response.completed')[0]!);
  const error = await failure(complete(request(), { fetch }));
  assert.equal(error.kind, 'provider_error');
  assert.equal(error.retryable, true);
  const garbled = await failure(
    complete(request(), { fetch: fakeFetch('event: response.created\ndata: {nope\n\n').fetch }),
  );
  assert.equal(garbled.kind, 'invalid_response');
});

test("reads the backend's refusals: models, fields, tokens, plan limits, the edge", async () => {
  const cases: [number, unknown, Record<string, string> | undefined, Partial<LlmError>][] = [
    [
      400,
      { detail: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." },
      undefined,
      { kind: 'not_found', providerParam: 'model' },
    ],
    [
      400,
      { detail: 'Unsupported parameter: temperature' },
      undefined,
      { kind: 'invalid_request', providerParam: 'temperature' },
    ],
    [
      401,
      { detail: 'Could not parse your authentication token. Please try signing in again.' },
      undefined,
      { kind: 'auth' },
    ],
    [
      429,
      {
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
          plan_type: 'plus',
          resets_in_seconds: 3600,
        },
      },
      undefined,
      { kind: 'quota_exceeded', retryAfterMs: 3_600_000, retryable: false },
    ],
    [
      429,
      { error: { type: 'usage_not_included', message: 'Upgrade to use Codex.' } },
      undefined,
      { kind: 'quota_exceeded' },
    ],
    [
      429,
      { detail: 'Too many requests' },
      { 'retry-after': '2' },
      { kind: 'rate_limited', retryAfterMs: 2000 },
    ],
    [403, '<html><body>blocked</body></html>', undefined, { kind: 'invalid_request' }],
    [
      400,
      {
        error: {
          message:
            'X-OpenAI-Internal-Codex-Responses-Lite requires `parallel_tool_calls` to be false.',
          type: 'invalid_request_error',
          param: 'parallel_tool_calls',
          code: 'unsupported_value',
        },
      },
      undefined,
      {
        kind: 'invalid_request',
        providerParam: 'parallel_tool_calls',
        providerCode: 'unsupported_value',
      },
    ],
  ];
  for (const [status, body, headers, expected] of cases) {
    const { fetch } = fakeFetch(body, {
      status,
      headers: { 'x-oai-request-id': 'oai-1', ...headers },
    });
    const error = await failure(complete(request(), { fetch }));
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(error[key as keyof LlmError], value, `${status} ${key}`);
    }
    assert.equal(error.httpStatus, status);
  }
  const { fetch } = fakeFetch('<html>blocked</html>', { status: 403 });
  const edge = await failure(complete(request(), { fetch }));
  assert.match(edge.message, /Cloudflare Worker/);
});

test('takes the request ID from x-oai-request-id', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ detail: 'Unsupported parameter: banana' }), {
      status: 400,
      headers: { 'x-oai-request-id': 'oai-1' },
    })) as typeof fetch;
  const error = await failure(complete(request(), { fetch: fetchFn }));
  assert.equal(error.requestId, 'oai-1');
});

test('refuses what the backend refuses or would ignore, before sending', async () => {
  const { fetch, sent } = fakeFetch(stream([answer]));
  const refused: [Partial<CompletionRequest<'chatgpt'>>, RegExp][] = [
    [{ providerOptions: { store: false } as never }, /store is always false/],
    [{ providerOptions: { stream: true } as never }, /stream is always true/],
    [{ providerOptions: { tools: [{ type: 'web_search' }] } }, /web_search tool/],
    [{ providerOptions: { tools: [{ type: 'tool_search' }] } }, /execution "client"/],
    [
      {
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'file_id', id: 'file_1' } }] },
        ],
      },
      /no file IDs/,
    ],
    [{ credentials: {} as never }, /credentials\.accessToken/],
    [{ credentials: { accessToken: 't', fedramp: 'yes' } as never }, /fedramp must be a boolean/],
  ];
  for (const [overrides, message] of refused) {
    const error = await failure(complete(request(overrides), { fetch }));
    assert.equal(error.kind, 'invalid_request');
    assert.match(error.message, message);
  }
  assert.equal(sent.length, 0);
});

test('function and custom calls are pending, and their results replay as written', async () => {
  const { fetch } = fakeFetch(stream([call, custom]));
  const first = await complete(request({ tools: [weather, patch] }), { fetch });
  const calls = pendingToolCalls(first.message);
  assert.deepEqual(
    calls.map((one) => [one.toolType, one.toolName, one.arguments ?? one.input]),
    [
      ['function', 'get_weather', '{"city":"Paris"}'],
      ['custom', 'apply_patch', custom.input],
    ],
  );
  const replay = fakeFetch(stream([answer]));
  await complete(
    request({
      tools: [weather, patch],
      messages: [
        ...request().messages,
        first.message,
        toolResult(calls[0]!, '21C'),
        toolResult(calls[1]!, 'Done'),
      ],
    }),
    { fetch: replay.fetch },
  );
  const input = replay.sent[0]!.body.input as Record<string, unknown>[];
  assert.deepEqual(input.slice(2), [
    call,
    custom,
    { type: 'function_call_output', call_id: 'call_1', output: '21C' },
    { type: 'custom_tool_call_output', call_id: 'call_2', output: 'Done' },
  ]);
});

test("converting to ChatGPT drops other providers' reasoning and options it does not take", () => {
  const history: Message[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Hi', providerOptions: { cache_control: { type: 'ephemeral' } } },
        { type: 'image', source: { type: 'file_id', id: 'file_1' } },
      ],
    },
    {
      role: 'assistant',
      provider: 'openai',
      api: 'openai-responses',
      model: 'gpt-6-luna',
      id: 'resp_0',
      content: [reasoning, answer] as never,
    },
  ];
  const { messages, changes } = convert(history, { provider: 'chatgpt', model: MODEL });
  assert.deepEqual(messages, [
    { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    {
      role: 'assistant',
      provider: 'chatgpt',
      api: 'openai-responses',
      model: MODEL,
      content: [
        { type: 'message', role: 'assistant', content: answer.content, phase: 'final_answer' },
      ],
    },
  ]);
  assert.deepEqual(
    changes.map((change) => [change.action, change.what]),
    [
      ['dropped', 'part_option'],
      ['dropped', 'part'],
      ['dropped', 'reasoning'],
    ],
  );
});
