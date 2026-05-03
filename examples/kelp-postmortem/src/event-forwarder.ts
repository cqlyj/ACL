import { type AgentEvent, type AgentEventBus, serializeAgentEvent } from "@acl/agent";

/**
 * Pipe every event the SDK emits into the coordinator's `/api/event`
 * endpoint so the web UI can re-broadcast over SSE. Each agent process
 * gets one of these wired up at boot. We pass the payload through
 * `serializeAgentEvent(...)` to keep `bigint` fields + accessor
 * functions from corrupting the JSON shape.
 */
export function forwardEventsToCoordinator(opts: {
  events: AgentEventBus;
  coordinatorUrl: string;
  source: "client" | "provider-security" | "provider-generalist" | "evaluator";
}): () => void {
  const off = opts.events.on(async (event: AgentEvent) => {
    try {
      const body = serializeAgentEvent({ source: opts.source, event });
      await fetch(`${opts.coordinatorUrl}/api/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (err) {
      console.warn(`[forward-events] ${opts.source}: ${(err as Error).message}`);
    }
  });
  return off;
}
