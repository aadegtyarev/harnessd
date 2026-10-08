import { describe, expect, it } from "vitest";
import type { SessionId } from "../src/core/types.js";
import {
	ClaudeEventQueue,
	MAX_CLAUDE_QUEUED_BYTES,
	MAX_CLAUDE_QUEUED_EVENTS,
} from "../src/harness/claude-event-queue.js";

const event = {
	sessionId: "s" as SessionId,
	kind: "status" as const,
	text: "ready",
};

describe("Claude event queue bounds", () => {
	it("enforces the pending-byte boundary", () => {
		const queue = new ClaudeEventQueue();
		expect(
			queue.push({ ...event, text: "x".repeat(MAX_CLAUDE_QUEUED_BYTES - 128) }),
		).toBe(true);
		expect(queue.push(event)).toBe(false);
	});
	it("rejects events beyond capacity and preserves explicit fatal overflow", async () => {
		const queue = new ClaudeEventQueue();
		for (let index = 0; index < MAX_CLAUDE_QUEUED_EVENTS; index++)
			expect(queue.push(event)).toBe(true);
		expect(queue.push(event)).toBe(false);
		queue.fail({
			sessionId: event.sessionId,
			kind: "error",
			text: "Claude event queue overflow",
			fatal: true,
		});
		const iterator = queue[Symbol.asyncIterator]();
		expect(await iterator.next()).toMatchObject({
			value: { kind: "error", fatal: true },
			done: false,
		});
		expect(await iterator.next()).toMatchObject({ done: true });
	});
});
