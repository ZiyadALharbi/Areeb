import type { AssistantMessageEvent } from "./events.ts";
import type { AssistantMessage } from "./types.ts";

interface EventWaiter<TEvent> {
	resolve: (result: IteratorResult<TEvent>) => void;
	reject: (error: unknown) => void;
}

type StreamState<TResult> =
	| { status: "open" }
	| { status: "completed"; result: TResult }
	| { status: "failed"; error: unknown };

/**
 * A push-driven, single-consumer event stream with a final result.
 */
export class EventStream<TEvent, TResult = TEvent>
	implements AsyncIterable<TEvent>
{
	private readonly events: TEvent[] = []; // buffered events that have not been consumed.
	private readonly waiters: EventWaiter<TEvent>[] = []; // pending `next()` calls waiting for events.
	private readonly finalResult: Promise<TResult>;
	private resolveResult!: (result: TResult) => void;
	private rejectResult!: (error: unknown) => void;
	private state: StreamState<TResult> = { status: "open" };
	private iteratorCreated = false;

	/**
	 *
	 * The constructor receives two policies:
	 * 1. How to identify a terminal event.
	 * 2. How to get the final result from it.
	 *
	 * This keeps `EventStream` generic. It knows nothing about assistant messages or `"done"` events.
	 */

	constructor(
		private readonly isTerminalEvent: (event: TEvent) => boolean,
		private readonly resultFromTerminalEvent: (event: TEvent) => TResult,
	) {
		this.finalResult = new Promise<TResult>((resolve, reject) => {
			this.resolveResult = resolve;
			this.rejectResult = reject;
		});

		// A producer may fail before result() is observed. Attaching a handler
		// keeps that valid ordering from producing an unhandled rejection.
		void this.finalResult.catch(() => undefined);
	}

	push(event: TEvent): void {
		this.assertOpen("emit an event");

		let completion:
			| { isTerminal: false }
			| { isTerminal: true; result: TResult };

		try {
			completion = this.isTerminalEvent(event)
				? {
						isTerminal: true,
						result: this.resultFromTerminalEvent(event),
					}
				: { isTerminal: false };
		} catch (error) {
			this.failOpenStream(error);
			throw error;
		}

		if (completion.isTerminal) {
			this.state = { status: "completed", result: completion.result };
			this.resolveResult(completion.result);
		}

		this.emit(event);

		if (completion.isTerminal) {
			this.closePendingIteration();
		}
	}

	/**
	 * Completes a stream that does not use a terminal event for settlement.
	 */
	end(result: TResult): void {
		this.assertOpen("complete the event stream");
		this.state = { status: "completed", result };
		this.resolveResult(result);
		this.closePendingIteration();
	}

	/**
	 * Fails the stream for an unexpected producer or implementation error.
	 *
	 * Expected provider failures should be represented by terminal events.
	 */
	fail(error: unknown): void {
		this.assertOpen("fail the event stream");
		this.failOpenStream(error);
	}

	result(): Promise<TResult> {
		return this.finalResult;
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<TEvent> {
		if (this.iteratorCreated) {
			throw new Error("EventStream supports only one iterator");
		}

		this.iteratorCreated = true;
		return {
			next: () => this.nextEvent(),
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}

	private assertOpen(action: string): void {
		if (this.state.status !== "open") {
			throw new Error(
				`Cannot ${action} after the event stream has ${this.state.status}`,
			);
		}
	}

	private emit(event: TEvent): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.events.push(event);
		}
	}

	private nextEvent(): Promise<IteratorResult<TEvent>> {
		if (this.events.length > 0) {
			const event = this.events.shift() as TEvent;
			return Promise.resolve({ value: event, done: false });
		}

		switch (this.state.status) {
			case "completed":
				return Promise.resolve({ value: undefined, done: true });
			case "failed":
				return Promise.reject(this.state.error);
			case "open":
				return new Promise<IteratorResult<TEvent>>((resolve, reject) => {
					this.waiters.push({ resolve, reject });
				});
		}
	}

	private failOpenStream(error: unknown): void {
		this.state = { status: "failed", error };
		this.rejectResult(error);

		while (this.waiters.length > 0) {
			this.waiters.shift()?.reject(error);
		}
	}

	private closePendingIteration(): void {
		while (this.waiters.length > 0) {
			this.waiters.shift()?.resolve({ value: undefined, done: true });
		}
	}
}

export class AssistantMessageEventStream extends EventStream<
	AssistantMessageEvent,
	AssistantMessage
> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done" || event.type === "error") {
					return event.message;
				}

				throw new Error(
					"Cannot extract an AssistantMessage from a non-terminal event",
				);
			},
		);
	}
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
