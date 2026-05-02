import type { AgentEvent, AgentEventListener } from "./types.js";

/**
 * Tiny synchronous pub/sub bus shared between the agents in a single
 * process and any observer (e.g. the demo app's web server). We
 * deliberately avoid Node's `EventEmitter` here because:
 *
 *   - we only ever emit one event type, so the typed surface is
 *     clearer as a single `on(listener)` call,
 *   - some consumers run in non-Node environments (browser-side mock
 *     harness) where `events` isn't available.
 *
 * The bus is best-effort: a listener that throws is caught and logged
 * to `console.warn`; the throw never propagates to the emitter so a
 * misbehaving observer can't break agent execution.
 */
export class AgentEventBus {
  private readonly _listeners = new Set<AgentEventListener>();

  on(listener: AgentEventListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  off(listener: AgentEventListener): void {
    this._listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[AgentEventBus] listener threw:", err);
      }
    }
  }

  /** Number of registered listeners. Useful for tests / health checks. */
  get listenerCount(): number {
    return this._listeners.size;
  }
}

/** Build an empty event bus. Equivalent to `new AgentEventBus()`. */
export function createAgentEventBus(): AgentEventBus {
  return new AgentEventBus();
}

/**
 * `JSON.stringify`-compatible replacer that handles the two shapes
 * agent events routinely embed but which `JSON.stringify` chokes on
 * out of the box:
 *
 *   - `bigint`: ERC-8183 / iNFT job ids, on-chain budgets, token ids
 *     all flow as bigints. The stock encoder throws `TypeError`,
 *     which silently drops the event from any IPC pipe (stdout,
 *     SSE bridge, postMessage, etc).
 *   - `function`: every now and then a payload smuggles in a thunk
 *     (e.g. an `AttestationBundle.getAttestation` accessor); JSON
 *     can't represent it, so we omit it rather than letting the
 *     stringifier emit `undefined` and corrupt the JSON shape.
 *
 * Use as the second arg to `JSON.stringify` whenever an event is
 * crossing a process / network boundary.
 */
export function agentEventJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return undefined;
  return value;
}

/**
 * Convenience wrapper around {@link agentEventJsonReplacer}. Returns
 * the JSON-encoded form of an arbitrary IPC payload that contains an
 * agent event (`{ source, event }` shape on the example app, plain
 * `{ type, ... }` for direct emits). Equivalent to
 * `JSON.stringify(payload, agentEventJsonReplacer)` — kept here as a
 * one-liner so call sites stay readable.
 */
export function serializeAgentEvent(payload: unknown): string {
  return JSON.stringify(payload, agentEventJsonReplacer);
}
