import { describe, expect, it } from "vitest";
import type { InputId } from "../src/core/types.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { MAX_CLAUDE_RECORD_BYTES } from "../src/harness/claude-jsonl.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

describe("Claude fatal protocol handling", () => {
	it("projects nothing after mismatched init, even with following records", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		const send = instance.send({
			id: "i" as InputId,
			sessionId: launchRequest.sessionId,
			text: "prompt",
			createdAt: new Date(),
		});
		fake.record({ type: "system", subtype: "init", session_id: "wrong" });
		fake.record({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				delta: { type: "text_delta", text: "must-not-leak" },
			},
		});
		fake.record({
			type: "result",
			subtype: "success",
			session_id: launchRequest.sessionId,
			is_error: false,
			result: "false success",
		});
		await expect(send).rejects.toMatchObject({ inputId: "i" });
		await expect(
			instance.send({
				id: "later" as InputId,
				sessionId: launchRequest.sessionId,
				text: "not sent",
				createdAt: new Date(),
			}),
		).rejects.toThrow("CLAUDE_NOT_READY_OR_BUSY");
		const iterator = instance.events[Symbol.asyncIterator]();
		expect(await iterator.next()).toMatchObject({
			value: { kind: "error", fatal: true },
			done: false,
		});
		expect(await iterator.next()).toMatchObject({ done: true });
		fake.finish();
	});

	it("fails closed on missing init identity and bounds outbound envelopes", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
			acknowledgementTimeoutMs: 10,
		}).launch(launchRequest);
		const input = {
			id: "i" as InputId,
			sessionId: launchRequest.sessionId,
			text: "x".repeat(MAX_CLAUDE_RECORD_BYTES),
			createdAt: new Date(),
		};
		await expect(instance.send(input)).rejects.toThrow(
			"CLAUDE_INPUT_TOO_LARGE",
		);
		expect(fake.inputLines()).toEqual([]);
		const waiting = instance.send({
			...input,
			id: "small" as InputId,
			text: "small",
		});
		fake.record({ type: "system", subtype: "init" });
		await expect(waiting).rejects.toMatchObject({ inputId: "small" });
		fake.finish();
	});
});
