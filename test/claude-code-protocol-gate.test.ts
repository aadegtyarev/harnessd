import { describe, expect, it } from "vitest";
import type { InputId } from "../src/core/types.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

const input = {
	id: "gate" as InputId,
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
const output = {
	type: "stream_event",
	event: {
		type: "content_block_delta",
		delta: { type: "text_delta", text: "premature" },
	},
};

async function failedBeforeAck(records: object[]) {
	const fake = fakeProvider();
	const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
		executable: "claude",
	}).launch(launchRequest);
	const sent = instance.send(input);
	fake.stdout.write(
		`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
	);
	await expect(sent).rejects.toThrow();
	fake.record(ack);
	fake.finish();
	const events = [];
	for await (const event of instance.events) events.push(event);
	return events;
}

describe("Claude acknowledgement gate", () => {
	it("fails closed on output before the matching replay acknowledgement", async () => {
		const events = await failedBeforeAck([init, output]);
		expect(events.some((event) => event.kind === "output")).toBe(false);
		expect(events.some((event) => event.text === "agent_start")).toBe(false);
		expect(events.some((event) => event.text === "agent_settled")).toBe(false);
		expect(events.some((event) => event.kind === "input")).toBe(false);
	});

	it("fails closed on result before acknowledgement and ignores late acknowledgement", async () => {
		const events = await failedBeforeAck([init, result]);
		expect(events.some((event) => event.text === "agent_start")).toBe(false);
		expect(events.some((event) => event.text === "agent_settled")).toBe(false);
		expect(events.some((event) => event.kind === "input")).toBe(false);
	});
});
