// The server-sent events of a streamed create-response call, read into the
// one response they end with. Pure.

import { LlmError } from '@acentric-llm/contracts';
import { invalidResponse, isRecord, type JsonRecord } from '../../shared.ts';

const TERMINAL: ReadonlySet<unknown> = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
]);

/**
 * The response an event stream ends with, as a create-response body: the
 * terminal event's response (completed, incomplete or failed), or `{ error }`
 * for an `error` event. A terminal response without output gets the items of
 * the `response.output_item.done` events, in output order, as Codex reads them.
 */
export function readEvents(text: string, provider: string, label: string): JsonRecord {
  const done: { readonly index: number; readonly item: JsonRecord }[] = [];
  for (const data of eventData(text)) {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw invalidResponse(
        provider,
        `${label} sent an event that is not JSON.`,
        data.slice(0, 4096),
      );
    }
    if (!isRecord(event)) continue;
    if (event.type === 'response.output_item.done' && isRecord(event.item)) {
      const index = typeof event.output_index === 'number' ? event.output_index : done.length;
      done.push({ index, item: event.item });
    } else if (TERMINAL.has(event.type)) {
      const response = event.response;
      if (!isRecord(response)) {
        throw invalidResponse(
          provider,
          `${label} sent ${String(event.type)} without a response.`,
          event,
        );
      }
      const output =
        Array.isArray(response.output) && response.output.length
          ? response.output
          : done.sort((a, b) => a.index - b.index).map(({ item }) => item);
      return { ...response, output };
    } else if (event.type === 'error') {
      // `{ type, error: {...} }`, or the error's fields on the event itself.
      const { type: _type, sequence_number: _sequence, ...fields } = event;
      return { error: isRecord(event.error) ? event.error : fields };
    }
  }
  throw new LlmError(`${label} ended the stream before the response finished.`, {
    provider,
    kind: 'provider_error',
  });
}

/** The `data` of each event, its lines joined; comments and `[DONE]` are skipped. */
function eventData(text: string): string[] {
  const events: string[] = [];
  for (const block of text.split(/\r\n\r\n|\n\n|\r\r/)) {
    const data = block
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5));
    if (data.length && data.join('') !== '[DONE]') events.push(data.join('\n'));
  }
  return events;
}
