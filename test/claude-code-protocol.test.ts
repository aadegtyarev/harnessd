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
