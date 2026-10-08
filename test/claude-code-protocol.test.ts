import { describe, expect, it } from "vitest";
import type { InputId } from "../src/core/types.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

const input = (id: string, text: string) => ({
	id: id as InputId,
	sessionId: launchRequest.sessionId,
	text,
	createdAt: new Date(),
});
const init = {
	type: "system",
	subtype: "init",
	session_id: launchRequest.sessionId,
};
const acknowledgement = (text: string) => ({
	type: "user",
	isReplay: true,
	message: { role: "user", content: text },
});
const result = {
	type: "result",
	subtype: "success",
	session_id: launchRequest.sessionId,
	is_error: false,
	result: "ok",
};

describe("Claude Code stream protocol", () => {
	it("fails closed with non-interrupting denial when no permission UI is available", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		const sent = instance.send(input("deny-input", "read"));
		fake.record(init);
		fake.record(acknowledgement("read"));
		await sent;
		fake.record({
			type: "control_request",
			request_id: "deny-1",
			request: {
				subtype: "can_use_tool",
				tool_name: "Read",
				input: { path: "/tmp/a" },
			},
		});
		await new Promise((resolve) => setImmediate(resolve));
		const response = fake
			.inputLines()
			.map((line) => JSON.parse(line))
			.find((line) => line.type === "control_response");
		expect(response.response.response).toEqual({
			behavior: "deny",
			message: "Permission prompt unavailable",
			interrupt: false,
		});
		fake.record(result);
		await instance.shutdown();
	});

	it("cancels only the matching permission request and never responds after cancellation", async () => {
		const fake = fakeProvider();
		let notify!: (signal: AbortSignal) => void;
		const entered = new Promise<AbortSignal>((resolve) => {
			notify = resolve;
		});
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch({
			...launchRequest,
			toolPermissionHandler(request) {
				notify(request.signal);
				return new Promise(() => {});
			},
		});
		const sent = instance.send(input("cancel-input", "read"));
		fake.record(init);
		fake.record(acknowledgement("read"));
		await sent;
		fake.record({
			type: "control_request",
			request_id: "cancel-1",
			request: { subtype: "can_use_tool", tool_name: "Read", input: {} },
		});
		const signal = await entered;
		fake.record({ type: "control_cancel_request", request_id: "cancel-1" });
		expect(signal.aborted).toBe(true);
		await new Promise((resolve) => setImmediate(resolve));
		expect(fake.inputLines().join("")).not.toContain("control_response");
		fake.record(result);
		await instance.shutdown();
	});

	it("invalidates a pending permission at settlement and ignores duplicate IDs", async () => {
		const fake = fakeProvider();
		let resolveDecision!: (decision: { behavior: "allow" }) => void;
		let entered!: () => void;
		const seen = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch({
			...launchRequest,
			toolPermissionHandler() {
				entered();
				return new Promise((resolve) => {
					resolveDecision = resolve;
				});
			},
		});
		const sent = instance.send(input("settle-permission", "read"));
		fake.record(init);
		fake.record(acknowledgement("read"));
		await sent;
		const request = {
			type: "control_request",
			request_id: "one-shot",
			request: { subtype: "can_use_tool", tool_name: "Read", input: {} },
		};
		fake.record(request);
		await seen;
		fake.record(request);
		fake.record(result);
		resolveDecision({ behavior: "allow" });
		await new Promise((resolve) => setImmediate(resolve));
		expect(fake.inputLines().join("")).not.toContain('"request_id":"one-shot"');
		await instance.shutdown();
	});

	it("rejects a mismatched native session before permission routing", async () => {
		const fake = fakeProvider();
		let prompted = false;
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch({
			...launchRequest,
			async toolPermissionHandler() {
				prompted = true;
				return { behavior: "allow" };
			},
		});
		const sent = instance.send(input("mismatch-permission", "read"));
		fake.record(init);
		fake.record(acknowledgement("read"));
		await sent;
		fake.record({
			type: "control_request",
			session_id: "another-native-session",
			request_id: "mismatch",
			request: { subtype: "can_use_tool", tool_name: "Read", input: {} },
		});
		expect(prompted).toBe(false);
		await expect(instance.shutdown()).resolves.toBeUndefined();
	});

	it("waits for replay acknowledgement and accepts another input only after settlement", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		const first = instance.send(input("i1", "first"));
		expect(fake.args()).toContain("--replay-user-messages");
		expect(fake.inputLines().join("")).toContain('"content":"first"');
		fake.record(init);
		fake.record(acknowledgement("first"));
		await first;
		await expect(instance.send(input("i2", "second"))).rejects.toThrow(
			"CLAUDE_NOT_READY_OR_BUSY",
		);
		fake.record({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				model: "runtime metadata must be hidden",
				delta: { type: "text_delta", text: "answer" },
			},
		});
		fake.record(result);
		const second = instance.send(input("i2", "second"));
		fake.record(acknowledgement("second"));
		await second;
		fake.record(result);
		fake.finish();
		const received = [];
		for await (const event of instance.events) received.push(event);
		expect(
			received.map((event) =>
				event.kind === "status"
					? event.text
					: (event.inputEvent?.state ?? event.text),
			),
		).toEqual([
			"pending",
			"Claude session ready",
			"accepted",
			"agent_start",
			"answer",
			"completed",
			"agent_settled",
			"pending",
			"accepted",
			"agent_start",
			"completed",
			"agent_settled",
		]);
		expect(JSON.stringify(received)).not.toContain("usage");
		expect(JSON.stringify(received)).not.toContain("runtime metadata");
	});
});
