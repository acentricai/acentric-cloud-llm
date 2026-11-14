// Compile-time checks for ChatGPT's registry entry, run by `pnpm check`.
import { test } from 'node:test';
import type {
  AssistantMessage,
  ChatGptOutputItem,
  CompletionRequest,
  CompletionResponse,
  NativeMessage,
} from '../src/index.ts';

const reply: AssistantMessage<'chatgpt'> = {
  role: 'assistant',
  provider: 'chatgpt',
  api: 'openai-responses',
  model: 'gpt-6-luna',
  id: 'resp_1',
  content: [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read',
      arguments: '{"path":"a"}',
      status: 'completed',
    },
    { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_2', name: 'apply_patch', input: 'x' },
  ],
};

const request: CompletionRequest<'chatgpt'> = {
  provider: 'chatgpt',
  credentials: { accessToken: 'token', accountId: 'account' },
  model: 'gpt-6.1-sol',
  instructions: 'Be brief.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Read a.' }] },
    reply,
    {
      role: 'tool_result',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'contents' }],
    },
  ],
  providerOptions: {
    reasoning: { effort: 'ultra', summary: 'auto' },
    prompt_cache_key: 'thread-1',
    service_tier: 'priority',
    tools: [{ type: 'tool_search', execution: 'client', description: 'Find tools.' }],
  },
};

// Tools added mid-conversation travel in a native message.
const added: NativeMessage<'chatgpt'> = {
  role: 'native',
  provider: 'chatgpt',
  api: 'openai-responses',
  content: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'function' }] }],
};

const anonymous: CompletionRequest<'chatgpt'> = {
  ...request,
  // @ts-expect-error an access token, not an API key
  credentials: { apiKey: 'sk-test' },
};

const stored: CompletionRequest<'chatgpt'> = {
  ...request,
  // @ts-expect-error never stored: the adapter sets store
  providerOptions: { store: false },
};

const sampled: CompletionRequest<'chatgpt'> = {
  ...request,
  // @ts-expect-error the backend refuses sampling settings
  providerOptions: { temperature: 0.5 },
};

const chained: CompletionRequest<'chatgpt'> = {
  ...request,
  // @ts-expect-error no stored responses to chain on
  providerOptions: { previous_response_id: 'resp_1' },
};

function narrowItems(item: ChatGptOutputItem): string | undefined {
  switch (item.type) {
    case 'function_call':
      return item.arguments;
    case 'custom_tool_call':
      return item.input;
    default:
      return undefined;
  }
}

function tier(response: CompletionResponse<'chatgpt'>): string | null | undefined {
  return response.native.service_tier;
}

void [added, anonymous, stored, sampled, chained, narrowItems, tier];

test('ChatGPT types compile', () => {});
