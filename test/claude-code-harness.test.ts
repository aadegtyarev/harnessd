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
		expect(
			adapter.descriptor.options?.find(
				(option) => option.key === "permissionMode",
			)?.values,
		).toEqual([
			"default",
			"acceptEdits",
			"plan",
			"bypassPermissions",
			"dontAsk",
			"auto",
		]);
		for (const unsupported of [
			"harness.cancel",
			"harness.reload",
			"harness.commands.list",
			"harness.commands.run",
			"harness.model.set",
			"harness.effort.set",
		])
			expect(adapter.descriptor.capabilities).not.toContain(unsupported);
		expect(fake.args()).toContain("--replay-user-messages");
		expect(fake.args()).toContain("--permission-mode");
		expect(fake.args()).toContain("default");
		expect(fake.args()).toContain("--permission-prompt-tool");
		expect(fake.args()).toContain("stdio");
		expect(fake.args()).toContain("--session-id");
		expect(fake.args()).toContain(launchRequest.sessionId);
		expect(fake.env()).toEqual({});
		expect(instance.nativeSessionId).toBe(launchRequest.sessionId);
		fake.finish();
	});

	it("maps persisted model, effort, and permission options to exact argv values", async () => {
		const fake = fakeProvider();
		const adapter = new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		});
		await adapter.launch({
			...launchRequest,
			adapterOptions: {
				model: "sonnet",
				effort: "high",
				permissionMode: "acceptEdits",
			},
		});
		const args = fake.args() ?? [];
		expect(
			args.slice(args.indexOf("--model"), args.indexOf("--model") + 2),
		).toEqual(["--model", "sonnet"]);
		expect(
			args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2),
		).toEqual(["--effort", "high"]);
		expect(
			args.slice(
				args.indexOf("--permission-mode"),
				args.indexOf("--permission-mode") + 2,
			),
		).toEqual(["--permission-mode", "acceptEdits"]);
		fake.finish();
	});

	it("maps every native permission mode to argv", async () => {
		for (const mode of [
			"default",
			"acceptEdits",
			"plan",
			"bypassPermissions",
			"dontAsk",
			"auto",
		]) {
			const fake = fakeProvider();
			await new ClaudeCodeHarnessAdapter(fake.provider, {
				executable: "claude",
			}).launch({
				...launchRequest,
				adapterOptions: { permissionMode: mode },
			});
			const args = fake.args() ?? [];
			expect(
				args.slice(
					args.indexOf("--permission-mode"),
					args.indexOf("--permission-mode") + 2,
				),
			).toEqual(["--permission-mode", mode]);
			fake.finish();
		}
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

	it("routes one correlated tool-permission request and returns an unchanged allow", async () => {
		let resolveDecision!: (decision: { behavior: "allow" }) => void;
		let resolveRequest!: (
			request: import("../src/core/ports.js").ToolPermissionRequest,
		) => void;
		const seen = new Promise<
			import("../src/core/ports.js").ToolPermissionRequest
		>((resolve) => {
			resolveRequest = resolve;
		});
		const decision = new Promise<{ behavior: "allow" }>((resolve) => {
			resolveDecision = resolve;
		});
		const fake = fakeProvider();
		const adapter = new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		});
		const instance = await adapter.launch({
			...launchRequest,
			toolPermissionHandler(request) {
				resolveRequest(request);
				return decision;
			},
		});
		const inputId = "input-1" as InputId;
		const submitted = instance.send({
			id: inputId,
			sessionId: launchRequest.sessionId,
			text: "run tool",
			createdAt: new Date(),
		});
		fake.record({
			type: "system",
			subtype: "init",
			session_id: launchRequest.sessionId,
		});
		fake.record({
			type: "user",
			isReplay: true,
			session_id: launchRequest.sessionId,
			message: { role: "user", content: "run tool" },
		});
		await submitted;
		fake.record({
			type: "control_request",
			request_id: "request-1",
			request: {
				subtype: "can_use_tool",
				tool_name: "Read",
				input: { file_path: "/tmp/a" },
				tool_use_id: "tool-1",
				agent_id: "agent-1",
				blocked_path: "/tmp/a",
				decision_reason: "permission required",
				title: "Read file",
				display_name: "Read",
				description: "Read one file",
			},
		});
		const received = await seen;
		expect(received).toMatchObject({
			requestId: "request-1",
			inputId,
			toolName: "Read",
			context: {
				toolUseId: "tool-1",
				agentId: "agent-1",
				blockedPath: "/tmp/a",
				decisionReason: "permission required",
				title: "Read file",
				displayName: "Read",
				description: "Read one file",
			},
		});
		resolveDecision({ behavior: "allow" });
		await new Promise((resolve) => setImmediate(resolve));
		const response = fake
			.inputLines()
			.map((line) => JSON.parse(line))
			.find((line) => line.type === "control_response");
		expect(response).toEqual({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: "request-1",
				response: { behavior: "allow" },
			},
		});
		fake.record({
			type: "result",
			session_id: launchRequest.sessionId,
			subtype: "success",
			is_error: false,
			result: "done",
		});
		await instance.shutdown();
	});
});
