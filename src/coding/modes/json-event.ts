import type { AgentEvent } from "../../agent/types.ts";

type MessageUpdateEvent = Extract<AgentEvent, { type: "message_update" }>;

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

	const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
	return { type: "message_update", assistantMessageEvent: deltaEvent };
}
