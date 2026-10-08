import { describe, expect, it } from "vitest";
import type { InputId } from "../src/core/types.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

const input = {
	id: "race" as InputId,
	sessionId: launchRequest.sessionId,
	text: "prompt",
	createdAt: new Date(),
};
const init = {
	type: "system",
	subtype: "init",
	session_id: launchRequest.sessionId,
};
const ack = {
	type: "user",
	isReplay: true,
	message: { role: "user", content: "prompt" },
};
const result = {
	type: "result",
	subtype: "success",
	session_id: launchRequest.sessionId,
	is_error: false,
	result: "done",
};

function sendBatch(
	fake: ReturnType<typeof fakeProvider>,
	...records: object[]
): void {
	fake.stdout.write(
		`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
	);
}

describe("Claude protocol ordering races", () => {
	it("settles send when init, acknowledgement, and result precede the write callback", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		fake.stdin.cork();
		const sent = instance.send(input);
		sendBatch(fake, init, ack, result);
		fake.stdin.uncork();
		await expect(sent).resolves.toBeUndefined();
		fake.finish();
		const received = [];
		for await (const event of instance.events) received.push(event);
		expect(
			received.filter((event) => event.text === "agent_settled"),
		).toHaveLength(1);
	});

	it("ignores duplicate matching acknowledgement without restarting the turn", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		const sent = instance.send(input);
		sendBatch(fake, init, ack);
		await sent;
		sendBatch(
			fake,
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "kept" },
				},
			},
			ack,
			result,
		);
		fake.finish();
		const received = [];
		for await (const event of instance.events) received.push(event);
		expect(
			received.filter((event) => event.text === "agent_start"),
		).toHaveLength(1);
		expect(received.find((event) => event.kind === "output")?.text).toBe(
			"kept",
		);
	});
});
