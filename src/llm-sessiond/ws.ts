import WebSocket from "ws";
import {
	LlmSessiondProtocolError,
	LlmSessiondTransportError,
} from "./errors.js";
import { parseEvent } from "./ws-event.js";
import { EventSubscription, type Subscription } from "./ws-subscription.js";

export type WebSocketOptions = { handshakeTimeout: number };
export type WebSocketFactory = (
	url: string,
	options: WebSocketOptions,
) => WebSocket;

export function subscribe(
	baseUrl: string,
	sessionId: string | undefined,
	factory: WebSocketFactory | undefined,
	timeoutMs: number,
): Subscription {
	const url = new URL(`${baseUrl.replace(/^http/, "ws")}/api/v1/events`);
	if (sessionId !== undefined) url.searchParams.set("sessionId", sessionId);
	let socket: WebSocket;
	try {
		socket = (
			factory ?? ((address, options) => new WebSocket(address, options))
		)(url.toString(), { handshakeTimeout: timeoutMs + 100 });
	} catch {
		throw new LlmSessiondTransportError(
			"network",
			"WebSocket connection failed",
		);
	}
	let deadline: ReturnType<typeof setTimeout>;
	const subscription = new EventSubscription(() => {
		clearTimeout(deadline);
		socket.close();
	});
	deadline = setTimeout(
		() =>
			subscription.fail(
				new LlmSessiondTransportError(
					"timeout",
					"WebSocket connection timed out",
				),
			),
		timeoutMs,
	);
	socket.once("open", () => clearTimeout(deadline));
	socket.on("message", (data) => {
		if (subscription.isTerminal) return;
		try {
			subscription.push(parseEvent(data.toString()));
		} catch (error) {
			const safe =
				error instanceof LlmSessiondProtocolError
					? error
					: new LlmSessiondProtocolError(
							"schema",
							"WebSocket event was invalid",
						);
			subscription.fail(safe);
		}
	});
	socket.on("error", () => {
		if (!subscription.isTerminal)
			subscription.fail(
				new LlmSessiondTransportError("network", "WebSocket connection failed"),
			);
	});
	socket.on("close", () => {
		clearTimeout(deadline);
		subscription.socketClosed();
	});
	return subscription;
}
