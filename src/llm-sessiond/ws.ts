import WebSocket from "ws";
import {
	LlmSessiondProtocolError,
	LlmSessiondTransportError,
} from "./errors.js";
import { eventPayloadSchemas, eventSchema } from "./event-schema.js";
import type { EventEnvelope, EventPayload } from "./types.js";

export type WebSocketFactory = (url: string) => WebSocket;
export type Subscription = AsyncIterableIterator<EventEnvelope> & {
	close(): void;
	closed: Promise<void>;
	error?: Error;
};
type Waiter = {
	resolve(value: IteratorResult<EventEnvelope>): void;
	reject(error: Error): void;
};

export function subscribe(
	baseUrl: string,
	sessionId?: string,
	factory: WebSocketFactory = (url) => new WebSocket(url),
): Subscription {
	const url = new URL(`${baseUrl.replace(/^http/, "ws")}/api/v1/events`);
	if (sessionId !== undefined) url.searchParams.set("sessionId", sessionId);
	const socket = factory(url.toString());
	const queue: EventEnvelope[] = [];
	const waiters: Waiter[] = [];
	let ended = false;
	let failure: Error | undefined;
	let closeResolve!: () => void;
	const closed = new Promise<void>((resolve) => {
		closeResolve = resolve;
	});
	const finish = (error?: Error) => {
		if (ended) return;
		ended = true;
		failure = error;
		closeResolve();
		for (const waiter of waiters.splice(0))
			error
				? waiter.reject(error)
				: waiter.resolve({ done: true, value: undefined });
	};
	const iterator: Subscription = {
		closed,
		get error() {
			return failure;
		},
		close() {
			socket.close();
			finish();
		},
		[Symbol.asyncIterator]() {
			return this;
		},
		next() {
			const event = queue.shift();
			if (event) return Promise.resolve({ done: false, value: event });
			if (failure) return Promise.reject(failure);
			if (ended) return Promise.resolve({ done: true, value: undefined });
			return new Promise((resolve, reject) =>
				waiters.push({ resolve, reject }),
			);
		},
	};
	socket.on("message", (data) => {
		try {
			const raw = JSON.parse(data.toString()) as unknown;
			const envelope = eventSchema.parse(raw);
			const payload = eventPayloadSchemas[envelope.type].parse(
				envelope.data,
			) as EventPayload;
			const event = { ...envelope, data: payload } as EventEnvelope;
			const waiter = waiters.shift();
			waiter
				? waiter.resolve({ done: false, value: event })
				: queue.push(event);
		} catch {
			const error = new LlmSessiondProtocolError(
				"schema",
				"WebSocket event did not match API v1 schema",
			);
			finish(error);
			socket.close();
		}
	});
	socket.on("error", () =>
		finish(
			new LlmSessiondTransportError("network", "WebSocket connection failed"),
		),
	);
	socket.on("close", () => finish());
	return iterator;
}
