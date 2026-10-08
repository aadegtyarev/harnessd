import { describe, expect, it } from "vitest";
import type { InputId } from "../src/core/types.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { UncertainInputDeliveryError } from "../src/harness/input-delivery-error.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

const makeInput = (id: string) => ({
	id: id as InputId,
	sessionId: launchRequest.sessionId,
	text: "prompt",
	createdAt: new Date(),
});

describe("Claude input delivery", () => {
	it("returns typed uncertainty when stdin rejects the write", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		fake.stdin.destroy(new Error("private write error"));
		await expect(instance.send(makeInput("write-error"))).rejects.toMatchObject(
			{ constructor: UncertainInputDeliveryError, inputId: "write-error" },
		);
		fake.finish();
	});
	it("returns typed uncertainty after the acknowledgement deadline", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
			acknowledgementTimeoutMs: 10,
		}).launch(launchRequest);
		await expect(instance.send(makeInput("uncertain"))).rejects.toMatchObject({
			constructor: UncertainInputDeliveryError,
			inputId: "uncertain",
		});
		fake.finish();
	});
});
