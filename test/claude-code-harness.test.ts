import { describe, expect, it } from "vitest";
import type { InputId } from "../src/core/types.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

describe("Claude Code harness", () => {
	it("launches with stable native ID and exposes only verified capabilities", async () => {
		const fake = fakeProvider();
		const adapter = new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		});
		const instance = await adapter.launch(launchRequest);
		expect(adapter.descriptor.id).toBe("claude-code");
		expect(adapter.descriptor.aliases).toEqual(["claude"]);
		for (const unsupported of [
			"harness.cancel",
			"harness.reload",
			"harness.commands.list",
			"harness.commands.run",
			"harness.model.set",
			"harness.effort.set",
		])
			expect(adapter.descriptor.capabilities).not.toContain(unsupported);
		expect(fake.args()).toContain("--session-id");
		expect(fake.args()).toContain(launchRequest.sessionId);
		expect(fake.env()).toEqual({});
		expect(instance.nativeSessionId).toBe(launchRequest.sessionId);
		await instance.send({
			id: "input" as InputId,
			sessionId: launchRequest.sessionId,
			text: "safe",
			createdAt: new Date(),
		});
		expect(fake.stdin.read()?.toString()).toContain('"content":"safe"');
		fake.finish();
	});

	it("resumes only the exact saved native session ID", async () => {
		const fake = fakeProvider();
		const adapter = new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		});
		const nativeId = "native-session";
		const instance = await adapter.resume({
			...launchRequest,
			nativeSessionId: nativeId,
		});
		expect(fake.args()).toContain("--resume");
		expect(fake.args()).toContain(nativeId);
		expect(fake.args()).not.toContain("--session-id");
		expect(instance.nativeSessionId).toBe(nativeId);
		fake.finish();
	});

	it("closes the event iterator when stdout ends", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		const iterator = instance.events[Symbol.asyncIterator]();
		fake.finish();
		expect(await iterator.next()).toMatchObject({ done: true });
	});

	it("fails closed when init reports another native ID", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		}).launch(launchRequest);
		const nextEvent = instance.events[Symbol.asyncIterator]().next();
		fake.stdout.write(
			`${JSON.stringify({ type: "system", subtype: "init", session_id: "different" })}\n`,
		);
		expect((await nextEvent).value).toMatchObject({
			kind: "error",
			fatal: true,
			text: "Claude session identity mismatch",
		});
		expect(fake.signals).toContain("SIGTERM");
		fake.finish();
	});
});
