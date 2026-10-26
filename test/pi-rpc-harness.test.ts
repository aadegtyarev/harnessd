import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReloadError } from "../src/core/errors.js";
import type { ProcessProvider } from "../src/core/ports.js";
import type { AdapterId, HarnessEvent, InputId } from "../src/core/types.js";
import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "../src/harness/agent-file-send-protocol.js";
import {
	PiControlError,
	PiRpcHarnessAdapter,
	UncertainInputDeliveryError,
} from "../src/harness/index.js";
import { NodeProcessProvider } from "../src/process/node-process-provider.js";
import { collectEvents, fakeProvider, input, request } from "./pi-rpc-fake.js";

describe("PiRpcHarnessAdapter", () => {
	it("declares the core capabilities and launches configured replacement process values", async () => {
		const fake = fakeProvider();
		const options = {
			executable: "/bin/pi",
			args: ["--model", "model name"],
			env: { ONLY: "replacement" },
			startupTimeoutMs: 100,
		};
		const instance = await new PiRpcHarnessAdapter(
			fake.provider,
			options,
		).launch(request);
		expect(
			new PiRpcHarnessAdapter(fake.provider, options).descriptor.capabilities,
		).toEqual([
			"harness.launch",
			"harness.stop",
			"harness.resume",
			"harness.cancel",
			"harness.session.status",
			"harness.model.list",
			"harness.model.set",
			"harness.effort.list",
			"harness.effort.set",
			"harness.reload",
			"harness.commands.list",
			"harness.commands.run",
			"input.submit",
		]);
		expect(fake.launchRequest).toMatchObject({
			executable: options.executable,
			args: [
				"--model",
				"model name",
				"--mode",
				"rpc",
				"--extension",
				expect.stringMatching(/pi-reload-extension\.(?:ts|js)$/),
			],
			cwd: request.cwd,
			env: {
				...options.env,
				HARNESSD_PI_RELOAD_COMMAND: expect.stringMatching(
					/^harnessd-reload-[a-f0-9-]{36}$/,
				),
			},
			stdio: "pipe",
		});
		expect(instance.nativeSessionId).toBe("native-exact");
		await instance.shutdown();
	});

	it("loads an explicit send_file extension with a session-scoped local bridge", async () => {
		const fake = fakeProvider();
		const sendAgentFile = vi.fn(async () => ({
			fileName: "report.txt",
			delivered: 1,
			recipients: 1,
		}));
		const adapter = new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			agentFileSend: sendAgentFile,
			startupTimeoutMs: 100,
		});
		expect(adapter.descriptor.capabilities).toContain("harness.file.send");
		const instance = await adapter.launch(request);
		const launchRequest = fake.launchRequest;
		expect(launchRequest?.args).toContain("--extension");
		const extensionPaths =
			launchRequest?.args.flatMap((arg, index, args) =>
				arg === "--extension" ? [args[index + 1]] : [],
			) ?? [];
		expect(extensionPaths).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/pi-reload-extension\.(?:ts|js)$/),
				expect.stringMatching(/agent-file-send-extension\.(?:ts|js)$/),
			]),
		);
		const env = launchRequest?.env ?? {};
		const url = env[AGENT_FILE_SEND_URL_ENV];
		const token = env[AGENT_FILE_SEND_TOKEN_ENV];
		expect(Object.keys(env).sort()).toEqual(
			[
				AGENT_FILE_SEND_TOKEN_ENV,
				AGENT_FILE_SEND_URL_ENV,
				"HARNESSD_PI_RELOAD_COMMAND",
			].sort(),
		);
		const response = await fetch(url as string, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ path: "report.txt", caption: "Sent" }),
		});
		expect(await response.json()).toEqual({
			ok: true,
			result: { fileName: "report.txt", delivered: 1, recipients: 1 },
		});
		expect(sendAgentFile).toHaveBeenCalledWith({
			sessionId: request.sessionId,
			path: "report.txt",
			caption: "Sent",
		});
		await instance.shutdown();
	});

	it("uses documented Pi RPC commands for live state, models, effort, and aggregate usage", async () => {
		const fake = fakeProvider({
			rpcResponses: {
				get_state: {
					data: {
						sessionId: "native-exact",
						model: { provider: "openai", id: "gpt-current", name: "Current" },
						thinkingLevel: "medium",
					},
				},
				get_session_stats: {
					data: {
						tokens: { total: 42, input: 20, output: 22, cacheRead: 4 },
						cost: 0.123456,
						contextUsage: {
							tokens: 60_000,
							contextWindow: 272_000,
							percent: 22.1,
						},
						sessionFile: "/must/not/be/exposed/session.jsonl",
					},
				},
				get_available_models: {
					data: {
						models: [
							{ provider: "openai", id: "gpt-current", name: "Current" },
							{ provider: "openai", id: "gpt-next", name: "Next" },
						],
					},
				},
				get_available_thinking_levels: {
					data: { levels: ["low", "medium", "high"] },
				},
				set_model: {
					data: { provider: "openai", id: "gpt-next", name: "Next" },
				},
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "/bin/pi",
			startupTimeoutMs: 100,
		}).launch(request);
		const status = await instance.control?.getStatus();
		expect(status).toEqual({
			model: { provider: "openai", id: "gpt-current", name: "Current" },
			effort: "medium",
			usage: {
				totalTokens: 42,
				inputTokens: 20,
				outputTokens: 22,
				cacheReadTokens: 4,
				costUsd: 0.123456,
				contextTokens: 60_000,
				contextWindow: 272_000,
				contextPercent: 22.1,
			},
		});
		expect(JSON.stringify(status)).not.toContain("session.jsonl");
		expect(await instance.control?.listModels()).toHaveLength(2);
		expect(await instance.control?.listEfforts()).toEqual([
			"low",
			"medium",
			"high",
		]);
		expect(await instance.control?.setModel("openai", "gpt-next")).toEqual({
			provider: "openai",
			id: "gpt-next",
			name: "Next",
		});
		await instance.control?.setEffort("high");
		await expect(instance.control?.setEffort("xhigh")).rejects.toMatchObject({
			code: "EFFORT_NOT_SUPPORTED",
		});
		expect(
			fake.commands.some(
				(command) =>
					command.type === "set_thinking_level" && command.level === "xhigh",
			),
		).toBe(false);
		expect(fake.commands).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "get_session_stats" }),
				expect.objectContaining({ type: "get_available_models" }),
				expect.objectContaining({ type: "get_available_thinking_levels" }),
				expect.objectContaining({
					type: "set_model",
					provider: "openai",
					modelId: "gpt-next",
				}),
				expect.objectContaining({ type: "set_thinking_level", level: "high" }),
			]),
		);
		await instance.shutdown();
	});

	it("preserves unknown context usage after compaction instead of deriving it from session totals", async () => {
		const fake = fakeProvider({
			rpcResponses: {
				get_session_stats: {
					data: {
						tokens: { total: 105_000 },
						contextUsage: {
							tokens: null,
							contextWindow: 272_000,
							percent: null,
						},
					},
				},
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "/bin/pi",
			startupTimeoutMs: 100,
		}).launch(request);
		const status = await instance.control?.getStatus();
		expect(status?.usage).toEqual({
			totalTokens: 105_000,
			contextTokens: null,
			contextWindow: 272_000,
			contextPercent: null,
		});
		await instance.shutdown();
	});

	it("turns failed RPC control replies into safe errors without echoing Pi details", async () => {
		const fake = fakeProvider({
			rpcResponses: {
				get_available_models: {
					data: {
						models: [{ provider: "openai", id: "gpt-next", name: "Next" }],
					},
				},
				set_model: { success: false, error: "private endpoint detail" },
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "/bin/pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await expect(
			instance.control?.setModel("openai", "gpt-next"),
		).rejects.toMatchObject({ code: "PI_CONTROL_FAILED" });
		await expect(
			instance.control?.setModel("openai", "unknown"),
		).rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE" });
		try {
			await instance.control?.setModel("openai", "gpt-next");
		} catch (error) {
			expect(error).toBeInstanceOf(PiControlError);
			expect(String(error)).not.toContain("private endpoint detail");
		}
		await instance.shutdown();
	});

	it("runs env-node Pi scripts with harnessd's Node and keeps the replacement env contract", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-node-script-"));
		const executable = path.join(cwd, "pi");
		await writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0);\n");
		await chmod(executable, 0o700);
		const fake = fakeProvider();
		try {
			const instance = await new PiRpcHarnessAdapter(fake.provider, {
				executable,
				startupTimeoutMs: 100,
			}).launch(request);
			expect(fake.launchRequest).toMatchObject({
				executable: process.execPath,
				args: [
					executable,
					"--mode",
					"rpc",
					"--extension",
					expect.stringMatching(/pi-reload-extension\.(?:ts|js)$/),
				],
				cwd: request.cwd,
				env: {
					HARNESSD_PI_RELOAD_COMMAND: expect.stringMatching(
						/^harnessd-reload-[a-f0-9-]{36}$/,
					),
				},
				stdio: "pipe",
			});
			await instance.shutdown();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("resolves relative PATH entries against the child cwd and skips directories", async () => {
		const supervisorCwd = await mkdtemp(
			path.join(os.tmpdir(), "pi-supervisor-search-"),
		);
		const childCwd = await mkdtemp(path.join(os.tmpdir(), "pi-child-search-"));
		const supervisorDirectory = path.join(supervisorCwd, "bad", "pi");
		const childDirectory = path.join(childCwd, "bad", "pi");
		const executable = path.join(childCwd, "bin", "pi");
		await mkdir(supervisorDirectory, { recursive: true });
		await chmod(supervisorDirectory, 0o700);
		await mkdir(childDirectory, { recursive: true });
		await chmod(childDirectory, 0o700);
		await mkdir(path.dirname(executable), { recursive: true });
		await writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0);\n");
		await chmod(executable, 0o700);
		const fake = fakeProvider();
		const originalCwd = process.cwd();
		try {
			process.chdir(supervisorCwd);
			const envPath = ["bad", "bin"].join(path.delimiter);
			const instance = await new PiRpcHarnessAdapter(fake.provider, {
				executable: "pi",
				env: { PATH: envPath },
				startupTimeoutMs: 100,
			}).launch({ ...request, cwd: childCwd });
			expect(fake.launchRequest).toMatchObject({
				executable: process.execPath,
				args: [
					executable,
					"--mode",
					"rpc",
					"--extension",
					expect.stringMatching(/pi-reload-extension\.(?:ts|js)$/),
				],
				env: { PATH: envPath },
			});
			await instance.shutdown();
		} finally {
			process.chdir(originalCwd);
			await Promise.all([
				rm(supervisorCwd, { recursive: true, force: true }),
				rm(childCwd, { recursive: true, force: true }),
			]);
		}
	});

	it("runs an env-node RPC script under the harness Node with an empty child environment", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-rpc-shebang-"));
		const executable = path.join(cwd, "pi");
		const script = [
			"#!/usr/bin/env node",
			'import { createInterface } from "node:readline";',
			"const lines = createInterface({ input: process.stdin });",
			'lines.on("line", (line) => {',
			"  const command = JSON.parse(line);",
			'  if (command.type === "get_state") {',
			'    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: JSON.stringify({ version: process.version, env: Object.keys(process.env).sort() }) } }) + "\\n");',
			'  } else if (command.type === "get_commands") {',
			'    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_commands", success: true, data: { commands: [{ name: process.env.HARNESSD_PI_RELOAD_COMMAND, source: "extension", description: "harnessd internal reload command" }] } }) + "\\n");',
			"  }",
			"});",
		].join("\n");
		await writeFile(executable, `${script}\n`);
		await chmod(executable, 0o700);
		try {
			const instance = await new PiRpcHarnessAdapter(
				new NodeProcessProvider(),
				{ executable, startupTimeoutMs: 1000, shutdownTimeoutMs: 1000 },
			).launch({ ...request, cwd });
			expect(JSON.parse(instance.nativeSessionId ?? "null")).toEqual({
				version: process.version,
				env: ["HARNESSD_PI_RELOAD_COMMAND"],
			});
			await instance.shutdown();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps non-Node executables unchanged", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-native-script-"));
		const executable = path.join(cwd, "pi");
		await writeFile(executable, "not a node shebang\n");
		await chmod(executable, 0o700);
		const fake = fakeProvider();
		try {
			const instance = await new PiRpcHarnessAdapter(fake.provider, {
				executable,
				startupTimeoutMs: 100,
			}).launch(request);
			expect(fake.launchRequest?.executable).toBe(executable);
			expect(fake.launchRequest?.args).toEqual([
				"--mode",
				"rpc",
				"--extension",
				expect.stringMatching(/pi-reload-extension\.(?:ts|js)$/),
			]);
			await instance.shutdown();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("maps process launch errno to a safe Pi startup error", async () => {
		const provider: ProcessProvider = {
			descriptor: {
				id: "failed-process" as AdapterId,
				capabilities: ["process.launch", "process.signal"],
			},
			async launch() {
				throw Object.assign(new Error("private executable path"), {
					code: "ENOENT",
				});
			},
		};
		await expect(
			new PiRpcHarnessAdapter(provider, { executable: "/private/pi" }).launch(
				request,
			),
		).rejects.toMatchObject({
			name: "PiStartupError",
			code: "PI_EXECUTABLE_NOT_FOUND",
			message: "Pi RPC startup failed",
		});
	});

	it("does not report an expected process exit during shutdown as an error", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.shutdown();
		const seen: HarnessEvent[] = [];
		for await (const event of instance.events) seen.push(event);
		expect(seen.some((event) => event.kind === "error")).toBe(false);
	});

	it("sends image input as Pi RPC image content", async () => {
		const fake = fakeProvider({ promptDisposition: "handled" });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send({
			...input("inspect photo", "image-input"),
			images: [{ mimeType: "image/jpeg", data: "aW1hZ2U=" }],
		});
		const prompt = fake.commands.find((command) => command.type === "prompt");
		expect(prompt?.message).toBe("inspect photo");
		expect(prompt?.images).toEqual([
			{ type: "image", mimeType: "image/jpeg", data: "aW1hZ2U=" },
		]);
		await instance.shutdown();
	});

	it("treats a handled prompt as immediately complete", async () => {
		const fake = fakeProvider({ promptDisposition: "handled" });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("/extension-command", "handled"));
		await expect(
			instance.send(input("next explicit input", "next")),
		).resolves.toBeUndefined();
		const events = await collectEvents(instance, 6);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual([
			"pending",
			"accepted",
			"completed",
			"pending",
			"accepted",
			"completed",
		]);
		await instance.shutdown();
	});

	it("discovers only safe extension commands and prompts with the exact raw remainder", async () => {
		const fake = fakeProvider({
			promptDisposition: "handled",
			costReportMessage: {
				role: "custom",
				customType: "pi-ad-session-usage:report",
				content: "Cost result",
			},
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
					sourceInfo: { path: "/secret" },
				},
				{
					name: "cost",
					source: "extension",
					description: "  cost\n  details\u0001",
					sourceInfo: { path: "/secret" },
				},
				{ name: "template", source: "prompt", description: "not eligible" },
				{ name: "bad name", source: "extension", description: "invalid" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		expect(await instance.control?.getCommands?.()).toEqual([
			{ name: "cost", description: "cost details" },
		]);
		fake.stdout.write('{"type":"agent_start"}\n');
		expect(await instance.control?.runCommand?.("cost", "   raw  ")).toEqual({
			disposition: "handled",
			output: "Cost result",
		});
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toEqual([expect.objectContaining({ message: "/cost   raw  " })]);
		expect(fake.commands.some((command) => command.streamingBehavior)).toBe(
			false,
		);
		await instance.shutdown();
	});

	it("bounds a correlated dynamic command result before returning it", async () => {
		const fake = fakeProvider({
			promptDisposition: "handled",
			costReportMessage: {
				role: "custom",
				customType: "pi-ad-session-usage:report",
				content: "x".repeat(3000),
			},
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "cost", source: "extension", description: "cost" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		const result = await instance.control?.runCommand?.("cost", "");
		expect(result?.output?.length).toBeLessThanOrEqual(2000);
		expect(result?.output).toMatch(/^x+/);
		await instance.shutdown();
	});

	it.each([
		{ label: "missing" },
		{
			label: "malformed",
			costReportMessage: {
				role: "custom",
				customType: "pi-ad-session-usage:report",
				content: [],
			},
		},
	])("fails safely for a $label cost result", async ({ costReportMessage }) => {
		const fake = fakeProvider({
			promptDisposition: "handled",
			...(costReportMessage !== undefined ? { costReportMessage } : {}),
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "cost", source: "extension", description: "cost" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 20,
		}).launch(request);
		await expect(
			instance.control?.runCommand?.("cost", ""),
		).rejects.toMatchObject({
			code: "COMMAND_UNCERTAIN",
			message: "Pi session control request failed",
		});
		await expect(
			instance.control?.runCommand?.("cost", ""),
		).rejects.toMatchObject({
			code: "COMMAND_UNCERTAIN",
		});
		expect(fake.commands.filter((item) => item.type === "prompt")).toHaveLength(
			1,
		);
		await instance.shutdown();
	});

	it("keeps the session alive when fresh command discovery fails", async () => {
		let discoveries = 0;
		const fake = fakeProvider({
			promptDisposition: "handled",
			commandListing: (reload) => {
				discoveries += 1;
				return discoveries === 1
					? [
							{
								name: reload,
								source: "extension",
								description: "harnessd internal reload command",
							},
						]
					: "malformed";
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await expect(instance.control?.getCommands?.()).rejects.toMatchObject({
			code: "COMMAND_DISCOVERY_FAILED",
		});
		await expect(instance.control?.reload?.()).resolves.toBeUndefined();
		expect(instance.exit).toBeInstanceOf(Promise);
		await instance.shutdown();
	});

	it("returns typed uncertainty when extension prompt acknowledgement is lost", async () => {
		const fake = fakeProvider({
			exitOnPrompt: true,
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "cost", source: "extension", description: "cost" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await expect(
			instance.control?.runCommand?.("cost", ""),
		).rejects.toMatchObject({
			code: "COMMAND_UNCERTAIN",
		});
		await instance.shutdown();
	});

	it("types an extension prompt timeout as uncertain without retrying", async () => {
		const fake = fakeProvider({
			holdPrompt: true,
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "cost", source: "extension", description: "cost" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 20,
		}).launch(request);
		await expect(
			instance.control?.runCommand?.("cost", ""),
		).rejects.toMatchObject({
			code: "COMMAND_UNCERTAIN",
		});
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it("treats an unrecognized successful command disposition as uncertain", async () => {
		const fake = fakeProvider({
			promptDisposition: "future-value",
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "cost", source: "extension", description: "cost" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await expect(
			instance.control?.runCommand?.("cost", ""),
		).rejects.toMatchObject({
			code: "COMMAND_UNCERTAIN",
		});
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it("revalidates command currency at the actual prompt-write boundary", async () => {
		const fake = fakeProvider({
			promptDisposition: "accepted",
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "other", source: "extension", description: "Other" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		let current = true;
		await expect(
			instance.control?.runCommand?.("other", "", () => current),
		).resolves.toMatchObject({ disposition: "accepted" });
		current = false;
		await expect(
			instance.control?.runCommand?.("other", "", () => current),
		).rejects.toMatchObject({ code: "COMMAND_SELECTION_CHANGED" });
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it("cancels an unwritten command when its response deadline expires", async () => {
		const fake = fakeProvider({
			promptDisposition: "accepted",
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "cost", source: "extension", description: "cost" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 20,
		}).launch(request);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		(instance as unknown as { writeChain: Promise<void> }).writeChain = held;
		const command = (
			instance as unknown as { command: (name: string) => Promise<unknown> }
		).command("prompt");
		await expect(command).rejects.toThrow("timed out");
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fake.commands.filter((item) => item.type === "prompt")).toHaveLength(
			0,
		);
		await instance.shutdown();
	});

	it("rejects dynamic commands while reload owns the session", async () => {
		const fake = fakeProvider({
			holdPrompt: true,
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "cost", source: "extension", description: "cost" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 1000,
		}).launch(request);
		const reload = instance.control?.reload?.();
		await vi.waitFor(() =>
			expect(fake.commands.some((command) => command.type === "prompt")).toBe(
				true,
			),
		);
		await expect(
			instance.control?.runCommand?.("cost", ""),
		).rejects.toMatchObject({
			code: "RELOAD_BUSY",
		});
		await instance.shutdown();
		await expect(reload).rejects.toBeDefined();
	});

	it("ignores a late cost report after timeout and quarantines further requests", async () => {
		const fake = fakeProvider({
			holdPrompt: true,
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "cost", source: "extension", description: "cost" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 20,
		}).launch(request);
		const command = instance.control?.runCommand?.("cost", "");
		const commandTimedOut = expect(command).rejects.toMatchObject({
			code: "COMMAND_UNCERTAIN",
		});
		await vi.waitFor(() =>
			expect(
				fake.commands.filter((item) => item.type === "prompt"),
			).toHaveLength(1),
		);
		await commandTimedOut;
		fake.stdout.write(
			`${JSON.stringify({
				type: "message_start",
				message: {
					role: "custom",
					customType: "pi-ad-session-usage:report",
					content: "late report",
				},
			})}\n`,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fake.commands.filter((item) => item.type === "prompt")).toHaveLength(
			1,
		);
		await expect(
			instance.control?.runCommand?.("cost", ""),
		).rejects.toMatchObject({
			code: "COMMAND_UNCERTAIN",
		});
		expect(fake.commands.filter((item) => item.type === "prompt")).toHaveLength(
			1,
		);
		await instance.shutdown();
	});

	it("rechecks selection after queued write preparation completes", async () => {
		const fake = fakeProvider({
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "cost", source: "extension", description: "cost" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		let current = true;
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		(instance as unknown as { writeChain: Promise<void> }).writeChain = held;
		const command = instance.control?.runCommand?.("cost", "", () => current);
		await vi.waitFor(() =>
			expect(
				(instance as unknown as { pending: Map<string, unknown> }).pending.size,
			).toBeGreaterThan(0),
		);
		const preparation = (instance as unknown as { writeChain: Promise<void> })
			.writeChain;
		current = false;
		release();
		await preparation;
		await expect(command).rejects.toMatchObject({
			code: "COMMAND_SELECTION_CHANGED",
		});
		expect(fake.commands.filter((item) => item.type === "prompt")).toHaveLength(
			0,
		);
		await instance.shutdown();
	});

	it("holds dynamic commands behind an in-flight abort gate", async () => {
		const fake = fakeProvider({
			holdAbort: true,
			promptDisposition: "accepted",
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "other", source: "extension", description: "Other" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		const inputId = "cancel-target" as InputId;
		await instance.send(input("active", inputId));
		const cancel = instance.cancel(inputId);
		await vi.waitFor(() =>
			expect(fake.commands.some((command) => command.type === "abort")).toBe(
				true,
			),
		);
		const command = instance.control?.runCommand?.("other", "");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(fake.commands.filter((item) => item.type === "prompt")).toHaveLength(
			1,
		);
		const abort = fake.commands.find((item) => item.type === "abort");
		fake.stdout.write(
			`${JSON.stringify({ type: "response", id: abort?.id, command: "abort", success: true })}\n`,
		);
		await cancel;
		await expect(command).resolves.toMatchObject({ disposition: "accepted" });
		expect(fake.commands.filter((item) => item.type === "prompt")).toHaveLength(
			2,
		);
		await instance.shutdown();
	});

	it("holds commands through uncertain abort until the run settles", async () => {
		const fake = fakeProvider({
			holdAbort: true,
			promptDisposition: "accepted",
			commandListing: (reload) => [
				{
					name: reload,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{ name: "other", source: "extension", description: "Other" },
			],
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 100,
		}).launch(request);
		const inputId = "uncertain-cancel" as InputId;
		await instance.send(input("active", inputId));
		const cancel = instance.cancel(inputId);
		await vi.waitFor(() =>
			expect(fake.commands.some((command) => command.type === "abort")).toBe(
				true,
			),
		);
		const command = instance.control?.runCommand?.("other", "");
		await expect(cancel).rejects.toBeDefined();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(fake.commands.filter((item) => item.type === "prompt")).toHaveLength(
			1,
		);
		fake.stdout.write('{"type":"agent_settled"}\n');
		await expect(command).resolves.toMatchObject({ disposition: "accepted" });
		expect(fake.commands.filter((item) => item.type === "prompt")).toHaveLength(
			2,
		);
		await instance.shutdown();
	});

	it("refreshes command inventory after each successful reload", async () => {
		const fake = fakeProvider({ promptDisposition: "handled" });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.control?.reload?.();
		expect(
			fake.commands.filter((command) => command.type === "get_commands"),
		).toHaveLength(2);
		await instance.shutdown();
	});

	it("reloads through one internal handled prompt and correlates its exact command error", async () => {
		const fake = fakeProvider({ promptDisposition: "handled" });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.control?.reload?.();
		expect(
			fake.commands.filter((command) => command.type === "get_commands"),
		).toHaveLength(2);
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toEqual([
			expect.objectContaining({
				type: "prompt",
				message: `/${String(fake.launchRequest?.env?.HARNESSD_PI_RELOAD_COMMAND)}`,
			}),
		]);
		await instance.shutdown();

		const correlated = fakeProvider({
			promptDisposition: "handled",
			reloadExtensionError: {
				extensionPath: "$reload",
				event: "command",
			},
		});
		const failedInstance = await new PiRpcHarnessAdapter(correlated.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		const events = failedInstance.events[Symbol.asyncIterator]();
		await expect(failedInstance.control?.reload?.()).rejects.toBeInstanceOf(
			PiControlError,
		);
		const event = await Promise.race([
			events.next(),
			new Promise<undefined>((resolve) => setTimeout(resolve, 10)),
		]);
		expect(event).toBeUndefined();
		await failedInstance.shutdown();
	});

	it("uses one model-capable prompt per reload and reuses startup verification", async () => {
		const fake = fakeProvider({ promptDisposition: "handled" });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.control?.reload?.(() => true);
		await instance.control?.reload?.(() => true);
		expect(
			fake.commands.filter((command) => command.type === "get_commands"),
		).toHaveLength(3);
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(2);
		await instance.shutdown();
	});

	it.each(["agent_start", "compaction_start"])(
		"rejects reload during %s without prompt side effects",
		async (event) => {
			const fake = fakeProvider();
			const instance = await new PiRpcHarnessAdapter(fake.provider, {
				executable: "pi",
				startupTimeoutMs: 100,
			}).launch(request);
			fake.stdout.write(`${JSON.stringify({ type: event })}\n`);
			await new Promise((resolve) => setImmediate(resolve));
			await expect(
				instance.control?.reload?.(() => true),
			).rejects.toMatchObject({
				code: "RELOAD_BUSY",
			});
			expect(
				fake.commands.filter((command) => command.type === "prompt"),
			).toHaveLength(0);
			await instance.shutdown();
		},
	);

	it("rechecks adapter busy state at the held write boundary", async () => {
		const fake = fakeProvider({ promptDisposition: "handled" });
		const adapter = new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		});
		const instance = await adapter.launch(request);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		(instance as unknown as { writeChain: Promise<void> }).writeChain = held;
		const events = instance.events[Symbol.asyncIterator]();
		const reload = instance.control?.reload?.(() => true);
		fake.stdout.write('{"type":"agent_start"}\n');
		await events.next();
		release();
		await expect(reload).rejects.toMatchObject({ code: "RELOAD_BUSY" });
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(0);
		fake.stdout.write('{"type":"agent_settled"}\n');
		await events.next();
		await instance.control?.reload?.(() => true);
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it("releases timed-out reload ownership after a definite held-write rejection", async () => {
		const fake = fakeProvider({ promptDisposition: "handled" });
		const adapter = new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 15,
		});
		const instance = await adapter.launch(request);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		(instance as unknown as { writeChain: Promise<void> }).writeChain = held;
		let first = true;
		const reload = instance.control?.reload?.(() => {
			if (first) {
				first = false;
				throw new ReloadError("RELOAD_SELECTION_CHANGED");
			}
		});
		const timedOut = reload?.catch((error: unknown) => error);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(await timedOut).toBeInstanceOf(PiControlError);
		release();
		await new Promise((resolve) => setImmediate(resolve));
		await instance.control?.reload?.(() => true);
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it.each([
		["missing command", () => []],
		[
			"collision-renamed command",
			(name: string) => [
				{
					name: `${name}:1`,
					source: "extension",
					description: "harnessd internal reload command",
				},
			],
		],
		[
			"duplicate command collision",
			(name: string) => [
				{
					name,
					source: "extension",
					description: "harnessd internal reload command",
				},
				{
					name,
					source: "extension",
					description: "harnessd internal reload command",
				},
			],
		],
		[
			"wrong source",
			(name: string) => [
				{
					name,
					source: "built-in",
					description: "harnessd internal reload command",
				},
			],
		],
		[
			"wrong description",
			(name: string) => [
				{
					name,
					source: "extension",
					description: "unrelated command",
				},
			],
		],
	])(
		"refuses %s before exposing the instance",
		async (_case, commandListing) => {
			const fake = fakeProvider({ commandListing });
			await expect(
				new PiRpcHarnessAdapter(fake.provider, {
					executable: "/bin/pi",
					startupTimeoutMs: 100,
				}).launch(request),
			).rejects.toMatchObject({ code: "PI_STARTUP_FAILED" });
			expect(
				fake.commands.filter((command) => command.type === "prompt"),
			).toEqual([]);
		},
	);

	it("reports reload process exit as uncertain failure without retry", async () => {
		const fake = fakeProvider({ exitOnPrompt: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 30,
		}).launch(request);
		await expect(instance.control?.reload?.()).rejects.toBeInstanceOf(
			PiControlError,
		);
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it("retains timed-out reload ownership until the correlated acknowledgement", async () => {
		const fake = fakeProvider({ holdPrompt: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "/bin/pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 15,
		}).launch(request);
		const events = instance.events[Symbol.asyncIterator]();
		await expect(instance.control?.reload?.()).rejects.toBeInstanceOf(
			PiControlError,
		);
		await expect(instance.control?.reload?.()).rejects.toMatchObject({
			code: "RELOAD_BUSY",
		});
		const prompt = fake.commands.find((command) => command.type === "prompt");
		expect(prompt).toBeDefined();
		fake.stdout.write(
			`${JSON.stringify({
				type: "extension_error",
				extensionPath: "/private/extensions/example.js",
				event: "session_start",
				error: "late private detail",
			})}\n${JSON.stringify({
				type: "response",
				id: prompt?.id,
				command: "prompt",
				success: true,
				data: { disposition: "handled" },
			})}\n`,
		);
		await new Promise((resolve) => setImmediate(resolve));
		const event = await Promise.race([
			events.next(),
			new Promise<undefined>((resolve) => setTimeout(resolve, 10)),
		]);
		expect(event).toBeUndefined();
		await instance.shutdown();
	});

	it.each(["session_shutdown", "session_start"])(
		"suppresses and fails reload lifecycle error %s",
		async (event) => {
			const fake = fakeProvider({
				promptDisposition: "handled",
				reloadExtensionError: {
					extensionPath: "/private/extensions/example.js",
					event,
				},
			});
			const instance = await new PiRpcHarnessAdapter(fake.provider, {
				executable: "pi",
				startupTimeoutMs: 100,
			}).launch(request);
			const events = instance.events[Symbol.asyncIterator]();
			await expect(instance.control?.reload?.()).rejects.toMatchObject({
				code: "PI_CONTROL_FAILED",
			});
			expect(
				await Promise.race([
					events.next(),
					new Promise<undefined>((resolve) => setTimeout(resolve, 10)),
				]),
			).toBeUndefined();
			await instance.shutdown();
		},
	);

	it.each(["--no-session", "--continue", "-c", "--resume", "-r", "--fork"])(
		"rejects conflicting option %s",
		async (flag) => {
			const fake = fakeProvider();
			await expect(
				new PiRpcHarnessAdapter(fake.provider, {
					executable: "pi",
					args: [flag],
				}).launch(request),
			).rejects.toThrow("controlled by the adapter");
		},
	);

	it("resumes a matching native session with the exact --session argument", async () => {
		const fake = fakeProvider({ sessionId: "saved-id" });
		const adapter = new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		});
		const instance = await adapter.resume({
			...request,
			nativeSessionId: "saved-id",
		});
		expect(instance.nativeSessionId).toBe("saved-id");
		expect(fake.launchRequest?.args).toEqual([
			"--mode",
			"rpc",
			"--session",
			"saved-id",
			"--extension",
			expect.stringMatching(/pi-reload-extension\.(?:ts|js)$/),
		]);
		await instance.shutdown();
	});

	it("uses --session and rejects a resume whose returned session differs", async () => {
		const fake = fakeProvider({ sessionId: "other-session" });
		const adapter = new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			shutdownTimeoutMs: 5,
		});
		await expect(
			adapter.resume({ ...request, nativeSessionId: "saved/native" }),
		).rejects.toThrow("different native session");
		expect(fake.launchRequest?.args).toContain("--session");
		expect(fake.launchRequest?.args).toContain("saved/native");
		expect(fake.launchRequest?.args).not.toContain("--session-id");
	});

	it("rejects launch when the readiness response times out", async () => {
		const fake = fakeProvider({ holdGetState: true });
		await expect(
			new PiRpcHarnessAdapter(fake.provider, {
				executable: "pi",
				startupTimeoutMs: 5,
				commandTimeoutMs: 100,
				shutdownTimeoutMs: 5,
			}).launch(request),
		).rejects.toMatchObject({ code: "PI_RPC_STARTUP_TIMEOUT" });
		expect(fake.child.stdin?.writableEnded).toBe(true);
	});

	it("classifies a Pi process exit before readiness", async () => {
		const fake = fakeProvider({ exitOnGetState: true });
		await expect(
			new PiRpcHarnessAdapter(fake.provider, {
				executable: "pi",
				startupTimeoutMs: 100,
				shutdownTimeoutMs: 5,
			}).launch(request),
		).rejects.toMatchObject({ code: "PI_EXITED_BEFORE_READY" });
	});

	it("attaches a journal-only stderr tail to a startup failure", async () => {
		const fake = fakeProvider({ exitOnGetState: true });
		fake.stderr.write("Error: model provider unavailable\n");
		const failure = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			shutdownTimeoutMs: 5,
		})
			.launch(request)
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: "PI_EXITED_BEFORE_READY" });
		const tail = (failure as { diagnosticTail?: unknown }).diagnosticTail;
		expect(tail).toBe("Error: model provider unavailable");
		// Non-enumerable, so the tail is not serialized with the error.
		expect(Object.keys(failure as object)).not.toContain("diagnosticTail");
		expect(JSON.stringify(failure)).not.toContain("model provider");
		expect(String((failure as Error).message)).not.toContain("model provider");
	});

	it("redacts the stderr tail before bounding it, including the file-send token", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			agentFileSend: async () => ({
				fileName: "x",
				delivered: 1,
				recipients: 1,
			}),
			startupTimeoutMs: 100,
		}).launch(request);
		const bridgeToken = String(
			fake.launchRequest?.env?.[AGENT_FILE_SEND_TOKEN_ENV],
		);
		// The assignment prefix lies outside the last 2 KB; the value reaches into it.
		fake.stderr.write(
			`password=${"s".repeat(3000)}\nbridge ${bridgeToken} end\n`,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const tail = instance.diagnosticTail?.() ?? "";
		expect(tail).not.toContain("sss");
		expect(tail).not.toContain(bridgeToken);
		expect(tail).toContain("bridge [REDACTED] end");
		await instance.shutdown();
	});

	it("keeps a bounded, redacted stderr tail per instance", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		expect(instance.diagnosticTail?.()).toBeUndefined();
		fake.stderr.write("x".repeat(5000));
		fake.stderr.write("\napi_key=sk-private-value fatal: out of memory\n");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const tail = instance.diagnosticTail?.() ?? "";
		expect(tail.length).toBeLessThanOrEqual(2048);
		expect(tail.endsWith("fatal: out of memory")).toBe(true);
		expect(tail).not.toContain("sk-private-value");
		const events = instance.events[Symbol.asyncIterator]();
		await instance.shutdown();
		for (;;) {
			const next = await events.next();
			if (next.done) break;
			expect(JSON.stringify(next.value)).not.toContain("out of memory");
		}
	});

	it("classifies the get_state command timeout as a startup timeout", async () => {
		const fake = fakeProvider({ holdGetState: true });
		await expect(
			new PiRpcHarnessAdapter(fake.provider, {
				executable: "pi",
				startupTimeoutMs: 100,
				commandTimeoutMs: 5,
				shutdownTimeoutMs: 5,
			}).launch(request),
		).rejects.toMatchObject({ code: "PI_RPC_STARTUP_TIMEOUT" });
		expect(fake.child.stdin?.writableEnded).toBe(true);
	});

	it("parses fragmented CRLF JSONL without splitting Unicode separators and completes settled prompts", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		const sent = instance.send(input("prompt paragraph separator", "i1"));
		await sent;
		const delta = "hi😀\u2028there\u2029end";
		const frame = Buffer.from(
			`${JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta },
			})}\r\n`,
		);
		const split = frame.indexOf(Buffer.from("😀")) + 1;
		fake.stdout.write(frame.subarray(0, split));
		fake.stdout.write(frame.subarray(split));
		fake.stdout.write(Buffer.from('{"type":"agent_settled"}\r\n'));
		const got = await collectEvents(instance, 5);
		expect(
			got
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual(["pending", "accepted", "completed"]);
		expect(got.some((event) => event?.text === delta)).toBe(true);
		await instance.shutdown();
	});

	it("emits a message_end status only for completed assistant messages", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		fake.stdout.write(
			`${[
				{ type: "message_end", message: { role: "user", content: "hi" } },
				{ type: "message_end", message: { role: "assistant", content: [] } },
				{ type: "agent_settled" },
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const got = await collectEvents(instance, 2);
		expect(got.map((event) => [event?.kind, event?.text])).toEqual([
			["status", "message_end"],
			["status", "agent_settled"],
		]);
		await instance.shutdown();
	});

	it("forwards tool activity, a one-line thought summary, and non-fatal extension diagnostics", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "/bin/pi",
			startupTimeoutMs: 100,
		}).launch(request);
		fake.stdout.write(
			`${[
				{
					type: "message_update",
					assistantMessageEvent: { type: "thinking_start" },
				},
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "thinking_delta",
						delta:
							"**Checking context usage**\n\nLong private reasoning follows.",
					},
				},
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "thinking_end",
						content:
							"**Checking context usage**\n\nLong private reasoning follows.",
					},
				},
				{
					type: "tool_execution_start",
					toolCallId: "tool-1",
					toolName: "grep",
					args: { pattern: "contextUsage", path: "src" },
				},
				{
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "grep",
					isError: false,
				},
				{
					type: "extension_ui_request",
					id: "notify-1",
					method: "notify",
					message: "Extension initialized",
					notifyType: "info",
				},
				{
					type: "extension_error",
					extensionPath: "/home/user/ext.ts",
					event: "session_start",
					error: "Unable to initialize",
				},
			]
				.map((event) => JSON.stringify(event))
				.join("\n")}\n`,
		);
		const events = await collectEvents(instance, 6);
		expect(events.filter((event) => event?.kind === "activity")).toEqual([
			{
				sessionId: "supervisor",
				kind: "activity",
				activityEvent: { type: "thinking", active: true },
			},
			{
				sessionId: "supervisor",
				kind: "activity",
				activityEvent: { type: "thinking", active: false },
			},
			{
				sessionId: "supervisor",
				kind: "activity",
				activityEvent: { type: "thought", text: "Checking context usage" },
			},
			{
				sessionId: "supervisor",
				kind: "activity",
				activityEvent: {
					type: "tool_start",
					toolCallId: "tool-1",
					summary: "grep: contextUsage — src",
				},
			},
			{
				sessionId: "supervisor",
				kind: "activity",
				activityEvent: {
					type: "tool_end",
					toolCallId: "tool-1",
					failed: false,
				},
			},
			{
				sessionId: "supervisor",
				kind: "activity",
				activityEvent: {
					type: "notification",
					text: "Extension initialized",
					level: "info",
				},
			},
		]);
		const error = await collectEvents(instance, 1);
		expect(error[0]).toMatchObject({
			kind: "error",
			text: "Pi extension ext.ts (session_start): Unable to initialize",
		});
		expect(JSON.stringify([...events, ...error])).not.toContain(
			"private reasoning",
		);
		await instance.shutdown();
	});

	it("forwards bash exit details and /task state entries", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		fake.stdout.write(
			`${[
				{
					type: "tool_execution_start",
					toolCallId: "b1",
					toolName: "bash",
					args: { command: "npm test" },
				},
				{
					type: "tool_execution_end",
					toolCallId: "b1",
					result: {
						content: [{ type: "text", text: "Command exited with code 1" }],
					},
					isError: true,
				},
				{
					type: "entry_appended",
					entry: {
						type: "custom",
						customType: "pi-ad-hooks-task",
						data: { goal: "Ship", status: "active", continuations: 2 },
					},
				},
			]
				.map((event) => JSON.stringify(event))
				.join("\n")}\n`,
		);
		const events = await collectEvents(instance, 3);
		expect(events.map((event) => event?.activityEvent)).toEqual([
			{ type: "tool_start", toolCallId: "b1", summary: "bash: npm test" },
			{ type: "tool_end", toolCallId: "b1", failed: true, detail: "exit 1" },
			{ type: "task", goal: "Ship", status: "active", step: 2 },
		]);
		await instance.shutdown();
	});

	it("handles agent_settled before prompt acknowledgement", async () => {
		let sentSettled = false;
		const fake = fakeProvider({
			beforeResponse(command, stdout) {
				if (command.type === "prompt" && !sentSettled) {
					sentSettled = true;
					stdout.write('{"type":"agent_settled"}\n');
				}
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("fast", "fast"));
		const events = await collectEvents(instance, 4);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual(["pending", "accepted", "completed"]);
		await instance.shutdown();
	});

	it("rejects prompt definitively and cancels dialog requests without exposing secrets", async () => {
		const fake = fakeProvider({ promptSuccess: false });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		const sending = instance.send(input("DO NOT LEAK", "reject"));
		await expect(sending).rejects.toThrow("rejected");
		fake.stdout.write(
			'{"type":"extension_ui_request","id":"dialog-1","method":"confirm","title":"Confirm operation"}\n',
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fake.commands.at(-1)).toMatchObject({
			type: "extension_ui_response",
			id: "dialog-1",
			cancelled: true,
		});
		fake.stderr.write("PRIVATE STDERR");
		const events = await collectEvents(instance, 4);
		expect(events.some((event) => event?.text?.includes("DO NOT LEAK"))).toBe(
			false,
		);
		expect(
			events.some((event) => event?.text?.includes("PRIVATE STDERR")),
		).toBe(false);
		expect(
			events.some((event) =>
				event?.text?.includes("unsupported confirm dialog: Confirm operation"),
			),
		).toBe(true);
		await instance.shutdown();
	});

	it("reports every accepted queued input uncertain if Pi exits before settlement", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("first", "exit-one"));
		fake.stdout.write('{"type":"agent_start"}\n');
		await instance.send(input("second", "exit-two"));
		const exit = fake.child.sendSignal("SIGKILL");
		await exit;
		await instance.exit;
		const events = await collectEvents(instance, 8);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => [event.inputEvent?.inputId, event.inputEvent?.state]),
		).toEqual([
			["exit-one", "pending"],
			["exit-one", "accepted"],
			["exit-two", "pending"],
			["exit-two", "accepted"],
			["exit-one", "uncertain"],
			["exit-two", "uncertain"],
		]);
		await instance.shutdown();
	});

	it("queues parallel inputs through Pi steering and tracks each input until settlement", async () => {
		const fake = fakeProvider({ promptDisposition: "queued" });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("first", "one"));
		fake.stdout.write('{"type":"agent_start"}\n');
		await instance.send(input("second", "two"));
		const prompts = fake.commands.filter(
			(command) => command.type === "prompt",
		);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toMatchObject({ streamingBehavior: "steer" });
		expect(prompts[1]).toMatchObject({ streamingBehavior: "steer" });
		await expect(instance.cancel("two" as InputId)).rejects.toThrow(
			"no input was canceled",
		);
		expect(
			fake.commands.filter((command) => command.type === "abort"),
		).toHaveLength(0);
		fake.stdout.write('{"type":"agent_settled"}\n');
		const events = await collectEvents(instance, 8);
		const inputEvents = events.flatMap((event) =>
			event?.inputEvent ? [event.inputEvent] : [],
		);
		expect(inputEvents).toEqual([
			{ inputId: "one", state: "pending" },
			{ inputId: "one", state: "accepted" },
			{ inputId: "two", state: "pending" },
			{ inputId: "two", state: "accepted" },
			{ inputId: "one", state: "completed" },
			{ inputId: "two", state: "completed" },
		]);
		await instance.shutdown();
	});

	it("aborts an acknowledged active input as failed with cancellation detail", async () => {
		const fake = fakeProvider({
			beforeResponse(command, stdout) {
				if (command.type === "abort")
					stdout.write('{"type":"agent_settled"}\n');
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("cancel", "cancel"));
		await instance.cancel("cancel" as InputId);
		const states = (await collectEvents(instance, 4))
			.filter((event) => event?.inputEvent)
			.map((event) => event?.inputEvent);
		expect(states.map((event) => event?.state)).toEqual([
			"pending",
			"accepted",
			"failed",
		]);
		expect(states.at(-1)?.detail).toBe("Input canceled");
		await instance.shutdown();
	});

	it("keeps native queued input unresolved through abort settlement until later consumption", async () => {
		const fake = fakeProvider({ holdAbort: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("active", "active-run"));
		fake.stdout.write('{"type":"agent_start"}\n');
		await instance.send(input("native queued", "queued-input"));
		const cancel = instance.cancelCurrent?.();
		await vi.waitFor(() =>
			expect(fake.commands.some((command) => command.type === "abort")).toBe(
				true,
			),
		);
		const abort = fake.commands.find((command) => command.type === "abort");
		if (!abort || typeof abort.id !== "string")
			throw new Error("current-run abort command was not sent");

		fake.stdout.write('{"type":"agent_settled"}\n');
		const earlyEvents = await collectEvents(instance, 6);
		const earlyInputs = earlyEvents.flatMap((event) => event?.inputEvent ?? []);
		expect(
			earlyInputs.some(
				(event) =>
					event?.inputId === "queued-input" && event.state === "completed",
			),
		).toBe(false);
		const queued = (
			instance as unknown as {
				activeInputs: Map<InputId, { accepted: boolean; settled: boolean }>;
			}
		).activeInputs.get("queued-input" as InputId);
		expect(queued).toMatchObject({ accepted: true, settled: false });

		fake.stdout.write(
			`${JSON.stringify({
				type: "response",
				id: abort.id,
				command: "abort",
				success: true,
			})}\n`,
		);
		await cancel;
		const activeCanceled = await collectEvents(instance, 1);
		expect(activeCanceled[0]?.inputEvent).toMatchObject({
			inputId: "active-run",
			state: "failed",
			detail: "Input canceled",
		});
		await instance.send(input("continue", "after-cancel"));
		fake.stdout.write('{"type":"agent_start"}\n{"type":"agent_settled"}\n');
		const laterEvents = await collectEvents(instance, 6);
		const laterInputs = laterEvents.flatMap((event) => event?.inputEvent ?? []);
		expect(laterInputs).toContainEqual({
			inputId: "queued-input",
			state: "completed",
		});
		expect(laterInputs).toContainEqual({
			inputId: "after-cancel",
			state: "completed",
		});
		const prompts = fake.commands.filter(
			(command) => command.type === "prompt",
		);
		expect(prompts).toHaveLength(3);
		expect(prompts[1]).toMatchObject({ streamingBehavior: "steer" });
		expect(prompts[2]).toMatchObject({ streamingBehavior: "steer" });
		expect(
			fake.commands.filter((command) => command.type === "abort"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it("reports manual and automatic compaction as status events", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		fake.stdout.write(
			'{"type":"auto_compaction_start"}\n{"type":"auto_compaction_end"}\n{"type":"compaction_start","reason":"manual"}\n{"type":"compaction_end","reason":"manual"}\n',
		);
		const events = await collectEvents(instance, 4);
		expect(events.map((event) => event?.text)).toEqual([
			"compaction_start",
			"compaction_end",
			"compaction_start",
			"compaction_end",
		]);
		await instance.shutdown();
	});

	it("cancels the current run when every acknowledged input was sent as a steer", async () => {
		const fake = fakeProvider({
			beforeResponse(command, stdout) {
				if (command.type === "abort")
					stdout.write('{"type":"agent_settled"}\n');
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		fake.stdout.write('{"type":"agent_start"}\n');
		await collectEvents(instance, 1);
		await instance.send(input("first steer", "first"));
		await instance.send(input("second steer", "second"));
		await instance.cancelCurrent?.();
		const aborts = fake.commands.filter((command) => command.type === "abort");
		expect(aborts).toHaveLength(1);
		await instance.shutdown();
	});

	it("rejects overlapping cancellation and binds abort replies to their input", async () => {
		const fake = fakeProvider({ holdAbort: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("first", "cancel-owner-a"));
		const firstCancel = instance.cancel("cancel-owner-a" as InputId);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const abortCommands = () =>
			fake.commands.filter((command) => command.type === "abort");
		const firstAbort = abortCommands()[0];
		if (!firstAbort || typeof firstAbort.id !== "string")
			throw new Error("first abort command was not sent");
		await expect(instance.cancel("cancel-owner-a" as InputId)).rejects.toThrow(
			"already in progress",
		);
		expect(abortCommands()).toHaveLength(1);
		fake.stdout.write(
			`${JSON.stringify({
				type: "response",
				id: firstAbort.id,
				command: "abort",
				success: true,
			})}\n`,
		);
		await expect(firstCancel).resolves.toBeUndefined();

		await instance.send(input("second", "cancel-owner-b"));
		const secondCancel = instance.cancel("cancel-owner-b" as InputId);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const secondAbort = abortCommands()[1];
		if (!secondAbort || typeof secondAbort.id !== "string")
			throw new Error("second abort command was not sent");
		fake.stdout.write(
			`${JSON.stringify({
				type: "response",
				id: firstAbort.id,
				command: "abort",
				success: true,
			})}\n`,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const queuedDuringCancel = instance.send(
			input("queue during cancellation", "during-cancel-b"),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(2);
		fake.stdout.write(
			`{"type":"agent_settled"}\n${JSON.stringify({
				type: "response",
				id: secondAbort.id,
				command: "abort",
				success: true,
			})}\n`,
		);
		await expect(secondCancel).resolves.toBeUndefined();
		await expect(queuedDuringCancel).resolves.toBeUndefined();
		const prompts = fake.commands.filter(
			(command) => command.type === "prompt",
		);
		expect(prompts[2]?.streamingBehavior).toBe("steer");
		fake.stdout.write('{"type":"agent_start"}\n{"type":"agent_settled"}\n');

		const events = await collectEvents(instance, 12);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual([
			"pending",
			"accepted",
			"failed",
			"pending",
			"accepted",
			"failed",
			"pending",
			"accepted",
			"completed",
		]);
		await instance.shutdown();
	});

	it("completes settled work when Pi rejects abort after settlement", async () => {
		const fake = fakeProvider({
			abortSuccess: false,
			beforeResponse(command, stdout) {
				if (command.type === "abort")
					stdout.write('{"type":"agent_settled"}\n');
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("still active", "abort-rejected"));
		await expect(instance.cancel("abort-rejected" as InputId)).rejects.toThrow(
			"rejected the abort",
		);
		await expect(
			instance.send(input("second", "after-settlement")),
		).resolves.toBeUndefined();
		fake.stdout.write('{"type":"agent_settled"}\n');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await instance.shutdown();
	});

	it("reports uncertain cancellation when the abort response is lost after settlement", async () => {
		const fake = fakeProvider({
			holdAbort: true,
			beforeResponse(command, stdout) {
				if (command.type === "abort")
					stdout.write('{"type":"agent_settled"}\n');
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 10,
		}).launch(request);
		await instance.send(input("cancel uncertainty", "abort-uncertain"));
		await expect(instance.cancel("abort-uncertain" as InputId)).rejects.toThrow(
			"timed out",
		);
		const events = await collectEvents(instance, 4);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual(["pending", "accepted", "uncertain"]);
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it("holds new submissions after uncertain abort until Pi settles", async () => {
		const fake = fakeProvider({ holdAbort: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 10,
		}).launch(request);
		await instance.send(input("cancel uncertainty", "abort-uncertain-pending"));
		await expect(
			instance.cancel("abort-uncertain-pending" as InputId),
		).rejects.toThrow("timed out");
		const waitingSend = instance.send(
			input("after settle", "after-uncertain-abort"),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		fake.stdout.write('{"type":"agent_settled"}\n');
		await expect(waitingSend).resolves.toBeUndefined();
		fake.stdout.write('{"type":"agent_start"}\n{"type":"agent_settled"}\n');
		const events = await collectEvents(instance, 9);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => [event.inputEvent?.inputId, event.inputEvent?.state]),
		).toEqual([
			["abort-uncertain-pending", "pending"],
			["abort-uncertain-pending", "accepted"],
			["abort-uncertain-pending", "uncertain"],
			["after-uncertain-abort", "pending"],
			["after-uncertain-abort", "accepted"],
			["after-uncertain-abort", "completed"],
		]);
		await instance.shutdown();
	});

	it("throws typed uncertainty if the child exits before the prompt response", async () => {
		const fake = fakeProvider({ exitOnPrompt: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await expect(
			instance.send(input("written then lost", "exit-before-ack")),
		).rejects.toBeInstanceOf(UncertainInputDeliveryError);
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it("drains final correlated response and events after child exit", async () => {
		const fake = fakeProvider({ exitBeforePromptResponse: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			exitDrainTimeoutMs: 100,
		}).launch(request);
		await expect(
			instance.send(input("final output", "final")),
		).resolves.toBeUndefined();
		const events = await collectEvents(instance, 4);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual(["pending", "accepted", "completed"]);
		await instance.shutdown();
	});

	it("applies final abort acknowledgement and settlement before EOF after exit", async () => {
		const fake = fakeProvider({ exitBeforeAbortResponse: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			exitDrainTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("abort final", "abort-final"));
		await expect(
			instance.cancel("abort-final" as InputId),
		).resolves.toBeUndefined();
		const events = await collectEvents(instance, 5);
		const deliveries = events
			.filter((event) => event?.inputEvent)
			.map((event) => event?.inputEvent);
		expect(deliveries.map((event) => event?.state)).toEqual([
			"pending",
			"accepted",
			"failed",
		]);
		expect(deliveries.at(-1)?.detail).toBe("Input canceled");
		await instance.shutdown();
	});

	it("marks active accepted input uncertain on child exit", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("active", "exit"));
		await fake.child.sendSignal("SIGTERM");
		const events = await collectEvents(instance, 4);
		expect(
			events.some((event) => event?.inputEvent?.state === "uncertain"),
		).toBe(true);
		await instance.shutdown();
	});

	it("treats malformed correlated prompt acknowledgements as protocol uncertainty", async () => {
		const fake = fakeProvider({ malformedPromptAck: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			shutdownTimeoutMs: 5,
		}).launch(request);
		await expect(
			instance.send(input("untrusted ack", "malformed-ack")),
		).rejects.toBeInstanceOf(UncertainInputDeliveryError);
		const events = await collectEvents(instance, 3);
		expect(
			events.some((event) => event?.inputEvent?.state === "uncertain"),
		).toBe(true);
		expect(events.some((event) => event?.inputEvent?.state === "failed")).toBe(
			false,
		);
		await instance.shutdown();
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		"rejects invalid command timeout %s",
		(value) => {
			expect(
				() =>
					new PiRpcHarnessAdapter(fakeProvider().provider, {
						executable: "pi",
						commandTimeoutMs: value,
					}),
			).toThrow("from 1 to");
		},
	);

	it("rejects record caps above the documented bound", () => {
		expect(
			() =>
				new PiRpcHarnessAdapter(fakeProvider().provider, {
					executable: "pi",
					maxRecordBytes: 64 * 1024 * 1024 + 1,
				}),
		).toThrow("maxRecordBytes");
	});

	it.each(["stdin", "stdout", "stderr"] as const)(
		"terminates process if %s pipe is unavailable",
		async (missingStream) => {
			const fake = fakeProvider({ missingStream });
			await expect(
				new PiRpcHarnessAdapter(fake.provider, {
					executable: "pi",
					shutdownTimeoutMs: 5,
				}).launch(request),
			).rejects.toMatchObject({
				code: "PI_STARTUP_FAILED",
				message: "Pi RPC startup failed",
			});
		},
	);

	it("escalates TERM to KILL on bounded shutdown", async () => {
		const fake = fakeProvider({ exitOnTerm: false });
		const signals: string[] = [];
		const original = fake.child.sendSignal.bind(fake.child);
		fake.child.sendSignal = async (signal) => {
			signals.push(signal);
			if (signal === "SIGKILL") await original(signal);
		};
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			shutdownTimeoutMs: 5,
		}).launch(request);
		await instance.shutdown();
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
