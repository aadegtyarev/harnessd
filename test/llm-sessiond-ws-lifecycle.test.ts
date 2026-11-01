import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import {
	LlmSessiondClient,
	LlmSessiondProtocolError,
	type WebSocketFactory,
} from "../src/llm-sessiond/index.js";

class Socket extends EventEmitter {
	closeCalls = 0;
	close() {
		this.closeCalls++;
	}
	send(value: unknown) {
		this.emit("message", Buffer.from(JSON.stringify(value)));
	}
}
const event = {
	apiVersion: "v1",
	eventId: 1,
	sessionId: "8b1a9953-c461-4f90-9b89-8f9a9c9e9b40",
	at: "2026-11-01T00:00:00.000Z",
	type: "assistant.delta",
	data: { text: "x" },
};
function clientFor(socket: Socket) {
	const factory: WebSocketFactory = (_url, options) => {
		expect(options.handshakeTimeout).toBe(223);
		return socket as unknown as WebSocket;
	};
	return new LlmSessiondClient({
		baseUrl: "http://127.0.0.1:1234",
		timeoutMs: 123,
		webSocketFactory: factory,
	});
}

describe("WebSocket subscription lifecycle", () => {
	it("waits for close confirmation and clears buffered events after explicit close", async () => {
		const socket = new Socket();
		const sub = clientFor(socket).subscribe();
		socket.send(event);
		socket.send({ ...event, eventId: 2 });
		sub.close();
		let closed = false;
		void sub.closed.then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		expect(socket.closeCalls).toBe(1);
		socket.send({ ...event, eventId: 3 });
		socket.emit("close");
		await sub.closed;
		expect(await sub.next()).toEqual({ done: true, value: undefined });
	});

	it("calls iterator return on consumer break and confirms closure separately", async () => {
		const socket = new Socket();
		const sub = clientFor(socket).subscribe();
		socket.send(event);
		for await (const _value of sub) break;
		expect(socket.closeCalls).toBe(1);
		socket.emit("close");
		await sub.closed;
	});

	it("classifies malformed JSON and closes the socket", async () => {
		const socket = new Socket();
		const sub = clientFor(socket).subscribe();
		socket.emit("message", Buffer.from("not json"));
		await expect(sub.next()).rejects.toMatchObject({ kind: "json" });
		expect(socket.closeCalls).toBe(1);
		socket.emit("close");
		await sub.closed;
	});

	it("clears buffered events and closes on malformed input", async () => {
		const socket = new Socket();
		const sub = clientFor(socket).subscribe();
		socket.send(event);
		socket.send({ ...event, surprise: true });
		await expect(sub.next()).rejects.toBeInstanceOf(LlmSessiondProtocolError);
		expect(socket.closeCalls).toBe(1);
		socket.emit("close");
		await sub.closed;
	});
});
