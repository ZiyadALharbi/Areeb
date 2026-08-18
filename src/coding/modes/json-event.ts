import type { AgentEvent } from "../../agent/types.ts";

type MessageUpdateEvent = Extract<AgentEvent, { type: "message_update" }>;

// Streaming partials are cumulative snapshots. Keeping them would make a JSON
// transcript grow quadratically as an assistant response becomes longer.
type WithoutPartial<TEvent> = TEvent extends { partial: unknown }
	? Omit<TEvent, "partial">
	: TEvent;

type ToJsonAgentEvent<TEvent> = TEvent extends {
	type: "message_update";
	assistantMessageEvent: infer TAssistantMessageEvent;
}
	? {
			type: "message_update";
			assistantMessageEvent: WithoutPartial<TAssistantMessageEvent>;
		}
	: TEvent;

/** Public JSON Lines wire shape emitted by the JSON renderer. */
export type JsonAgentEvent = ToJsonAgentEvent<AgentEvent>;
export type JsonAssistantMessageEvent = Extract<
	JsonAgentEvent,
	{ type: "message_update" }
>["assistantMessageEvent"];

export function toJsonAgentEvent(
	event: MessageUpdateEvent,
): Extract<JsonAgentEvent, { type: "message_update" }>;
export function toJsonAgentEvent(event: AgentEvent): JsonAgentEvent;
export function toJsonAgentEvent(event: AgentEvent): JsonAgentEvent {
	if (event.type !== "message_update") {
		return event;
	}

	const assistantMessageEvent = event.assistantMessageEvent;
	if (!("partial" in assistantMessageEvent)) {
		return { type: "message_update", assistantMessageEvent };
	}

	// Constructing a new event also drops AgentEvent.message, the second
	// cumulative snapshot carried by message_update events.
	const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
	return { type: "message_update", assistantMessageEvent: deltaEvent };
}
