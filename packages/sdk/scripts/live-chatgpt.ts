// Live checks against ChatGPT (the Codex backend), through the direct client:
// ChatGPT refuses requests from Cloudflare Workers, so the gateway cannot call
// it. Uses CHATGPT_ACCESS_TOKEN and CHATGPT_ACCOUNT_ID, or else the Codex
// sign-in in $CODEX_HOME/auth.json (default ~/.codex). Sign in with
// `codex login` first; the token is read, never refreshed and never printed.
//
//   node --conditions=source scripts/live-chatgpt.ts
//
// Billed to the ChatGPT plan: a few dozen small requests.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LlmError,
  outputText,
  pendingToolCalls,
  reasoningSummary,
  toolResult,
  type CompletionResponse,
  type LlmClient,
  type Message,
  type ToolDefinition,
} from '../src/index.ts';
import { createDirectClient } from '../src/direct.ts';

function codexLogin(): { accessToken: string; accountId?: string } {
  const file = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  const auth = JSON.parse(readFileSync(file, 'utf8'));
  const tokens = auth?.tokens;
  if (typeof tokens?.access_token !== 'string') {
    throw new Error(`${file} has no ChatGPT sign-in; run codex login.`);
  }
  return {
    accessToken: tokens.access_token,
    ...(typeof tokens.account_id === 'string' ? { accountId: tokens.account_id } : {}),
  };
}

const login = process.env.CHATGPT_ACCESS_TOKEN
  ? {
      accessToken: process.env.CHATGPT_ACCESS_TOKEN,
      ...(process.env.CHATGPT_ACCOUNT_ID ? { accountId: process.env.CHATGPT_ACCOUNT_ID } : {}),
    }
  : codexLogin();
const model = process.env.MODEL ?? 'gpt-6-luna';
const llm: LlmClient<'chatgpt'> = createDirectClient({ credentials: { chatgpt: login } });

const weather: ToolDefinition = {
  type: 'function',
  name: 'get_weather',
  description: 'Current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  strict: true,
};

const hi: Message<'chatgpt'>[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
const low = { reasoning: { effort: 'low' } } as const;

function summary(response: CompletionResponse<'chatgpt'>) {
  return {
    stop: response.stopReason,
    ...(response.providerStopReason ? { providerStop: response.providerStopReason } : {}),
    model: response.message.model,
    items: response.message.content.map((item) => item.type),
    usage: response.usage,
    native: Object.keys(response.native).sort(),
    ms: response.durationMs,
  };
}

async function failure(run: () => Promise<unknown>): Promise<LlmError> {
  try {
    await run();
  } catch (error) {
    assert.ok(LlmError.is(error), `an LlmError, not ${String(error)}`);
    return error;
  }
  assert.fail('expected an error');
}

function brief(error: LlmError) {
  const { providerError: _body, nativeError: _native, ...rest } = error.toJSON();
  return rest;
}

const results: [string, 'ok' | 'FAIL', unknown][] = [];
async function check(name: string, run: () => Promise<unknown>) {
  try {
    results.push([name, 'ok', await run()]);
  } catch (error) {
    const detail = LlmError.is(error)
      ? error.toJSON()
      : error instanceof Error
        ? error.message
        : error;
    results.push([name, 'FAIL', detail]);
  }
}

await check('text, with instructions as a developer message', async () => {
  const response = await llm.complete({
    provider: 'chatgpt',
    model,
    instructions: 'You are terse. Always answer in lowercase.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Reply with exactly the word PONG.' }] },
    ],
    providerOptions: low,
  });
  assert.equal(response.stopReason, 'stop');
  assert.match(outputText(response.message), /^pong\.?$/);
  assert.ok(response.id?.startsWith('resp_'));
  assert.ok((response.usage?.totalInput ?? 0) > 0);
  assert.equal(response.usage?.cost, undefined, 'billed to the plan: no cost');
  assert.equal(response.native.usage?.attribution, undefined);
  return summary(response);
});

await check('tool loop, full replay, three turns, with a cache key', async () => {
  const cacheKey = `acentric-live-${Date.now()}`;
  const messages: Message<'chatgpt'>[] = [
    { role: 'custom', tag: 'ui', data: 'never sent' },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Check Paris and Tokyo with the tool, one call at a time. Which is warmer?',
        },
      ],
    },
  ];
  const forecast = (args: string | undefined) => (/tokyo/i.test(args ?? '') ? '24°C' : '18°C');
  const options = { ...low, prompt_cache_key: cacheKey };
  let last: CompletionResponse<'chatgpt'> | undefined;
  let rounds = 0;
  while (rounds < 4) {
    last = await llm.complete({
      provider: 'chatgpt',
      model,
      instructions: 'Use the tools when asked.',
      messages,
      tools: [weather],
      providerOptions: options,
    });
    messages.push(last.message);
    const calls = pendingToolCalls(last.message);
    if (last.stopReason !== 'tool_use' || !calls.length) break;
    messages.push(...calls.map((call) => toolResult(call, forecast(call.arguments))));
    rounds += 1;
  }
  assert.ok(last && rounds >= 1, 'called the tool');
  assert.equal(last.stopReason, 'stop');
  assert.match(outputText(last.message), /Tokyo/);
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: 'Without tools: by how many degrees? Number only.' }],
  });
  const third = await llm.complete({
    provider: 'chatgpt',
    model,
    instructions: 'Use the tools when asked.',
    messages,
    tools: [weather],
    providerOptions: options,
  });
  assert.match(outputText(third.message), /6/);
  return { rounds, last: summary(last), third: summary(third), text: outputText(third.message) };
});

await check('a custom tool call and its result', async () => {
  const patch: ToolDefinition = {
    type: 'custom',
    name: 'apply_patch',
    description: 'Apply a patch in the *** Begin Patch format. Send the patch text only.',
  };
  const messages: Message<'chatgpt'>[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Use apply_patch to create hello.txt containing hi.' }],
    },
  ];
  const first = await llm.complete({
    provider: 'chatgpt',
    model,
    messages,
    tools: [patch],
    providerOptions: low,
  });
  const [call] = pendingToolCalls(first.message);
  assert.equal(first.stopReason, 'tool_use');
  assert.equal(call?.toolType, 'custom');
  assert.match(call?.input ?? '', /\*\*\* Begin Patch/);
  messages.push(first.message, toolResult(call!, 'Done: created hello.txt'));
  const second = await llm.complete({
    provider: 'chatgpt',
    model,
    messages,
    tools: [patch],
    providerOptions: low,
  });
  assert.equal(second.stopReason, 'stop');
  return { first: summary(first), input: call?.input, second: outputText(second.message) };
});

await check('reasoning summary, replayed encrypted', async () => {
  const messages: Message<'chatgpt'>[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'What is 1234 * 5678? Number only, no separators.' }],
    },
  ];
  const options = { reasoning: { effort: 'high', summary: 'auto' } } as const;
  const first = await llm.complete({
    provider: 'chatgpt',
    model,
    messages,
    providerOptions: options,
  });
  assert.match(outputText(first.message), /7006652/);
  const thought = first.message.content.find((item) => item.type === 'reasoning');
  assert.ok(thought && 'encrypted_content' in thought && thought.encrypted_content);
  messages.push(first.message, {
    role: 'user',
    content: [{ type: 'text', text: 'Add 48 to it. Number only, no separators.' }],
  });
  const second = await llm.complete({
    provider: 'chatgpt',
    model,
    messages,
    providerOptions: options,
  });
  assert.match(outputText(second.message), /7006700/);
  return {
    summary: reasoningSummary(first.message),
    first: summary(first),
    second: summary(second),
  };
});

await check('mid-conversation system message, image and PDF input', async () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PQQkAAAgAsetfWiP4FgYrsKZeS0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgsqnc8OJg6Ln3AAAAAElFTkSuQmCC';
  const pdf = Buffer.from(
    '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 40 Td (Banana42) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
  ).toString('base64');
  const response = await llm.complete({
    provider: 'chatgpt',
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What single color is this image, and what word is in the PDF?' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: png } },
          {
            type: 'file',
            filename: 'word.pdf',
            source: { type: 'base64', mediaType: 'application/pdf', data: pdf },
          },
        ],
      },
      {
        role: 'system',
        content: [{ type: 'text', text: 'Answer as COLOR / WORD, the color in uppercase.' }],
      },
    ],
    providerOptions: low,
  });
  assert.equal(response.stopReason, 'stop');
  assert.match(outputText(response.message), /red/i);
  assert.match(outputText(response.message), /Banana42/);
  return { ...summary(response), text: outputText(response.message) };
});

await check('structured output', async () => {
  const response = await llm.complete({
    provider: 'chatgpt',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Give the capital of Japan.' }] }],
    providerOptions: {
      ...low,
      text: {
        format: {
          type: 'json_schema',
          name: 'capital',
          strict: true,
          schema: {
            type: 'object',
            properties: { country: { type: 'string' }, capital: { type: 'string' } },
            required: ['country', 'capital'],
            additionalProperties: false,
          },
        },
      },
    },
  });
  const parsed = JSON.parse(outputText(response.message));
  assert.equal(parsed.capital, 'Tokyo');
  return parsed;
});

await check('a model the plan lacks is not_found on model', async () => {
  const error = await failure(() =>
    llm.complete({ provider: 'chatgpt', model: 'gpt-5.5', messages: hi }),
  );
  assert.deepEqual(
    [error.kind, error.providerParam, error.httpStatus],
    ['not_found', 'model', 400],
  );
  return brief(error);
});

await check('an unsupported field is invalid_request on that field', async () => {
  const error = await failure(() =>
    llm.complete({
      provider: 'chatgpt',
      model,
      messages: hi,
      providerOptions: { temperature: 0.5 } as never,
    }),
  );
  assert.deepEqual([error.kind, error.providerParam], ['invalid_request', 'temperature']);
  return brief(error);
});

// The backend ignores hosted tools in `additional_tools` without an error; the adapter refuses them.
await check('a hosted tool is refused before sending', async () => {
  const error = await failure(() =>
    llm.complete({
      provider: 'chatgpt',
      model,
      messages: hi,
      providerOptions: { tools: [{ type: 'web_search' }] },
    }),
  );
  assert.equal(error.kind, 'invalid_request');
  assert.equal(error.httpStatus, undefined);
  assert.match(error.message, /web_search tool/);
  return brief(error);
});

await check('foreign reasoning fails mid-stream as invalid_request', async () => {
  const error = await failure(() =>
    llm.complete({
      provider: 'chatgpt',
      model,
      messages: [
        {
          role: 'assistant',
          provider: 'chatgpt',
          api: 'openai-responses',
          model,
          content: [
            { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAnot-real' },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Hello.', annotations: [] }],
            },
          ],
        },
        ...hi,
      ],
    }),
  );
  assert.deepEqual(
    [error.kind, error.providerCode, error.providerParam],
    ['invalid_request', 'invalid_encrypted_content', 'input'],
  );
  return brief(error);
});

await check('a rejected token is auth', async () => {
  const error = await failure(() =>
    llm.complete({
      provider: 'chatgpt',
      credentials: { accessToken: 'not-a-token' },
      model,
      messages: hi,
    }),
  );
  assert.deepEqual([error.kind, error.httpStatus], ['auth', 401]);
  return brief(error);
});

await check('store, stream and file IDs are refused before sending', async () => {
  const store = await failure(() =>
    llm.complete({
      provider: 'chatgpt',
      model,
      messages: hi,
      providerOptions: { store: false } as never,
    }),
  );
  const fileId = await failure(() =>
    llm.complete({
      provider: 'chatgpt',
      model,
      messages: [
        { role: 'user', content: [{ type: 'file', source: { type: 'file_id', id: 'file_1' } }] },
      ],
    }),
  );
  assert.equal(store.kind, 'invalid_request');
  assert.equal(fileId.kind, 'invalid_request');
  return [store.message, fileId.message];
});

console.log(`mode: direct, model: ${model}`);
for (const [name, status, detail] of results) {
  console.log(`\n[${status}] ${name}`);
  console.log(JSON.stringify(detail, null, 1).replaceAll(login.accessToken, '<token>'));
}
process.exitCode = results.some(([, status]) => status === 'FAIL') ? 1 : 0;
