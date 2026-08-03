import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { ProviderName } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import { truncateField } from '@src/integration/ai/providers/_engine/truncate-debug-field.ts';

/**
 * Shared per-line debug-event emitters for the three headless provider adapters.
 *
 * Every adapter fans its provider stream out as `{ type: 'log', level: 'debug' }` AppEvents in
 * one of three shapes — `assistant`, `tool_use`, `tool_result` — and the TUI plus the persistent
 * `events.ndjson` sink key off the exact `'<provider>: <kind>'` message text and the `meta` field
 * names. Owning the envelope here keeps that contract in one place: each adapter only extracts
 * its own wire format (Claude's `message.content[]` blocks, Codex's `item.completed` records,
 * Copilot's parsed `bodyText`) and hands the extracted strings over.
 *
 * All three emitters funnel free-form stream text through {@link truncateField}, so a multi-KB
 * assistant turn or tool input never bloats a single log record.
 *
 * These events are published DIRECTLY to the EventBus — there is no producer-side gate here.
 * `createEventBusLogger` is a producer that *publishes* `log` AppEvents, not a filter, so it does
 * not drop anything emitted at this site. The only UI-floor gate is the coalescing forwarder in
 * `launch.ts`, which applies the live log-level floor at ingest before the TUI ever sees a line.
 * The persistent events.ndjson sink writes every event here verbatim, regardless of the UI floor.
 */

/**
 * One `assistant` debug event carrying the turn's text. Publishes nothing when the text is
 * absent / blank — an empty assistant record is noise, not signal.
 */
export const publishAssistantEvent = (
  eventBus: EventBus,
  providerName: ProviderName,
  rawText: string | undefined
): void => {
  const text = truncateField(rawText);
  if (text === undefined) return;
  eventBus.publish({
    type: 'log',
    level: 'debug',
    message: `${providerName}: assistant`,
    meta: { text },
    at: IsoTimestamp.now(),
  });
};

/**
 * One `tool_use` debug event. `rawArgs` is the provider's own one-line preview of the tool input;
 * the `args` key is omitted entirely when the call carries no input.
 */
export const publishToolUseEvent = (
  eventBus: EventBus,
  providerName: ProviderName,
  tool: string,
  rawArgs: string | undefined
): void => {
  const args = truncateField(rawArgs);
  eventBus.publish({
    type: 'log',
    level: 'debug',
    message: `${providerName}: tool_use`,
    meta: {
      tool,
      ...(args !== undefined ? { args } : {}),
    },
    at: IsoTimestamp.now(),
  });
};

/**
 * One `tool_result` debug event. `preview` is the provider's flattened result body; the key is
 * omitted when the result carried no readable content.
 */
export const publishToolResultEvent = (
  eventBus: EventBus,
  providerName: ProviderName,
  tool: string,
  status: 'ok' | 'error',
  rawPreview: string | undefined
): void => {
  const preview = truncateField(rawPreview);
  eventBus.publish({
    type: 'log',
    level: 'debug',
    message: `${providerName}: tool_result`,
    meta: {
      tool,
      status,
      ...(preview !== undefined ? { preview } : {}),
    },
    at: IsoTimestamp.now(),
  });
};
