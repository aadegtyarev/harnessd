import { describe, expect, it } from "vitest";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

describe("Claude process lifecycle", () => {
	it("closes events after stdout EOF", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		const iterator = instance.events[Symbol.asyncIterator]();
		fake.finish();
		expect(await iterator.next()).toMatchObject({ done: true });
	});
	it("propagates when neither signal is confirmed", async () => {
		const fake = fakeProvider({ ignoreTerm: true, rejectKill: true });
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		await expect(instance.shutdown()).rejects.toThrow("Claude shutdown failed");
		fake.finish();
	});
	it("escalates after rejected TERM and ignored termination", async () => {
		const fake = fakeProvider({ ignoreTerm: true, rejectTerm: true });
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		await instance.shutdown();
		expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
