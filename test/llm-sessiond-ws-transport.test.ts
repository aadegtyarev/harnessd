import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import type WebSocket from "ws";
import {
	LlmSessiondClient,
	LlmSessiondTransportError,
	type WebSocketFactory,
} from "../src/llm-sessiond/index.js";

const servers: ReturnType<typeof createServer>[] = [];
const upgraded: import("node:stream").Duplex[] = [];
afterEach(async () => {
	for (const socket of upgraded.splice(0)) socket.destroy();
	const active = servers.splice(0);
	for (const server of active) server.closeAllConnections();
	await Promise.all(
		active.map(
			(server) => new Promise<void>((resolve) => server.close(() => resolve())),
		),
	);
});

it("redacts synchronous WebSocket factory exceptions", () => {
	const factory: WebSocketFactory = () => {
		throw new Error("private factory details");
	};
	const client = new LlmSessiondClient({
		baseUrl: "http://127.0.0.1:1234",
		webSocketFactory: factory,
	});
	expect(() => client.subscribe()).toThrow(LlmSessiondTransportError);
	expect(() => client.subscribe()).toThrow("WebSocket connection failed");
});

it("times out and closes a WebSocket handshake that never upgrades", async () => {
	const server = createServer();
	server.on("upgrade", (_request, socket) => upgraded.push(socket));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("fixture failed");
	const sub = new LlmSessiondClient({
		baseUrl: `http://127.0.0.1:${address.port}`,
		timeoutMs: 60,
	}).subscribe();
	await expect(sub.next()).rejects.toMatchObject({
		kind: "timeout",
		message: "llm-sessiond transport error: WebSocket connection timed out",
	});
	await sub.closed;
});

it("maps WebSocket transport errors, closes the socket, and clears buffered events", async () => {
	class Socket extends EventEmitter {
		closeCalls = 0;
		close() {
			this.closeCalls++;
		}
	}
	const socket = new Socket();
	const factory: WebSocketFactory = () => socket as unknown as WebSocket;
	const sub = new LlmSessiondClient({
		baseUrl: "http://127.0.0.1:1234",
		webSocketFactory: factory,
	}).subscribe();
	socket.emit(
		"message",
		Buffer.from(
			JSON.stringify({
				apiVersion: "v1",
				eventId: 1,
				sessionId: "8b1a9953-c461-4f90-9b89-8f9a9c9e9b40",
				at: "2026-11-01T00:00:00.000Z",
				type: "assistant.delta",
				data: { text: "queued" },
			}),
		),
	);
	socket.emit("error", new Error("private transport details"));
	await expect(sub.next()).rejects.toBeInstanceOf(LlmSessiondTransportError);
	expect(sub.error?.message).toBe(
		"llm-sessiond transport error: WebSocket connection failed",
	);
	expect(socket.closeCalls).toBe(1);
	socket.emit("close");
	await sub.closed;
});
