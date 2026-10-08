import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ApplicationResult,
	RuntimeDispatch,
} from "../src/application-runtime.js";
import { ApplicationRuntime } from "../src/application-runtime.js";
import type {
	HarnessAdapter,
	HarnessInstance,
	ProcessProvider,
	TransportAdapter,
	TransportEventSubscription,
} from "../src/core/ports.js";
import { SqliteSessionStore } from "../src/core/session-store.js";
import type {
	HarnessEvent,
	InputId,
	SessionId,
	SessionSummary,
} from "../src/core/types.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import {
	PiControlError,
	PiRpcHarnessAdapter,
	UncertainInputDeliveryError,
} from "../src/harness/pi-rpc-harness.js";
import { NodeProcessProvider } from "../src/process/node-process-provider.js";

const dirs: string[] = [];
function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}
function sessionFrom(result: ApplicationResult): SessionSummary {
	if (
		!result.ok ||
		result.value === undefined ||
		typeof result.value !== "object" ||
		!("id" in result.value)
	)
		throw new Error("Expected a session result");
	return result.value as SessionSummary;
}
function inputIdFrom(result: ApplicationResult): InputId {
	if (!result.ok || typeof result.value !== "string")
		throw new Error("Expected an input ID result");
	return result.value as InputId;
}
async function state() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "runtime-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function transport(
	id: string,
	start: (
		dispatch: RuntimeDispatch,
		subscribeEvents: TransportEventSubscription,
	) => Promise<void>,
	stop: () => Promise<void>,
): TransportAdapter {
	return { descriptor: { id: id as never, capabilities: [] }, start, stop };
}

describe("application runtime", () => {
	it("dispatches dynamic command list and run requests to core", async () => {
		const store = await SqliteSessionStore.open(await state());
		const calls: unknown[][] = [];
		const harness: HarnessAdapter = {
			descriptor: {
				id: "commands" as never,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.commands.list",
					"harness.commands.run",
				],
			},
			async launch() {
				const instance: HarnessInstance = {
					processId: "commands" as never,
					exit: new Promise(() => {}),
					events: (async function* () {})(),
					control: {
						async getCommands() {
							calls.push(["list"]);
							return [{ name: "cost", description: "Cost" }];
						},
						async runCommand(name, remainder) {
							calls.push(["run", name, remainder]);
							return { disposition: "accepted" };
						},
						async getSelection() {
							return {};
						},
						async getStatus() {
							return {};
						},
						async listModels() {
							return [];
						},
						async listEfforts() {
							return [];
						},
						async setModel(provider, id) {
							return { provider, id, name: id };
						},
						async setEffort() {},
					},
					async send() {},
					async cancel() {},
					async shutdown() {},
				};
				return instance;
			},
		};
		const runtime = await ApplicationRuntime.start({
			piExecutable: "/unused/pi",
			stateDirectory: await state(),
			store,
			transports: [],
			harnesses: [harness],
		});
		const session = sessionFrom(
			await runtime.dispatch({
				requestId: "commands-create",
				principalId: "test",
				kind: "create",
				harnessId: harness.descriptor.id,
				cwd: os.tmpdir(),
			}),
		);
		expect(
			await runtime.dispatch({
				requestId: "commands-list",
				principalId: "test",
				kind: "command_list",
				sessionId: session.id,
			}),
		).toMatchObject({
			ok: true,
			value: [{ name: "cost", description: "Cost" }],
		});
		expect(
			await runtime.dispatch({
				requestId: "commands-run",
				principalId: "test",
				kind: "command_run",
				sessionId: session.id,
				name: "cost",
				remainder: "  raw ",
			}),
		).toMatchObject({ ok: true, value: { disposition: "accepted" } });
		expect(calls).toEqual([["list"], ["run", "cost", "  raw "]]);
		await runtime.close();
	});

	it.each([undefined, "direct"] as const)(
		"delegates create launch to NodeProcessProvider in direct mode %s",
		async (executionMode) => {
			const launch = vi
				.spyOn(NodeProcessProvider.prototype, "launch")
				.mockRejectedValue(new Error("fake launch failure"));
			const runtime = await ApplicationRuntime.start({
				piExecutable: "/unused/pi",
				...(executionMode ? { executionMode } : {}),
				stateDirectory: await state(),
				transports: [],
			});
			const result = await runtime.dispatch({
				requestId: "create-direct",
				principalId: "test",
				kind: "create",
				harnessId: "pi-rpc" as never,
				cwd: os.tmpdir(),
			});
			expect(result).toMatchObject({ ok: false });
			expect(launch).toHaveBeenCalledOnce();
			expect(launch).toHaveBeenCalledWith({
				executable: "/unused/pi",
				args: [
					"--mode",
					"rpc",
					"--extension",
					expect.stringMatching(/pi-reload-extension\.(?:ts|js)$/),
				],
				cwd: await realpath(os.tmpdir()),
				env: {
					HARNESSD_PI_RELOAD_COMMAND: expect.stringMatching(
						/^harnessd-reload-[a-f0-9-]{36}$/,
					),
				},
				stdio: "pipe",
			});
			await runtime.close();
		},
	);

	it.each([undefined, "pi"] as const)(
		"creates a session without a harness ID using the built-in Pi default (%s)",
		async (defaultHarnessId) => {
			const instance: HarnessInstance = {
				processId: "default-pi-process" as never,
				exit: new Promise(() => {}),
				nativeSessionId: "native-default",
				events: (async function* () {})(),
				async send() {},
				async cancel() {},
				async shutdown() {},
			};
			const launch = vi
				.spyOn(PiRpcHarnessAdapter.prototype, "launch")
				.mockResolvedValue(instance);
			const runtime = await ApplicationRuntime.start({
				piExecutable: "/unused/pi",
				...(defaultHarnessId ? { defaultHarnessId } : {}),
				stateDirectory: await state(),
				transports: [],
			});
			const created = await runtime.dispatch({
				requestId: "create-default-pi",
				principalId: "test",
				kind: "create",
				cwd: os.tmpdir(),
			});
			expect(sessionFrom(created)).toMatchObject({
				harnessId: "pi-rpc",
				nativeSessionId: "native-default",
			});
			expect(launch).toHaveBeenCalledOnce();
			await runtime.close();
		},
	);

	it("passes the same generic file handler to both built-in harnesses", async () => {
		const makeInstance = (id: string): HarnessInstance => ({
			processId: id as never,
			exit: new Promise(() => {}),
			events: (async function* () {})(),
			async send() {},
			async cancel() {},
			async shutdown() {},
		});
		const claude = vi
			.spyOn(ClaudeCodeHarnessAdapter.prototype, "launch")
			.mockImplementation(function (this: ClaudeCodeHarnessAdapter) {
				expect(this.descriptor.capabilities).toContain("harness.file.send");
				return Promise.resolve(makeInstance("claude-file-send"));
			});
		const pi = vi
			.spyOn(PiRpcHarnessAdapter.prototype, "launch")
			.mockImplementation(function (this: PiRpcHarnessAdapter) {
				expect(this.descriptor.capabilities).toContain("harness.file.send");
				return Promise.resolve(makeInstance("pi-file-send"));
			});
		const transport = {
			descriptor: { id: "file-send-transport" as never, capabilities: [] },
			async start() {},
			async stop() {},
			async sendAgentFile() {
				return { fileName: "a", delivered: 1, recipients: 1 };
			},
		};
		const runtime = await ApplicationRuntime.start({
			piExecutable: "/unused/pi",
			stateDirectory: await state(),
			transports: [transport],
		});
		for (const harnessId of ["claude-code", "pi-rpc"] as const) {
			await runtime.dispatch({
				requestId: `create-${harnessId}-file-send`,
				principalId: "test",
				kind: "create",
				harnessId: harnessId as never,
				cwd: os.tmpdir(),
			});
		}
		expect(claude).toHaveBeenCalledOnce();
		expect(pi).toHaveBeenCalledOnce();
		await runtime.close();
	});

	it("routes optional session names and renames through the application boundary", async () => {
		const runtime = await ApplicationRuntime.start({
			piExecutable: "/unused/pi",
			stateDirectory: await state(),
			transports: [],
			harnesses: [
				{
					descriptor: {
						id: "rename-test" as never,
						capabilities: ["harness.launch", "harness.stop"],
					},
					async launch() {
						return {
							processId: "rename-test-process" as never,
							exit: new Promise(() => {}),
							events: (async function* () {})(),
							async send() {},
							async cancel() {},
							async shutdown() {},
						};
					},
				},
			],
		});
		const created = await runtime.dispatch({
			requestId: "create-named",
			principalId: "test",
			kind: "create",
			harnessId: "rename-test" as never,
			cwd: os.tmpdir(),
			name: "Menu session",
		});
		const session = sessionFrom(created);
		expect(session.name).toBe("Menu session");
		const renamed = await runtime.dispatch({
			requestId: "rename-session",
			principalId: "test",
			kind: "rename",
			sessionId: session.id,
			name: "Renamed session",
		});
		expect(sessionFrom(renamed).name).toBe("Renamed session");
		const cleared = await runtime.dispatch({
			requestId: "clear-session-name",
			principalId: "test",
			kind: "rename",
			sessionId: session.id,
		});
		expect(sessionFrom(cleared)).not.toHaveProperty("name");
		await runtime.close();
	});

	it("allowlists typed reload busy errors through the application boundary", async () => {
		const runtime = await ApplicationRuntime.start({
			piExecutable: "/unused/pi",
			stateDirectory: await state(),
			transports: [],
			harnesses: [
				{
					descriptor: {
						id: "reload-runtime" as never,
						capabilities: ["harness.launch", "harness.stop", "harness.reload"],
					},
					async launch() {
						return {
							processId: "reload-runtime-process" as never,
							exit: new Promise(() => {}),
							events: (async function* () {})(),
							async send() {},
							async cancel() {},
							async shutdown() {},
							control: {
								async getSelection() {
									return {};
								},
								async getStatus() {
									return {};
								},
								async listModels() {
									return [];
								},
								async listEfforts() {
									return [];
								},
								async setModel() {
									return { provider: "test", id: "test", name: "test" };
								},
								async setEffort() {},
								async reload() {
									throw new PiControlError("RELOAD_BUSY");
								},
							},
						};
					},
				},
			],
		});
		const session = sessionFrom(
			await runtime.dispatch({
				requestId: "reload-create",
				principalId: "test",
				kind: "create",
				harnessId: "reload-runtime" as never,
				cwd: os.tmpdir(),
			}),
		);
		const result = await runtime.dispatch({
			requestId: "reload-busy",
			principalId: "test",
			kind: "reload",
			sessionId: session.id,
			beforeDispatch: () => true,
		});
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "RELOAD_BUSY",
				message: expect.stringContaining("session is busy"),
			},
		});
		await runtime.close();
	});

	it("routes delete through the runtime and returns safe stopped-session errors", async () => {
		const runtime = await ApplicationRuntime.start({
			piExecutable: "/unused/pi",
			stateDirectory: await state(),
			transports: [],
			harnesses: [
				{
					descriptor: {
						id: "delete-test" as never,
						capabilities: ["harness.launch", "harness.stop"],
					},
					async launch() {
						return {
							processId: "delete-test-process" as never,
							exit: new Promise(() => {}),
							events: (async function* () {})(),
							async send() {},
							async cancel() {},
							async shutdown() {},
						};
					},
				},
			],
		});
		const created = await runtime.dispatch({
			requestId: "create-before-delete",
			principalId: "test",
			kind: "create",
			harnessId: "delete-test" as never,
			cwd: os.tmpdir(),
		});
		const session = sessionFrom(created);
		const activeDelete = await runtime.dispatch({
			requestId: "delete-active",
			principalId: "test",
			kind: "delete",
			sessionId: session.id,
		});
		expect(activeDelete).toMatchObject({
			ok: false,
			error: {
				code: "SESSION_NOT_STOPPED",
				message: expect.stringContaining(
					"Stop the session before deleting it with /stop.\n\nError:",
				),
			},
		});
		await runtime.dispatch({
			requestId: "stop-before-delete",
			principalId: "test",
			kind: "stop",
			sessionId: session.id,
		});
		expect(
			await runtime.dispatch({
				requestId: "delete-stopped",
				principalId: "test",
				kind: "delete",
				sessionId: session.id,
			}),
		).toMatchObject({
			requestId: "delete-stopped",
			ok: true,
			value: undefined,
		});
		const listed = await runtime.dispatch({
			requestId: "list-after-delete",
			principalId: "test",
			kind: "list",
		});
		expect(listed).toMatchObject({ ok: true, value: [] });
		await runtime.close();
	});

	it("routes explicit resume through the runtime and preserves the saved native ID", async () => {
		let resumeRequest: unknown;
		const instance = {
			processId: "runtime-resume-process" as never,
			exit: new Promise<{ code: number | null; signal: string | null }>(
				() => {},
			),
			nativeSessionId: "native-runtime-session",
			events: (async function* () {})(),
			async send() {},
			async cancel() {},
			async shutdown() {},
		};
		const runtime = await ApplicationRuntime.start({
			piExecutable: "/unused/pi",
			stateDirectory: await state(),
			transports: [],
			harnesses: [
				{
					descriptor: {
						id: "runtime-resume" as never,
						capabilities: ["harness.launch", "harness.stop", "harness.resume"],
					},
					async launch() {
						return instance;
					},
					async resume(request) {
						resumeRequest = request;
						return instance;
					},
				},
			],
		});
		const created = await runtime.dispatch({
			requestId: "runtime-resume-create",
			principalId: "test",
			kind: "create",
			harnessId: "runtime-resume" as never,
			cwd: os.tmpdir(),
		});
		const session = sessionFrom(created);
		await runtime.dispatch({
			requestId: "runtime-resume-stop",
			principalId: "test",
			kind: "stop",
			sessionId: session.id,
		});
		const resumed = await runtime.dispatch({
			requestId: "runtime-resume-request",
			principalId: "test",
			kind: "resume",
			sessionId: session.id,
		});
		expect(resumed).toMatchObject({
			requestId: "runtime-resume-request",
			ok: true,
			value: { id: session.id, status: "running" },
		});
		expect(resumeRequest).toEqual({
			sessionId: session.id,
			cwd: session.cwd,
			nativeSessionId: "native-runtime-session",
		});
		await runtime.close();
	});

	it("returns actionable Pi startup errors and logs a useful redacted trace", async () => {
		const journal = vi.spyOn(console, "error").mockImplementation(() => {});
		const launchError = Object.assign(new Error("secret path detail"), {
			code: "ENOENT",
		});
		vi.spyOn(NodeProcessProvider.prototype, "launch").mockRejectedValue(
			launchError,
		);
		const runtime = await ApplicationRuntime.start({
			piExecutable: "/private/pi",
			stateDirectory: await state(),
			transports: [],
		});
		const result = await runtime.dispatch({
			requestId: "create-pi-startup-failure",
			principalId: "test",
			kind: "create",
			harnessId: "pi-rpc" as never,
			cwd: os.tmpdir(),
		});
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "PI_EXECUTABLE_NOT_FOUND",
				message: expect.stringContaining(
					"Pi CLI was not found; check HARNESSD_PI_EXECUTABLE.\n\nError:",
				),
			},
		});
		expect(journal).toHaveBeenCalledWith(
			expect.stringContaining("harnessd: request failure"),
		);
		expect(journal).not.toHaveBeenCalledWith(
			expect.stringContaining("secret path detail"),
		);
		await runtime.close();
	});

	it("routes an injected provider to the default Pi harness", async () => {
		const store = await SqliteSessionStore.open(await state());
		const launch = vi.fn(async () => {
			throw new Error("fake launch failure");
		});
		const provider: ProcessProvider = {
			descriptor: {
				id: "fake-process" as never,
				capabilities: ["process.isolation", "process.launch", "process.signal"],
			},
			launch,
		};
		const runtime = await ApplicationRuntime.start({
			piExecutable: "/unused/pi",
			executionMode: "isolated",
			processProvider: provider,
			store,
			transports: [],
		});
		const result = await runtime.dispatch({
			requestId: "create",
			principalId: "test",
			kind: "create",
			harnessId: "pi-rpc" as never,
			cwd: os.tmpdir(),
		});
		expect(launch).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ ok: false });
		await runtime.close();
	});

	it.each([
		["process.isolation"],
		["process.launch"],
		["process.signal"],
	] as const)(
		"fails isolated preflight without %s before side effects",
		async (missing) => {
			const openStore = vi.spyOn(SqliteSessionStore, "open");
			const launch = vi.fn(async () => {
				throw new Error("must not launch");
			});
			const provider: ProcessProvider = {
				descriptor: {
					id: "fake-process" as never,
					capabilities: (
						["process.isolation", "process.launch", "process.signal"] as const
					).filter((item) => item !== missing),
				},
				launch,
			};
			const startTransport = vi.fn(async () => {});
			await expect(
				ApplicationRuntime.start({
					piExecutable: "/unused/pi",
					executionMode: "isolated",
					processProvider: provider,
					transports: [transport("test", startTransport, async () => {})],
				}),
			).rejects.toMatchObject({
				code: "ISOLATION_UNAVAILABLE",
				message: "Isolated execution is unavailable",
			});
			expect(openStore).not.toHaveBeenCalled();
			expect(startTransport).not.toHaveBeenCalled();
			expect(launch).not.toHaveBeenCalled();
		},
	);

	it("rejects custom harnesses in isolated mode before any startup side effects", async () => {
		const openStore = vi.spyOn(SqliteSessionStore, "open");
		const processLaunch = vi.fn(async () => {
			throw new Error("must not launch process");
		});
		const provider: ProcessProvider = {
			descriptor: {
				id: "capable-process" as never,
				capabilities: ["process.isolation", "process.launch", "process.signal"],
			},
			launch: processLaunch,
		};
		const harnessLaunch = vi.fn(async () => {
			throw new Error("must not launch harness");
		});
		const harness: HarnessAdapter = {
			descriptor: {
				id: "custom-harness" as never,
				capabilities: ["harness.launch"],
			},
			launch: harnessLaunch,
		};
		const transportStart = vi.fn(async () => {});
		await expect(
			ApplicationRuntime.start({
				piExecutable: "/unused/pi",
				executionMode: "isolated",
				processProvider: provider,
				harnesses: [harness],
				transports: [transport("test", transportStart, async () => {})],
			}),
		).rejects.toMatchObject({
			code: "ISOLATION_UNAVAILABLE",
			message: "Isolated execution is unavailable",
		});
		expect(openStore).not.toHaveBeenCalled();
		expect(transportStart).not.toHaveBeenCalled();
		expect(harnessLaunch).not.toHaveBeenCalled();
		expect(processLaunch).not.toHaveBeenCalled();
	});

	it("fails isolated preflight without an injected provider before side effects", async () => {
		const openStore = vi.spyOn(SqliteSessionStore, "open");
		const startTransport = vi.fn(async () => {});
		await expect(
			ApplicationRuntime.start({
				piExecutable: "/unused/pi",
				executionMode: "isolated",
				transports: [transport("test", startTransport, async () => {})],
			}),
		).rejects.toMatchObject({ code: "ISOLATION_UNAVAILABLE" });
		expect(openStore).not.toHaveBeenCalled();
		expect(startTransport).not.toHaveBeenCalled();
	});

	it("rejects an invalid mode without runtime side effects", async () => {
		const startTransport = vi.fn(async () => {});
		await expect(
			ApplicationRuntime.start({
				piExecutable: "/unused/pi",
				executionMode: "unsafe" as never,
				transports: [transport("test", startTransport, async () => {})],
			}),
		).rejects.toMatchObject({
			code: "INVALID_EXECUTION_MODE",
			message: "Execution mode is invalid",
		});
		expect(startTransport).not.toHaveBeenCalled();
	});

	it("returns correlated typed results and rejects dispatch once closing starts", async () => {
		let dispatch!: RuntimeDispatch;
		const sent: string[] = [];
		const journal = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness: HarnessAdapter = {
			descriptor: {
				id: "mock" as never,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.resume",
					"harness.session.status",
					"harness.model.list",
					"harness.model.set",
					"harness.effort.list",
					"harness.effort.set",
					"input.submit",
				],
			},
			async launch() {
				return {
					processId: "proc" as never,
					exit: new Promise(() => {}),
					nativeSessionId: "native-session",
					events: (async function* () {})(),
					control: {
						async getSelection() {
							return {
								model: { provider: "openai", id: "gpt-test", name: "Test" },
								effort: "medium",
							};
						},
						async getStatus() {
							return {
								model: { provider: "openai", id: "gpt-test", name: "Test" },
								effort: "medium",
								usage: { totalTokens: 321, costUsd: 0.125 },
							};
						},
						async listModels() {
							return [{ provider: "openai", id: "gpt-test", name: "Test" }];
						},
						async listEfforts() {
							return ["low", "medium", "high"];
						},
						async setModel(provider, modelId) {
							return { provider, id: modelId, name: modelId };
						},
						async setEffort() {
							throw new PiControlError("EFFORT_NOT_SUPPORTED", {
								cause: new Error("sensitive provider response"),
							});
						},
					},
					async send(input) {
						if (input.text === "uncertain private prompt")
							throw new UncertainInputDeliveryError(input.id);
						if (input.text === "resumed rejected prompt")
							throw new Error("delivery rejected after resume");
						if (input.text === "sensitive failure")
							throw Object.assign(
								new Error(
									"private detail; Authorization: Bearer abc123-private",
								),
								{
									code: "SECRET_PRIVATE_DETAIL",
									name: "SECRET_NAME_MARKER",
								},
							);
						sent.push(input.text);
					},
					async cancel() {},
					async shutdown() {},
				};
			},
			async resume(request) {
				return {
					processId: "resumed-proc" as never,
					exit: new Promise(() => {}),
					nativeSessionId: request.nativeSessionId,
					events: (async function* () {})(),
					async send(input) {
						if (input.text === "resumed rejected prompt")
							throw new Error("delivery rejected after resume");
					},
					async cancel() {},
					async shutdown() {},
				};
			},
		};
		const service = await ApplicationRuntime.start({
			piExecutable: "/unused/pi",
			harnesses: [harness],
			stateDirectory: await state(),
			transports: [
				transport(
					"test",
					async (value) => {
						dispatch = value;
					},
					async () => {},
				),
			],
		});
		const result = await dispatch({
			requestId: "request-1",
			principalId: "operator",
			kind: "list",
		});
		expect(result).toEqual({ requestId: "request-1", ok: true, value: [] });
		const invalid = await dispatch({
			requestId: "request-invalid",
			principalId: "operator",
			kind: "create",
			harnessId: harness.descriptor.id,
			cwd: "/path/that/does/not/exist",
		});
		expect(invalid).toMatchObject({
			ok: false,
			error: {
				code: "INVALID_WORKING_DIRECTORY",
				message: expect.stringContaining(
					"Working directory is invalid or inaccessible\n\nError:",
				),
			},
		});
		const created = await dispatch({
			requestId: "request-create",
			principalId: "operator",
			kind: "create",
			harnessId: harness.descriptor.id,
			cwd: os.tmpdir(),
		});
		expect(created).toMatchObject({ requestId: "request-create", ok: true });
		if (
			!created.ok ||
			created.value === undefined ||
			typeof created.value !== "object" ||
			!("id" in created.value)
		)
			throw new Error("create result missing session");
		const inspected = await dispatch({
			requestId: "request-inspect",
			principalId: "operator",
			kind: "inspect",
			sessionId: created.value.id,
		});
		expect(inspected).toEqual({
			requestId: "request-inspect",
			ok: true,
			value: created.value,
		});
		const liveStatus = await dispatch({
			requestId: "request-status",
			principalId: "operator",
			kind: "session_status",
			sessionId: created.value.id,
		});
		expect(liveStatus).toMatchObject({
			ok: true,
			value: {
				session: { id: created.value.id },
				live: {
					model: { provider: "openai", id: "gpt-test" },
					effort: "medium",
					usage: { totalTokens: 321, costUsd: 0.125 },
				},
			},
		});
		const models = await dispatch({
			requestId: "request-model-list",
			principalId: "operator",
			kind: "model_list",
			sessionId: created.value.id,
		});
		expect(models).toMatchObject({
			ok: true,
			value: {
				current: { provider: "openai", id: "gpt-test" },
				models: [{ provider: "openai", id: "gpt-test" }],
			},
		});
		const modelChange = await dispatch({
			requestId: "request-model-set",
			principalId: "operator",
			kind: "model_set",
			sessionId: created.value.id,
			provider: "openai",
			modelId: "gpt-next",
			effort: "high",
		});
		expect(modelChange).toMatchObject({
			ok: true,
			value: {
				model: { id: "gpt-next" },
				effort: "high",
				effortConfirmed: false,
			},
		});
		const effortLevels = await dispatch({
			requestId: "request-effort-list",
			principalId: "operator",
			kind: "effort_list",
			sessionId: created.value.id,
		});
		expect(effortLevels).toMatchObject({
			ok: true,
			value: { current: "medium", levels: ["low", "medium", "high"] },
		});
		const effortFailure = await dispatch({
			requestId: "request-effort-set",
			principalId: "operator",
			kind: "effort_set",
			sessionId: created.value.id,
			effort: "xhigh",
		});
		expect(effortFailure).toMatchObject({
			ok: false,
			error: {
				code: "EFFORT_NOT_SUPPORTED",
				message: expect.stringContaining(
					"Effort is not supported by this model; use /effort to see valid levels.\n\nError:",
				),
			},
		});
		expect(JSON.stringify(effortFailure)).not.toContain(
			"sensitive provider response",
		);
		expect(journal).toHaveBeenCalledWith(
			"harnessd: Pi control failed (EFFORT_NOT_SUPPORTED)",
		);
		expect(journal.mock.calls.flat().join(" ")).not.toContain(
			"sensitive provider response",
		);
		const input = await dispatch({
			requestId: "request-submit",
			principalId: "operator",
			kind: "submit",
			sessionId: created.value.id,
			text: "hello",
		});
		expect(input).toMatchObject({
			requestId: "request-submit",
			ok: true,
			resumed: false,
		});
		if (!input.ok || typeof input.value !== "string")
			throw new Error("submit result missing input ID");
		expect(sent).toEqual(["hello"]);
		const safeFailure = await dispatch({
			requestId: "deadbeef-cafe-4000-8000-000000000000",
			principalId: "operator",
			kind: "submit",
			sessionId: created.value.id,
			text: "sensitive failure",
		});
		expect(safeFailure).toMatchObject({
			requestId: "deadbeef-cafe-4000-8000-000000000000",
			ok: false,
			error: {
				code: "OPERATION_FAILED",
				message: expect.stringContaining(
					"Operation failed (ref deadbeef)\n\nError:",
				),
			},
		});
		expect(JSON.stringify(safeFailure)).toContain("private detail");
		expect(JSON.stringify(safeFailure)).not.toContain("abc123-private");
		expect(JSON.stringify(safeFailure)).not.toContain("Bearer");
		const diagnostic = journal.mock.calls.flat().join(" ");
		expect(diagnostic).toContain('"reference":"deadbeef"');
		expect(diagnostic).toContain('"kind":"submit"');
		expect(diagnostic).toContain('"errorType":"Error"');
		expect(diagnostic).toMatch(/"origin":"[^"]+\.ts:\d+"/);
		expect(diagnostic).toContain("private detail");
		expect(diagnostic).not.toContain("SECRET_PRIVATE_DETAIL");
		expect(diagnostic).not.toContain("SECRET_NAME_MARKER");
		expect(diagnostic).not.toContain("abc123-private");
		expect(diagnostic).not.toContain("Bearer");
		expect(diagnostic).not.toContain("sensitive failure");
		const uncertain = await dispatch({
			requestId: "request-uncertain",
			principalId: "operator",
			kind: "submit",
			sessionId: created.value.id,
			text: "uncertain private prompt",
		});
		expect(uncertain).toMatchObject({
			requestId: "request-uncertain",
			ok: false,
			error: {
				code: "UNCERTAIN_INPUT_DELIVERY",
				message: expect.stringContaining(
					"Input delivery is uncertain\n\nError:",
				),
			},
		});
		if (uncertain.ok) throw new Error("Expected uncertain input result");
		expect(uncertain.error.inputId).toBeTruthy();
		expect(JSON.stringify(uncertain)).not.toContain("uncertain private prompt");
		const cancel = await dispatch({
			requestId: "request-cancel",
			principalId: "operator",
			kind: "cancel",
			sessionId: created.value.id,
			inputId: input.value as never,
		});
		expect(cancel).toMatchObject({
			requestId: "request-cancel",
			ok: false,
			error: { code: "UNSUPPORTED_CAPABILITY" },
		});
		const cancelCurrent = await dispatch({
			requestId: "request-cancel-current",
			principalId: "operator",
			kind: "cancel_current",
			sessionId: created.value.id,
		});
		expect(cancelCurrent).toMatchObject({
			requestId: "request-cancel-current",
			ok: false,
			error: { code: "UNSUPPORTED_CAPABILITY" },
		});
		const stopped = await dispatch({
			requestId: "request-stop",
			principalId: "operator",
			kind: "stop",
			sessionId: created.value.id,
		});
		expect(stopped).toEqual({
			requestId: "request-stop",
			ok: true,
			value: undefined,
		});
		const inspectedStopped = await dispatch({
			requestId: "request-inspect-stopped",
			principalId: "operator",
			kind: "inspect",
			sessionId: created.value.id,
		});
		expect(inspectedStopped).toMatchObject({
			requestId: "request-inspect-stopped",
			ok: true,
			value: { id: created.value.id, status: "stopped" },
		});
		const rejectedAfterResume = await dispatch({
			requestId: "request-submit-resume-reject",
			principalId: "operator",
			kind: "submit",
			sessionId: created.value.id,
			text: "resumed rejected prompt",
		});
		expect(rejectedAfterResume).toMatchObject({
			requestId: "request-submit-resume-reject",
			ok: false,
			error: { code: "OPERATION_FAILED", resumed: true },
		});
		const closing = service.close();
		expect(
			await dispatch({
				requestId: "request-2",
				principalId: "operator",
				kind: "list",
			}),
		).toMatchObject({
			requestId: "request-2",
			ok: false,
			error: { code: "RUNTIME_CLOSING" },
		});
		await closing;
		await service.close();
	});

	it("routes results and session events across two transports, then closes in order", async () => {
		const store = await SqliteSessionStore.open(await state());
		const closeStore = store.close.bind(store);
		const order: string[] = [];
		vi.spyOn(store, "close").mockImplementation(() => {
			order.push("store");
			closeStore();
		});
		const gates = new Map<SessionId, ReturnType<typeof deferred<void>>>();
		const submitted: { sessionId: SessionId; inputId: InputId }[] = [];
		const cancelled: { sessionId: SessionId; inputId: InputId }[] = [];
		const harness: HarnessAdapter = {
			descriptor: {
				id: "shared-harness" as never,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.cancel",
					"input.submit",
				],
			},
			async launch(request) {
				const gate = deferred<void>();
				gates.set(request.sessionId, gate);
				return {
					processId: `process-${request.sessionId}` as never,
					exit: new Promise(() => {}),
					events: (async function* () {
						await gate.promise;
						yield {
							sessionId: "spoofed" as SessionId,
							kind: "output",
							text: `${request.sessionId}:output`,
						};
						yield {
							sessionId: "spoofed" as SessionId,
							kind: "input",
							inputEvent: {
								inputId: `uncertain-${request.sessionId}` as InputId,
								state: "uncertain",
							},
						};
					})(),
					async send(input) {
						submitted.push({ sessionId: input.sessionId, inputId: input.id });
					},
					async cancel(inputId) {
						cancelled.push({ sessionId: request.sessionId, inputId });
					},
					async shutdown() {
						order.push(`shutdown:${request.sessionId}`);
						gate.resolve(undefined);
					},
				};
			},
		};
		let dispatchA: RuntimeDispatch | undefined;
		let dispatchB: RuntimeDispatch | undefined;
		let unsubscribeA: () => void = () => {};
		let unsubscribeB: () => void = () => {};
		const ownedA = new Set<SessionId>();
		const ownedB = new Set<SessionId>();
		const eventsA: HarnessEvent[] = [];
		const eventsB: HarnessEvent[] = [];
		const eventsAReady = deferred<void>();
		const eventsBReady = deferred<void>();
		const transportA = transport(
			"transport-a",
			async (dispatch, subscribeEvents) => {
				order.push("start:a");
				dispatchA = dispatch;
				unsubscribeA = subscribeEvents(async (event) => {
					if (ownedA.has(event.sessionId)) {
						eventsA.push(event);
						if (eventsA.length === 2) eventsAReady.resolve(undefined);
					}
					throw new Error("private transport observer failure");
				});
			},
			async () => {
				order.push("stop:a");
				unsubscribeA();
			},
		);
		const transportB = transport(
			"transport-b",
			async (dispatch, subscribeEvents) => {
				order.push("start:b");
				dispatchB = dispatch;
				unsubscribeB = subscribeEvents((event) => {
					if (ownedB.has(event.sessionId)) {
						eventsB.push(event);
						if (eventsB.length === 2) eventsBReady.resolve(undefined);
					}
				});
			},
			async () => {
				order.push("stop:b");
				unsubscribeB();
			},
		);
		const runtime = await ApplicationRuntime.start({
			piExecutable: "/unused/pi",
			harnesses: [harness],
			store,
			transports: [transportA, transportB],
		});
		if (!dispatchA || !dispatchB) throw new Error("transports did not start");
		const sessionA = sessionFrom(
			await dispatchA({
				requestId: "create-a",
				principalId: "principal-a",
				kind: "create",
				harnessId: harness.descriptor.id,
				cwd: os.tmpdir(),
			}),
		);
		const sessionB = sessionFrom(
			await dispatchB({
				requestId: "create-b",
				principalId: "principal-b",
				kind: "create",
				harnessId: harness.descriptor.id,
				cwd: os.tmpdir(),
			}),
		);
		ownedA.add(sessionA.id);
		ownedB.add(sessionB.id);
		const inputA = inputIdFrom(
			await dispatchA({
				requestId: "submit-a",
				principalId: "principal-a",
				kind: "submit",
				sessionId: sessionA.id,
				text: "input a",
			}),
		);
		const inputB = inputIdFrom(
			await dispatchB({
				requestId: "submit-b",
				principalId: "principal-b",
				kind: "submit",
				sessionId: sessionB.id,
				text: "input b",
			}),
		);
		await dispatchA({
			requestId: "cancel-a",
			principalId: "principal-a",
			kind: "cancel",
			sessionId: sessionA.id,
			inputId: inputA,
		});
		await dispatchB({
			requestId: "cancel-b",
			principalId: "principal-b",
			kind: "cancel",
			sessionId: sessionB.id,
			inputId: inputB,
		});
		expect(submitted).toEqual([
			{ sessionId: sessionA.id, inputId: inputA },
			{ sessionId: sessionB.id, inputId: inputB },
		]);
		expect(cancelled).toEqual([
			{ sessionId: sessionA.id, inputId: inputA },
			{ sessionId: sessionB.id, inputId: inputB },
		]);
		gates.get(sessionA.id)?.resolve(undefined);
		gates.get(sessionB.id)?.resolve(undefined);
		await Promise.all([eventsAReady.promise, eventsBReady.promise]);
		expect(eventsA.map((event) => event.sessionId)).toEqual([
			sessionA.id,
			sessionA.id,
		]);
		expect(eventsB.map((event) => event.sessionId)).toEqual([
			sessionB.id,
			sessionB.id,
		]);
		expect(eventsA[0]).toMatchObject({
			kind: "output",
			text: `${sessionA.id}:output`,
		});
		expect(eventsA[1]?.inputEvent).toEqual({
			inputId: `uncertain-${sessionA.id}`,
			state: "uncertain",
		});
		expect(eventsB[0]).toMatchObject({
			kind: "output",
			text: `${sessionB.id}:output`,
		});
		expect(eventsB[1]?.inputEvent).toEqual({
			inputId: `uncertain-${sessionB.id}`,
			state: "uncertain",
		});
		await Promise.all([runtime.close(), runtime.close()]);
		expect(order).toEqual([
			"start:a",
			"start:b",
			"stop:b",
			"stop:a",
			`shutdown:${sessionA.id}`,
			`shutdown:${sessionB.id}`,
			"store",
		]);
	});

	it("rolls back started transports and closes SQLite when startup fails", async () => {
		const store = await SqliteSessionStore.open(await state());
		const close = vi.spyOn(store, "close");
		const stopped: string[] = [];
		const transports = [
			transport(
				"started",
				async () => {},
				async () => {
					stopped.push("started");
				},
			),
			transport(
				"failed",
				async () => {
					throw new Error("sensitive startup detail");
				},
				async () => {
					stopped.push("failed");
				},
			),
		];
		await expect(
			ApplicationRuntime.start({
				piExecutable: "/unused/pi",
				transports,
				store,
			}),
		).rejects.toThrow("sensitive startup detail");
		expect(stopped).toEqual(["failed", "started"]);
		expect(close).toHaveBeenCalledOnce();
	});
});
