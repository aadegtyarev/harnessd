import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ManagedProcess,
	ProcessLaunchRequest,
	ProcessProvider,
} from "../src/core/ports.js";
import type {
	AdapterId,
	HarnessEvent,
	Input,
	InputId,
	ProcessId,
	SessionId,
} from "../src/core/types.js";
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

interface FakeOptions {
	readonly holdPrompt?: boolean;
	readonly holdGetState?: boolean;
	readonly exitOnGetState?: boolean;
	readonly holdAbort?: boolean;
	readonly malformedPromptAck?: boolean;
	readonly exitOnPrompt?: boolean;
	readonly exitBeforePromptResponse?: boolean;
	readonly exitBeforeAbortResponse?: boolean;
	readonly sessionId?: string;
	readonly promptSuccess?: boolean;
	readonly promptDisposition?: string;
	readonly abortSuccess?: boolean;
	readonly exitOnTerm?: boolean;
	readonly missingStream?: "stdin" | "stdout" | "stderr";
	readonly rpcResponses?: Readonly<
		Record<
			string,
			{
				readonly success?: boolean;
				readonly data?: unknown;
				readonly error?: unknown;
			}
		>
	>;
	readonly beforeResponse?: (
		command: Record<string, unknown>,
		stdout: PassThrough,
	) => void;
}
const children: ManagedProcess[] = [];
afterEach(async () => {
	await Promise.all(
		children.splice(0).map(async (child) => {
			child.stdin?.end();
			const exited = child.exit.then(
				() => true,
				() => true,
			);
			try {
				await Promise.race([
					exited,
					new Promise((resolve) => setTimeout(resolve, 50)),
				]);
				if (
					await Promise.race([
						exited,
						new Promise<boolean>((resolve) =>
							setTimeout(() => resolve(false), 1),
						),
					])
				)
					return;
			} catch {
				return;
			}
			try {
				await child.sendSignal("SIGKILL");
			} catch {
				/* already exited */
			}
		}),
	);
});

function fakeProvider(options: FakeOptions = {}) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let finish!: (value: { code: number | null; signal: string | null }) => void;
	let exited = false;
	const exit = new Promise<{ code: number | null; signal: string | null }>(
		(resolve) => {
			finish = resolve;
		},
	);
	const commands: Record<string, unknown>[] = [];
	const signals: string[] = [];
	let launchRequest: ProcessLaunchRequest | undefined;
	let text = "";
	stdin.setEncoding("utf8");
	const complete = (
		code: number | null,
		signal: string | null,
		closeStreams = true,
	) => {
		if (!exited) {
			exited = true;
			finish({ code, signal });
			if (closeStreams) {
				stdout.end();
				stderr.end();
			}
		}
	};
	stdin.on("data", (chunk: string) => {
		text += chunk;
		for (;;) {
			const index = text.indexOf("\n");
			if (index < 0) break;
			const command = JSON.parse(text.slice(0, index)) as Record<
				string,
				unknown
			>;
			text = text.slice(index + 1);
			commands.push(command);
			if (command.type === "extension_ui_response") continue;
			if (command.type === "get_state" && options.holdGetState) continue;
			if (command.type === "get_state" && options.exitOnGetState) {
				complete(1, null);
				continue;
			}
			if (command.type === "prompt" && options.exitOnPrompt) {
				complete(1, null);
				continue;
			}
			if (options.beforeResponse) {
				options.beforeResponse(command, stdout);
			}
			if (command.type === "prompt" && options.malformedPromptAck) {
				stdout.write(
					`${JSON.stringify({
						type: "response",
						id: command.id,
						command: "prompt",
						success: "yes",
					})}\n`,
				);
			}
			if (command.type === "abort" && options.holdAbort) continue;
			if (command.type === "prompt" && options.exitBeforePromptResponse) {
				complete(0, null, false);
				setImmediate(() => {
					stdout.write(
						`${JSON.stringify({
							type: "response",
							id: command.id,
							command: "prompt",
							success: true,
							data: { disposition: "started" },
						})}\r\n{"type":"agent_settled"}\r\n`,
					);
					stdout.end();
					stderr.end();
				});
				continue;
			}
			if (command.type === "abort" && options.exitBeforeAbortResponse) {
				complete(0, null, false);
				setImmediate(() => {
					stdout.write(
						`{"type":"agent_settled"}\r\n${JSON.stringify({
							type: "response",
							id: command.id,
							command: "abort",
							success: options.abortSuccess ?? true,
						})}\r\n`,
					);
					stdout.end();
					stderr.end();
				});
				continue;
			}
			if (command.type === "prompt" && options.holdPrompt) continue;
			const response =
				command.type === "get_state"
					? {
							type: "response",
							id: command.id,
							command: command.type,
							success: true,
							data: { sessionId: options.sessionId ?? "native-exact" },
						}
					: {
							type: "response",
							id: command.id,
							command: command.type,
							success:
								command.type === "prompt"
									? (options.promptSuccess ?? true)
									: command.type === "abort"
										? (options.abortSuccess ?? true)
										: true,
							...(command.type === "prompt" && options.promptDisposition
								? { data: { disposition: options.promptDisposition } }
								: {}),
						};
			const override = options.rpcResponses?.[String(command.type)];
			stdout.write(
				`${JSON.stringify(override ? { ...response, ...override } : response)}\r\n`,
			);
		}
	});
	stdin.on("end", () => {
		if (options.exitOnTerm !== false) complete(0, null);
	});
	const managed: ManagedProcess = {
		id: `fake-${children.length}` as ProcessId,
		stdin: options.missingStream === "stdin" ? null : stdin,
		stdout: options.missingStream === "stdout" ? null : stdout,
		stderr: options.missingStream === "stderr" ? null : stderr,
		exit,
		async sendSignal(signal) {
			signals.push(signal);
			complete(null, signal);
		},
	};
	children.push(managed);
	const provider: ProcessProvider = {
		descriptor: {
			id: "fake" as AdapterId,
			capabilities: ["process.launch", "process.signal"],
		},
		async launch(request) {
			launchRequest = request;
			return managed;
		},
	};
	return {
		provider,
		commands,
		signals,
		stdout,
		stderr,
		child: managed,
		get launchRequest() {
			return launchRequest;
		},
	};
}
const input = (text: string, id: string): Input => ({
	id: id as InputId,
	sessionId: "supervisor" as SessionId,
	text,
	createdAt: new Date(),
});
async function collectEvents(
	instance: Awaited<ReturnType<PiRpcHarnessAdapter["launch"]>>,
	count: number,
) {
	const iterator = instance.events[Symbol.asyncIterator]();
	const result = [];
	for (let i = 0; i < count; i++) result.push((await iterator.next()).value);
	return result;
}
const request = { sessionId: "supervisor" as SessionId, cwd: "/a cwd" };

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
			"input.submit",
		]);
		expect(fake.launchRequest).toMatchObject({
			executable: options.executable,
			args: ["--model", "model name", "--mode", "rpc"],
			cwd: request.cwd,
			env: options.env,
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
		const extensionIndex = launchRequest?.args.indexOf("--extension") ?? -1;
		expect(launchRequest?.args[extensionIndex + 1]).toMatch(
			/agent-file-send-extension\.(?:ts|js)$/,
		);
		const env = launchRequest?.env ?? {};
		const url = env[AGENT_FILE_SEND_URL_ENV];
		const token = env[AGENT_FILE_SEND_TOKEN_ENV];
		expect(Object.keys(env).sort()).toEqual(
			[AGENT_FILE_SEND_TOKEN_ENV, AGENT_FILE_SEND_URL_ENV].sort(),
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
				args: [executable, "--mode", "rpc"],
				cwd: request.cwd,
				env: undefined,
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
				args: [executable, "--mode", "rpc"],
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
				env: [],
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
			expect(fake.launchRequest?.args).toEqual(["--mode", "rpc"]);
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

	it("forwards tool activity and non-fatal extension diagnostics but never raw thinking text", async () => {
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
						delta: "private reasoning",
					},
				},
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "thinking_end",
						content: "private reasoning",
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
		const events = await collectEvents(instance, 5);
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
		const events = await collectEvents(instance, 3);
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
		expect(prompts[0]).not.toHaveProperty("streamingBehavior");
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
		expect(prompts[2]?.streamingBehavior).toBeUndefined();
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

	it.each(["bad-json", "oversized"] as const)(
		"fails and cleans up %s stdout",
		async (kind) => {
			const fake = fakeProvider({ exitOnTerm: false });
			const instance = await new PiRpcHarnessAdapter(fake.provider, {
				executable: "pi",
				startupTimeoutMs: 100,
				shutdownTimeoutMs: 5,
				maxRecordBytes: 150,
			}).launch(request);
			fake.stdout.write(
				kind === "bad-json"
					? "{bad}\n"
					: `{"type":"agent_start"}\n${"x".repeat(200)}`,
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fake.signals).toContain("SIGTERM");
			await instance.shutdown();
		},
	);

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
