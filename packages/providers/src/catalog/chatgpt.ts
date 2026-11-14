import type { ModelInfo } from '@acentric-llm/contracts';

// The models the Codex backend lists for a ChatGPT plan, from
// GET https://chatgpt.com/backend-api/codex/models on 2026-10-21 (visibility
// `list`; Daybreak, a cyber-defense model, is left out). Every one is a
// Responses Lite model. Usage is billed to the plan, so there is no pricing
// and no cost estimate. Input: text and images as listed, and PDFs, which
// worked live. The list is per account; a model the plan lacks is a 400.

export const CHATGPT_MODELS = [
  {
    provider: 'chatgpt',
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1-Sol',
    contextWindow: 500_000,
    input: ['text', 'image', 'file'],
  },
  {
    provider: 'chatgpt',
    id: 'gpt-6-astra',
    name: 'GPT-6-Astra',
    contextWindow: 272_000,
    input: ['text', 'image', 'file'],
  },
  {
    provider: 'chatgpt',
    id: 'gpt-6-sol',
    name: 'GPT-6-Sol',
    contextWindow: 272_000,
    input: ['text', 'image', 'file'],
  },
  {
    provider: 'chatgpt',
    id: 'gpt-6-luna',
    name: 'GPT-6-Luna',
    contextWindow: 272_000,
    input: ['text', 'image', 'file'],
  },
  {
    provider: 'chatgpt',
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    contextWindow: 272_000,
    input: ['text', 'image', 'file'],
  },
  {
    provider: 'chatgpt',
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    contextWindow: 272_000,
    input: ['text', 'image', 'file'],
  },
  {
    provider: 'chatgpt',
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6-Luna',
    contextWindow: 272_000,
    input: ['text', 'image', 'file'],
  },
] as const satisfies readonly ModelInfo<'chatgpt'>[];
