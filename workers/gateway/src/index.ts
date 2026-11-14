import {
  LlmError,
  ROUTES,
  type ModelInfo,
  type ModelsResponse,
  type Provider,
} from '@acentric-llm/contracts';
import { complete, MODELS, parseCompletionRequest } from '@acentric-llm/providers';
import { errorResponse, HttpError, json, preflight, readJson } from './http.ts';

/**
 * Providers a Worker cannot reach, and why. Cloudflare adds `CF-Worker` to
 * every request a Worker makes, and chatgpt.com answers those with a 403 page.
 */
const DIRECT_ONLY: { readonly [P in Provider]?: string } = {
  chatgpt:
    'ChatGPT refuses requests from Cloudflare Workers, so the gateway cannot call it. ' +
    "Use the SDK's direct client (createDirectClient from @acentric-cloud/llm/direct).",
};

const MODELS_RESPONSE: ModelsResponse = {
  models: (Object.entries(MODELS) as [Provider, readonly ModelInfo[]][])
    .filter(([provider]) => DIRECT_ONLY[provider] === undefined)
    .flatMap(([, models]) => models),
};

/** Stateless: nothing is stored, and request bodies (credentials, content, tools) are never logged. */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      switch (pathname) {
        case ROUTES.complete:
          if (request.method === 'OPTIONS') return preflight('POST');
          allow(request, 'POST');
          return json(
            await complete(served(parseCompletionRequest(await readJson(request))), {
              signal: request.signal,
            }),
          );
        case ROUTES.models:
          if (request.method === 'OPTIONS') return preflight('GET');
          allow(request, 'GET');
          return json(MODELS_RESPONSE);
        default:
          throw new HttpError(404, `No route for ${pathname}.`);
      }
    } catch (error) {
      return errorResponse(error);
    }
  },
};

function served<T extends { readonly provider: Provider }>(request: T): T {
  const reason = DIRECT_ONLY[request.provider];
  if (reason !== undefined) {
    throw new LlmError(reason, { kind: 'invalid_request', provider: request.provider });
  }
  return request;
}

function allow(request: Request, method: string): void {
  if (request.method !== method) {
    throw new HttpError(405, `${request.method} is not allowed; use ${method}.`, {
      allow: `${method}, OPTIONS`,
    });
  }
}
