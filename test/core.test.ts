import {
	chmod,
	mkdtemp,
	readdir,
	readlink,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AdapterId,
	HarnessAdapter,
	HarnessEvent,
	HarnessInstance,
	InputId,
	SessionId,
	SessionPort,
	TransportAdapter,
	TransportEvent,
} from "../src/core/index.js";
import {
	DuplicateAdapterIdError,
	HarnessRegistry,
	InvalidSessionNameError,
	InvalidStateDirectoryError,
	InvalidWorkingDirectoryError,
	mergeAdapterOptions,
	requireCapability,
	resolveStateDirectory,
	SessionManager,
	SessionNotFoundError,
	SessionNotResumableError,
	SessionNotStoppedError,
	SessionStoreError,
	SqliteSessionStore,
	UnsupportedCapabilityError,
} from "../src/core/index.js";
import { validateStateDirectoryPath } from "../src/core/session-store.js";

const tempDirectories: string[] = [];
async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "harnessd-test-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

const mockSessionPort: SessionPort = {
	descriptor: { id: "memory" as never, capabilities: ["session.list"] },
	async list() {
		return [];
	},
	async get() {
		return undefined;
	},
	async create() {
		throw new UnsupportedCapabilityError("session.create", "memory");
	},
	async rename() {
		throw new UnsupportedCapabilityError("session.rename", "memory");
	},
	async stop() {
		throw new UnsupportedCapabilityError("session.stop", "memory");
	},
	async resume() {
		throw new UnsupportedCapabilityError("session.resume", "memory");
	},
};
const mockTransport: TransportAdapter = {
	descriptor: {
		id: "mock-transport" as never,
		capabilities: ["transport.poll"],
	},
	async start() {},
	async stop() {},
};
const mockHarness: HarnessAdapter = {
	descriptor: { id: "mock-harness" as never, capabilities: ["input.submit"] },
	async launch() {
		throw new Error("not needed in adapter-independence test");
	},
};
void mockSessionPort;
void mockTransport;
void mockHarness;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function harnessPort(
	options: {
		launch?: HarnessAdapter["launch"];
		capabilities?: HarnessAdapter["descriptor"]["capabilities"];
	} = {},
) {
	const launched: { cwd: string; id: SessionId }[] = [];
	const submitted: string[] = [];
	const harness: HarnessAdapter = {
		descriptor: {
			id: "mock-harness" as AdapterId,
			capabilities: options.capabilities ?? [
				"harness.launch",
				"harness.stop",
				"input.submit",
			],
		},
		async launch(request) {
			launched.push({ cwd: request.cwd, id: request.sessionId });
			if (options.launch) return options.launch(request);
			const instance: HarnessInstance = {
				processId: "process" as never,
				exit: new Promise(() => {}),
				nativeSessionId: "native-1",
				events: (async function* () {})(),
				async send(input) {
					submitted.push(input.text);
				},
				async cancel() {},
				async shutdown() {},
			};
			return instance;
		},
	};
	return { harness, launched, submitted };
}

describe("core capability contracts", () => {
	it("routes dynamic inventory and command dispatch through the selected live instance", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const calls: unknown[][] = [];
		const harness = harnessPort({
			capabilities: [
				"harness.launch",
				"harness.stop",
				"harness.commands.list",
				"harness.commands.run",
			],
			launch: async () => ({
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
						return "accepted";
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
			}),
		});
		const manager = new SessionManager(store, [harness.harness]);
		try {
			const session = await manager.create({
				harnessId: harness.harness.descriptor.id,
				cwd: os.homedir(),
			});
			expect(await manager.listCommands(session.id)).toEqual([
				{ name: "cost", description: "Cost" },
			]);
			expect(await manager.runCommand(session.id, "cost", "  raw ")).toBe(
				"accepted",
			);
			expect(calls).toEqual([["list"], ["run", "cost", "  raw "]]);
		} finally {
			await manager.close();
			store.close();
		}
	});

	it("uses required fields for each transport event kind", () => {
		const events: TransportEvent[] = [
			{ requestId: "1", principalId: "operator", kind: "list" },
			{
				requestId: "2",
				principalId: "operator",
				kind: "inspect",
				sessionId: "session" as never,
			},
			{
				requestId: "3",
				principalId: "operator",
				kind: "create",
				harnessId: "mock" as never,
				cwd: "/workspace",
			},
			{
				requestId: "4",
				principalId: "operator",
				kind: "stop",
				sessionId: "session" as never,
			},
			{
				requestId: "5",
				principalId: "operator",
				kind: "delete",
				sessionId: "session" as never,
			},
			{
				requestId: "resume",
				principalId: "operator",
				kind: "resume",
				sessionId: "session" as never,
			},
			{
				requestId: "6",
				principalId: "operator",
				kind: "submit",
				sessionId: "session" as never,
				text: "hello",
			},
			{
				requestId: "7",
				principalId: "operator",
				kind: "cancel",
				sessionId: "session" as never,
				inputId: "input" as never,
			},
		];
		expect(events.map((event) => event.kind)).toEqual([
			"list",
			"inspect",
			"create",
			"stop",
			"delete",
			"resume",
			"submit",
			"cancel",
		]);
	});

	it("throws explicit unsupported-capability errors", async () => {
		await expect(
			mockSessionPort.stop("session" as never),
		).rejects.toBeInstanceOf(UnsupportedCapabilityError);
		await expect(
			mockSessionPort.resume("session" as never),
		).rejects.toBeInstanceOf(UnsupportedCapabilityError);
		expect(() =>
			requireCapability(["session.list"], "session.resume", "mock"),
		).toThrow(UnsupportedCapabilityError);
		expect(() =>
			requireCapability(["session.list"], "session.list", "mock"),
		).not.toThrow();
		expect(() =>
			requireCapability(["session.list"], "session.create", "mock"),
		).toThrow(UnsupportedCapabilityError);
	});

	it("rejects duplicate harness adapter IDs during registration", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const first = harnessPort().harness;
		const second = harnessPort().harness;
		expect(() => new SessionManager(store, [first, second])).toThrow(
			DuplicateAdapterIdError,
		);
		store.close();
	});

	it("validates aliases, projects capabilities, and resolves inherited adapter options", async () => {
		const state = await temporaryDirectory();
		const workspace = await temporaryDirectory();
		const store = await SqliteSessionStore.open(state);
		const original = harnessPort().harness;
		let launchOptions: unknown;
		const harness: HarnessAdapter = {
			...original,
			descriptor: { ...original.descriptor, aliases: ["mock"] },
			async launch(request) {
				launchOptions = request.adapterOptions;
				return original.launch(request);
			},
		};
		const registry = new HarnessRegistry([harness]);
		expect(registry.resolve("mock")).toBe("mock-harness");
		expect(registry.project(["harness.launch"])).toHaveLength(1);
		expect(
			() =>
				new HarnessRegistry([
					{
						...harness,
						descriptor: { ...harness.descriptor, aliases: ["bad alias"] },
					},
				]),
		).toThrow(/alias/);
		expect(
			() =>
				new HarnessRegistry([
					harness,
					{
						...harness,
						descriptor: { ...harness.descriptor, id: "other" as never },
					},
				]),
		).toThrow(/alias/);
		const manager = new SessionManager(store, [harness], {
			defaultHarnessId: "mock",
			adapterOptions: { effort: "high", shared: true },
		});
		try {
			const session = await manager.create({
				cwd: workspace,
				adapterOptions: { shared: false },
			});
			expect(session.harnessId).toBe("mock-harness");
			expect(session.adapterOptions).toEqual({ shared: false });
			expect(launchOptions).toEqual({ effort: "high", shared: false });
			await store.update({ ...session, harnessId: "other" as never });
			expect((await store.get(session.id))?.harnessId).toBe("mock-harness");
		} finally {
			await manager.close();
		}
		store.close();
		const reopened = await SqliteSessionStore.open(state);
		expect(await reopened.list()).toMatchObject([
			{ harnessId: "mock-harness", adapterOptions: { shared: false } },
		]);
		reopened.close();
		expect(mergeAdapterOptions({ effort: "low" }, { effort: "high" })).toEqual({
			effort: "high",
		});
		expect(
			mergeAdapterOptions(
				{ effort: "low", model: "sonnet" },
				{ effort: "default", permission: "manual" },
			),
		).toEqual({ effort: "low", model: "sonnet", permission: "manual" });
		expect(
			mergeAdapterOptions(undefined, { effort: "default" }),
		).toBeUndefined();
	});
});

describe("SQLite session management", () => {
	it("persists session metadata in its configured supervisor directory across reopen", async () => {
		const state = await temporaryDirectory();
		const workspace = await temporaryDirectory();
		const store = await SqliteSessionStore.open(state);
		const { harness } = harnessPort();
		const manager = new SessionManager(store, [harness]);
		const session = await manager.create({
			id: "session-1",
			harnessId: harness.descriptor.id,
			cwd: workspace,
			name: "MCP migration",
		});
		expect(session).toMatchObject({
			id: "session-1",
			name: "MCP migration",
			cwd: await import("node:fs/promises").then(({ realpath }) =>
				realpath(workspace),
			),
			status: "running",
			nativeSessionId: "native-1",
		});
		store.close();
		const reopened = await SqliteSessionStore.open(state);
		expect(await reopened.get(session.id)).toEqual(session);
		expect(reopened.stateDirectory).toBe(state);
		expect(reopened.databasePath.startsWith(workspace)).toBe(false);
		reopened.close();
	});

	it("migrates an existing SQLite database by adding nullable session names and options", async () => {
		const state = await temporaryDirectory();
		const database = new Database(path.join(state, "sessions.sqlite3"));
		database.exec(`CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			harness_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			native_session_id TEXT,
			status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopped', 'failed', 'uncertain')),
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		database
			.prepare(
				"INSERT INTO sessions (id, harness_id, cwd, status) VALUES (?, ?, ?, ?)",
			)
			.run("legacy-session", "pi-rpc", "/workspace", "stopped");
		database.close();

		const store = await SqliteSessionStore.open(state);
		expect(await store.get("legacy-session" as SessionId)).toMatchObject({
			id: "legacy-session",
			cwd: "/workspace",
			status: "stopped",
		});
		expect(await store.get("legacy-session" as SessionId)).not.toHaveProperty(
			"name",
		);
		expect(await store.get("legacy-session" as SessionId)).not.toHaveProperty(
			"adapterOptions",
		);
		await store.setName("legacy-session" as SessionId, "Recovered session");
		expect(await store.get("legacy-session" as SessionId)).toMatchObject({
			name: "Recovered session",
		});
		store.close();
	});

	it("persists, renames, and clears shared session labels without launching Pi again", async () => {
		const state = await temporaryDirectory();
		const workspace = await temporaryDirectory();
		const store = await SqliteSessionStore.open(state);
		const { harness, launched } = harnessPort();
		const manager = new SessionManager(store, [harness]);
		const first = await manager.create({
			harnessId: harness.descriptor.id,
			cwd: workspace,
			name: "MCP migration",
		});
		const second = await manager.create({
			harnessId: harness.descriptor.id,
			cwd: workspace,
			name: "MCP migration",
		});
		expect(first.id).not.toBe(second.id);
		expect((await manager.list()).map((item) => item.name)).toEqual([
			"MCP migration",
			"MCP migration",
		]);
		await expect(
			manager.rename(first.id, "Renamed session"),
		).resolves.toMatchObject({
			name: "Renamed session",
		});
		await expect(manager.rename(first.id)).resolves.not.toHaveProperty("name");
		await expect(manager.rename(first.id, "bad\nname")).rejects.toBeInstanceOf(
			InvalidSessionNameError,
		);
		await expect(
			manager.rename(first.id, "x".repeat(65)),
		).rejects.toBeInstanceOf(InvalidSessionNameError);
		await expect(
			manager.create({
				harnessId: harness.descriptor.id,
				cwd: workspace,
				name: "bad\nname",
			}),
		).rejects.toBeInstanceOf(InvalidSessionNameError);
		expect(launched).toHaveLength(2);
		const reopened = await SqliteSessionStore.open(state);
		expect(await reopened.get(first.id)).not.toHaveProperty("name");
		reopened.close();
		await manager.close();
		store.close();
	});

	it("deletes only stopped session metadata and leaves its workspace intact", async () => {
		const state = await temporaryDirectory();
		const workspace = await temporaryDirectory();
		const store = await SqliteSessionStore.open(state);
		const { harness } = harnessPort();
		const manager = new SessionManager(store, [harness]);
		await expect(manager.delete("missing" as SessionId)).rejects.toBeInstanceOf(
			SessionNotFoundError,
		);
		const session = await manager.create({
			harnessId: harness.descriptor.id,
			cwd: workspace,
		});

		await expect(manager.delete(session.id)).rejects.toBeInstanceOf(
			SessionNotStoppedError,
		);
		expect(await store.get(session.id)).toEqual(session);

		await manager.stop(session.id);
		await manager.delete(session.id);
		expect(await store.get(session.id)).toBeUndefined();
		expect(await store.list()).toEqual([]);
		const { stat } = await import("node:fs/promises");
		expect((await stat(workspace)).isDirectory()).toBe(true);
		await manager.close();
		store.close();
	});

	it("resets terminal lifecycle state when a stopped ID is deleted and reused", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const firstExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		const secondExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		let launches = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "reusable-harness" as AdapterId,
				capabilities: ["harness.launch", "harness.stop"],
			},
			async launch(request) {
				const exit = launches++ === 0 ? firstExit.promise : secondExit.promise;
				return {
					processId: `process-${request.sessionId}` as never,
					exit,
					events: (async function* () {})(),
					async send() {},
					async cancel() {},
					async shutdown() {},
				};
			},
		};
		const manager = new SessionManager(store, [harness]);
		const session = await manager.create({
			id: "reusable-session",
			harnessId: harness.descriptor.id,
			cwd: os.tmpdir(),
		});
		await manager.stop(session.id);
		await manager.delete(session.id);
		await manager.create({
			id: session.id,
			harnessId: harness.descriptor.id,
			cwd: os.tmpdir(),
		});

		secondExit.resolve({ code: 1, signal: null });
		await vi.waitFor(async () => {
			expect((await store.get(session.id))?.status).toBe("failed");
		});
		await manager.close();
		store.close();
	});

	it("preserves the resume-attempt budget across deletion and same-ID reuse", async () => {
		vi.useFakeTimers();
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const firstExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		const secondExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		let launches = 0;
		let resumes = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "budget-harness" as AdapterId,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch(request) {
				const exit = launches++ === 0 ? firstExit.promise : secondExit.promise;
				return {
					processId: `budget-process-${request.sessionId}` as never,
					exit,
					nativeSessionId: "native-session",
					events: (async function* () {})(),
					async send() {},
					async cancel() {},
					async shutdown() {},
				};
			},
			async resume() {
				resumes++;
				throw new Error("resume failure");
			},
		};
		const manager = new SessionManager(store, [harness]);
		try {
			const session = await manager.create({
				id: "budget-session",
				harnessId: harness.descriptor.id,
				cwd: os.tmpdir(),
			});
			firstExit.resolve({ code: 1, signal: null });
			await vi.advanceTimersByTimeAsync(250);
			expect(resumes).toBe(1);
			await manager.stop(session.id);
			await manager.delete(session.id);
			await manager.create({
				id: session.id,
				harnessId: harness.descriptor.id,
				cwd: os.tmpdir(),
			});

			secondExit.resolve({ code: 1, signal: null });
			await vi.advanceTimersByTimeAsync(1000);
			expect(resumes).toBe(2);
			await vi.advanceTimersByTimeAsync(4000);
			expect(resumes).toBe(3);
			await vi.waitFor(async () => {
				expect((await store.get(session.id))?.status).toBe("failed");
			});
		} finally {
			await manager.close();
			store.close();
		}
	});

	it("addresses submit and stop to the selected session and returns persisted status", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const { harness, submitted } = harnessPort();
		const manager = new SessionManager(store, [harness]);
		const session = await manager.create({
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		const inputId = await manager.submit(session.id, "addressed input");
		expect(inputId).toMatch(/^[0-9a-f-]{36}$/i);
		expect(submitted).toEqual(["addressed input"]);
		await manager.stop(session.id);
		expect((await manager.get(session.id)).status).toBe("stopped");
		store.close();
	});

	it("resumes the saved native session before delivering a stopped-session submit once", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const launchRequests: { sessionId: SessionId; cwd: string }[] = [];
		const resumeRequests: {
			sessionId: SessionId;
			cwd: string;
			nativeSessionId?: string;
		}[] = [];
		const submitted: string[] = [];
		let failResumedDelivery = false;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "resume-harness" as AdapterId,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.resume",
					"input.submit",
				],
			},
			async launch(request) {
				launchRequests.push(request);
				return {
					processId: "initial-process" as never,
					exit: new Promise(() => {}),
					nativeSessionId: "native-session-1",
					events: (async function* () {})(),
					async send(input) {
						submitted.push(input.text);
					},
					async cancel() {},
					async shutdown() {},
				};
			},
			async resume(request) {
				resumeRequests.push(request);
				return {
					processId: "resumed-process" as never,
					exit: new Promise(() => {}),
					nativeSessionId: "native-session-1",
					events: (async function* () {})(),
					async send(input) {
						if (failResumedDelivery)
							throw new Error("prompt delivery rejected");
						submitted.push(input.text);
					},
					async cancel() {},
					async shutdown() {},
				};
			},
		};
		const manager = new SessionManager(store, [harness]);
		try {
			const session = await manager.create({
				harnessId: harness.descriptor.id,
				cwd: os.tmpdir(),
			});
			await manager.stop(session.id);
			const outcome = await manager.submitWithOutcome(session.id, "new prompt");
			const inputId = outcome.inputId;
			expect(inputId).toMatch(/^[0-9a-f-]{36}$/i);
			expect(outcome.resumed).toBe(true);
			expect(launchRequests).toHaveLength(1);
			expect(resumeRequests).toEqual([
				{
					sessionId: session.id,
					cwd: session.cwd,
					nativeSessionId: "native-session-1",
				},
			]);
			expect(submitted).toEqual(["new prompt"]);
			expect((await manager.get(session.id)).status).toBe("running");
			await manager.stop(session.id);
			failResumedDelivery = true;
			let resumedSignal = false;
			await expect(
				manager.submitWithOutcome(
					session.id,
					"rejected prompt",
					undefined,
					() => {
						resumedSignal = true;
					},
				),
			).rejects.toThrow("prompt delivery rejected");
			expect(resumedSignal).toBe(true);
			expect((await manager.get(session.id)).status).toBe("running");
			await manager.resume(session.id);
			expect(resumeRequests).toHaveLength(2);
		} finally {
			await manager.close();
			store.close();
		}
	});

	it("leaves the session stopped after resume failure without fresh launch or submission", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		let launches = 0;
		let resumes = 0;
		let submits = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "resume-failure-harness" as AdapterId,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.resume",
					"input.submit",
				],
			},
			async launch() {
				launches++;
				return {
					processId: "resume-failure-initial" as never,
					exit: new Promise(() => {}),
					nativeSessionId: "native-resume-failure",
					events: (async function* () {})(),
					async send() {
						submits++;
					},
					async cancel() {},
					async shutdown() {},
				};
			},
			async resume() {
				resumes++;
				throw new Error("private resume detail");
			},
		};
		const manager = new SessionManager(store, [harness]);
		try {
			const session = await manager.create({
				harnessId: harness.descriptor.id,
				cwd: os.tmpdir(),
			});
			await manager.stop(session.id);
			await expect(
				manager.submit(session.id, "must not be delivered"),
			).rejects.toThrow("private resume detail");
			expect(launches).toBe(1);
			expect(resumes).toBe(1);
			expect(submits).toBe(0);
			expect((await manager.get(session.id)).status).toBe("stopped");
		} finally {
			await manager.close();
			store.close();
		}
	});

	it("never fresh-launches or submits when a stopped session lacks its native ID", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		let launches = 0;
		let submits = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "resume-without-native-id" as AdapterId,
				capabilities: ["harness.launch", "harness.stop", "input.submit"],
			},
			async launch() {
				launches++;
				return {
					processId: "without-native-id" as never,
					exit: new Promise(() => {}),
					events: (async function* () {})(),
					async send() {
						submits++;
					},
					async cancel() {},
					async shutdown() {},
				};
			},
		};
		const manager = new SessionManager(store, [harness]);
		try {
			const session = await manager.create({
				harnessId: harness.descriptor.id,
				cwd: os.tmpdir(),
			});
			await manager.stop(session.id);
			await expect(manager.resume(session.id)).rejects.toBeInstanceOf(
				SessionNotResumableError,
			);
			await expect(
				manager.submit(session.id, "must not be delivered"),
			).rejects.toBeInstanceOf(SessionNotResumableError);
			expect(launches).toBe(1);
			expect(submits).toBe(0);
			expect((await manager.get(session.id)).status).toBe("stopped");
		} finally {
			await manager.close();
			store.close();
		}
	});

	it("coalesces concurrent resumes and lets a racing stop prevent input delivery", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const resumeStarted = deferred<void>();
		const resumeGate = deferred<void>();
		let resumeCalls = 0;
		let shutdowns = 0;
		let submits = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "resume-race-harness" as AdapterId,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.resume",
					"input.submit",
				],
			},
			async launch() {
				return {
					processId: "race-initial" as never,
					exit: new Promise(() => {}),
					nativeSessionId: "native-race",
					events: (async function* () {})(),
					async send() {
						submits++;
					},
					async cancel() {},
					async shutdown() {},
				};
			},
			async resume() {
				resumeCalls++;
				resumeStarted.resolve();
				await resumeGate.promise;
				return {
					processId: "race-resumed" as never,
					exit: new Promise(() => {}),
					nativeSessionId: "native-race",
					events: (async function* () {})(),
					async send() {
						submits++;
					},
					async cancel() {},
					async shutdown() {
						shutdowns++;
					},
				};
			},
		};
		const manager = new SessionManager(store, [harness]);
		try {
			const session = await manager.create({
				harnessId: harness.descriptor.id,
				cwd: os.tmpdir(),
			});
			await manager.stop(session.id);
			const resume = manager.resume(session.id);
			const submit = manager.submit(session.id, "must not be delivered");
			await resumeStarted.promise;
			const stop = manager.stop(session.id);
			await new Promise((resolve) => setTimeout(resolve, 0));
			resumeGate.resolve();
			await expect(resume).rejects.toBeInstanceOf(SessionNotResumableError);
			await expect(submit).rejects.toBeInstanceOf(SessionNotResumableError);
			await stop;
			expect(resumeCalls).toBe(1);
			expect(shutdowns).toBe(1);
			expect(submits).toBe(0);
			expect((await manager.get(session.id)).status).toBe("stopped");
		} finally {
			await manager.close();
			store.close();
		}
	});

	it("routes live controls by session and reports partial model changes without persisting them", async () => {
		const state = await temporaryDirectory();
		const calls: string[] = [];
		const harness = harnessPort({
			capabilities: [
				"harness.launch",
				"harness.stop",
				"harness.session.status",
				"harness.model.list",
				"harness.model.set",
				"harness.effort.list",
				"harness.effort.set",
			],
			launch: async (request) => ({
				processId: `control-${request.sessionId}` as never,
				exit: new Promise(() => {}),
				events: (async function* () {})(),
				control: {
					async getSelection() {
						return {
							model: { provider: "openai", id: "gpt-test", name: "Test" },
							effort: "medium",
						};
					},
					async getStatus() {
						calls.push(`status:${request.sessionId}`);
						return {
							model: { provider: "openai", id: "gpt-test", name: "Test" },
							effort: "medium",
							usage: { totalTokens: 123, costUsd: 0.01 },
						};
					},
					async listModels() {
						calls.push(`models:${request.sessionId}`);
						return [{ provider: "openai", id: "gpt-test", name: "Test" }];
					},
					async listEfforts() {
						calls.push(`efforts:${request.sessionId}`);
						return ["low", "medium", "high"];
					},
					async setModel(provider, modelId) {
						calls.push(`model:${request.sessionId}:${provider}/${modelId}`);
						return { provider, id: modelId, name: modelId };
					},
					async setEffort(level) {
						calls.push(`effort:${request.sessionId}:${level}`);
						throw new Error("private Pi detail");
					},
				},
				async send() {},
				async cancel() {},
				async shutdown() {},
			}),
		}).harness;
		const store = await SqliteSessionStore.open(state);
		const manager = new SessionManager(store, [harness]);
		const sessionA = await manager.create({
			id: "control-a",
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		const sessionB = await manager.create({
			id: "control-b",
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		const change = await manager.setModel(
			sessionA.id,
			"openai",
			"gpt-next",
			"high",
		);
		expect(change).toEqual({
			model: { provider: "openai", id: "gpt-next", name: "gpt-next" },
			effort: "high",
			effortConfirmed: false,
		});
		expect(calls).toEqual([
			"model:control-a:openai/gpt-next",
			"effort:control-a:high",
		]);
		const status = await manager.getSessionStatus(sessionA.id);
		expect(status.live?.usage).toEqual({ totalTokens: 123, costUsd: 0.01 });
		expect((await manager.get(sessionA.id)).cwd).toBe(os.homedir());
		await manager.stop(sessionA.id);
		const stopped = await manager.getSessionStatus(sessionA.id);
		expect(stopped.live).toBeUndefined();
		expect(stopped.session).not.toHaveProperty("model");
		await manager.stop(sessionB.id);
		store.close();
	});

	it("revalidates reload preconditions and rejects concurrent reloads without queueing", async () => {
		const started = deferred<void>();
		const complete = deferred<void>();
		let calls = 0;
		let selected = true;
		const harness = harnessPort({
			capabilities: [
				"harness.launch",
				"harness.stop",
				"harness.reload",
				"input.submit",
			],
			launch: async () => ({
				processId: "reload-test" as never,
				exit: new Promise(() => {}),
				events: (async function* () {})(),
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
					async setModel(provider, id) {
						return { provider, id, name: id };
					},
					async setEffort() {},
					async reload(beforeDispatch) {
						calls++;
						started.resolve();
						await complete.promise;
						beforeDispatch?.();
					},
				},
				async send() {},
				async cancel() {},
				async shutdown() {},
			}),
		}).harness;
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const manager = new SessionManager(store, [harness]);
		const session = await manager.create({
			id: "reload-test",
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		try {
			await expect(
				manager.reload(session.id, () => false),
			).rejects.toMatchObject({ code: "RELOAD_SELECTION_CHANGED" });
			expect(calls).toBe(0);
			const first = manager.reload(session.id, () => selected);
			await started.promise;
			await expect(
				manager.submit(session.id, "ordinary input"),
			).rejects.toMatchObject({
				code: "RELOAD_BUSY",
			});
			await expect(
				manager.reload(session.id, () => selected),
			).rejects.toMatchObject({ code: "RELOAD_ALREADY_RUNNING" });
			expect(calls).toBe(1);
			selected = false;
			complete.resolve();
			await expect(first).rejects.toMatchObject({
				code: "RELOAD_SELECTION_CHANGED",
			});
			selected = true;
			await manager.reload(session.id, () => selected);
		} finally {
			await manager.close();
			store.close();
		}
	});

	it("enforces each declared model and effort capability before calling controls", async () => {
		const controlCapabilities = [
			"harness.model.list",
			"harness.model.set",
			"harness.effort.list",
			"harness.effort.set",
		] as const;
		const cases: {
			missing: (typeof controlCapabilities)[number];
			run(manager: SessionManager, id: SessionId): Promise<unknown>;
		}[] = [
			{
				missing: "harness.model.list",
				run: (manager, id) => manager.listModels(id),
			},
			{
				missing: "harness.model.set",
				run: (manager, id) => manager.setModel(id, "openai", "gpt-next"),
			},
			{
				missing: "harness.effort.list",
				run: (manager, id) => manager.listEfforts(id),
			},
			{
				missing: "harness.effort.set",
				run: (manager, id) => manager.setEffort(id, "high"),
			},
		];
		for (const [index, testCase] of cases.entries()) {
			const calls: string[] = [];
			const capabilities = [
				"harness.launch",
				"harness.stop",
				...controlCapabilities.filter(
					(capability) => capability !== testCase.missing,
				),
			] as HarnessAdapter["descriptor"]["capabilities"];
			const harness = harnessPort({
				capabilities,
				launch: async () => ({
					processId: "capability-test" as never,
					exit: new Promise(() => {}),
					events: (async function* () {})(),
					control: {
						async getSelection() {
							calls.push("getSelection");
							return {};
						},
						async getStatus() {
							calls.push("getStatus");
							return {};
						},
						async listModels() {
							calls.push("listModels");
							return [];
						},
						async listEfforts() {
							calls.push("listEfforts");
							return [];
						},
						async setModel(provider, id) {
							calls.push("setModel");
							return { provider, id, name: id };
						},
						async setEffort() {
							calls.push("setEffort");
						},
					},
					async send() {},
					async cancel() {},
					async shutdown() {},
				}),
			}).harness;
			const store = await SqliteSessionStore.open(await temporaryDirectory());
			const manager = new SessionManager(store, [harness]);
			const session = await manager.create({
				id: `missing-control-${index}`,
				harnessId: harness.descriptor.id,
				cwd: os.homedir(),
			});
			expect((await manager.getSessionStatus(session.id)).live).toBeUndefined();
			await expect(testCase.run(manager, session.id)).rejects.toMatchObject({
				code: "UNSUPPORTED_CAPABILITY",
				capability: testCase.missing,
			});
			expect(calls).toEqual([]);
			await manager.stop(session.id);
			store.close();
		}
	});

	it("routes cancellation by session and accepted input ID", async () => {
		const state = await temporaryDirectory();
		const sessionAId = "cancel-a" as SessionId;
		const sessionBId = "cancel-b" as SessionId;
		const submitted: { sessionId: SessionId; inputId: InputId }[] = [];
		const cancelled: { sessionId: SessionId; inputId: InputId }[] = [];
		const harness = harnessPort({
			capabilities: [
				"harness.launch",
				"harness.stop",
				"harness.cancel",
				"input.submit",
			],
			launch: async (request) => ({
				processId: `process-${request.sessionId}` as never,
				exit: new Promise(() => {}),
				events: (async function* () {})(),
				async send(input) {
					submitted.push({ sessionId: input.sessionId, inputId: input.id });
				},
				async cancel(inputId) {
					cancelled.push({ sessionId: request.sessionId, inputId });
				},
				async shutdown() {},
			}),
		}).harness;
		const manager = new SessionManager(await SqliteSessionStore.open(state), [
			harness,
		]);
		const sessionA = await manager.create({
			id: sessionAId,
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		const sessionB = await manager.create({
			id: sessionBId,
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		const inputA = await manager.submit(sessionA.id, "cancel input A");
		const inputB = await manager.submit(sessionB.id, "cancel input B");
		expect(submitted).toEqual([
			{ sessionId: sessionA.id, inputId: inputA },
			{ sessionId: sessionB.id, inputId: inputB },
		]);
		await manager.cancel(sessionA.id, inputA);
		expect(cancelled).toEqual([{ sessionId: sessionA.id, inputId: inputA }]);
		await manager.cancel(sessionB.id, inputB);
		expect(cancelled).toEqual([
			{ sessionId: sessionA.id, inputId: inputA },
			{ sessionId: sessionB.id, inputId: inputB },
		]);
		await manager.stop(sessionA.id);
		await manager.stop(sessionB.id);
	});

	it("rejects cancellation when the selected harness lacks that capability", async () => {
		const state = await temporaryDirectory();
		let cancelCalls = 0;
		const harness = harnessPort({
			capabilities: ["harness.launch", "harness.stop", "input.submit"],
			launch: async () => ({
				processId: "process" as never,
				exit: new Promise(() => {}),
				events: (async function* () {})(),
				async send() {},
				async cancel() {
					cancelCalls += 1;
				},
				async shutdown() {},
			}),
		}).harness;
		const manager = new SessionManager(await SqliteSessionStore.open(state), [
			harness,
		]);
		const session = await manager.create({
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		await expect(
			manager.cancel(session.id, "input-1" as InputId),
		).rejects.toBeInstanceOf(UnsupportedCapabilityError);
		expect(cancelCalls).toBe(0);
		await manager.stop(session.id);
	});

	it("forwards ordered events and stops only the selected session's pump", async () => {
		const state = await temporaryDirectory();
		const sessionAId = "events-a" as SessionId;
		const sessionBId = "events-b" as SessionId;
		const releaseA = deferred<void>();
		const releaseB = deferred<void>();
		const seenFirstEvents = deferred<void>();
		const seenAllEvents = deferred<void>();
		const observed: HarnessEvent[] = [];
		const observerError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const harness = harnessPort({
			launch: async (request) => {
				const gate = request.sessionId === sessionAId ? releaseA : releaseB;
				const inputId = `input-${request.sessionId}` as InputId;
				return {
					processId: `process-${request.sessionId}` as never,
					exit: new Promise(() => {}),
					events: (async function* () {
						yield {
							sessionId: request.sessionId,
							kind: "output",
							text: `${request.sessionId}-start`,
						};
						await gate.promise;
						yield {
							sessionId: request.sessionId,
							kind: "input",
							inputEvent: { inputId, state: "uncertain" },
						};
						yield {
							sessionId: request.sessionId,
							kind: "output",
							text: `${request.sessionId}-end`,
						};
					})(),
					async send() {},
					async cancel() {},
					async shutdown() {
						gate.resolve(undefined);
					},
				};
			},
		}).harness;
		const manager = new SessionManager(await SqliteSessionStore.open(state), [
			harness,
		]);
		manager.subscribe(() => {
			throw new Error("observer detail must not escape");
		});
		manager.subscribe(async () => {
			throw new Error("async observer detail must not escape");
		});
		manager.subscribe((event) => {
			observed.push(event);
			if (
				observed.filter(
					(item) => item.kind === "output" && item.text?.endsWith("-start"),
				).length === 2
			)
				seenFirstEvents.resolve(undefined);
			if (observed.length === 4) seenAllEvents.resolve(undefined);
		});
		await manager.create({
			id: sessionAId,
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		await manager.create({
			id: sessionBId,
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		await seenFirstEvents.promise;
		await manager.stop(sessionAId);
		releaseB.resolve(undefined);
		await seenAllEvents.promise;
		const eventsA = observed.filter((event) => event.sessionId === sessionAId);
		expect(eventsA.map((event) => event.text)).toEqual([`${sessionAId}-start`]);
		expect(eventsA.map((event) => event.kind)).toEqual(["output"]);
		const eventsB = observed.filter((event) => event.sessionId === sessionBId);
		expect(eventsB.map((event) => event.text).filter(Boolean)).toEqual([
			`${sessionBId}-start`,
			`${sessionBId}-end`,
		]);
		expect(eventsB.map((event) => event.kind)).toEqual([
			"output",
			"input",
			"output",
		]);
		expect(eventsB[1]?.inputEvent?.inputId).toBe(`input-${sessionBId}`);
		expect(eventsB[1]?.inputEvent?.state).toBe("uncertain");
		await manager.stop(sessionBId);
		await Promise.resolve();
		expect(observerError).toHaveBeenCalledWith(
			"[harnessd] Session event observer failed",
		);
	});

	it("cancels a pending event read and coalesces concurrent stops", async () => {
		const state = await temporaryDirectory();
		const pendingRead = deferred<IteratorResult<HarnessEvent>>();
		const observed: HarnessEvent[] = [];
		const shutdownStarted = deferred<void>();
		const finishShutdown = deferred<void>();
		let shutdownCalls = 0;
		let iteratorReturnCalls = 0;
		const harness = harnessPort({
			launch: async () => ({
				processId: "process" as never,
				exit: new Promise(() => {}),
				events: {
					[Symbol.asyncIterator]() {
						return {
							next: () => pendingRead.promise,
							async return(): Promise<IteratorResult<HarnessEvent>> {
								iteratorReturnCalls += 1;
								return { done: true, value: undefined };
							},
						};
					},
				},
				async send() {},
				async cancel() {},
				async shutdown() {
					shutdownCalls += 1;
					shutdownStarted.resolve(undefined);
					await finishShutdown.promise;
				},
			}),
		}).harness;
		const manager = new SessionManager(await SqliteSessionStore.open(state), [
			harness,
		]);
		const session = await manager.create({
			id: "stop-with-open-event-read",
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		manager.subscribe((event) => observed.push(event));
		const firstStop = manager.stop(session.id);
		await shutdownStarted.promise;
		let secondStopCompleted = false;
		const secondStop = manager.stop(session.id).then(() => {
			secondStopCompleted = true;
		});
		await Promise.resolve();
		expect(secondStopCompleted).toBe(false);
		expect(shutdownCalls).toBe(1);
		finishShutdown.resolve(undefined);
		await Promise.all([firstStop, secondStop]);
		expect(secondStopCompleted).toBe(true);
		expect(iteratorReturnCalls).toBe(1);
		pendingRead.resolve({
			done: false,
			value: { sessionId: session.id, kind: "output", text: "late event" },
		});
		await Promise.resolve();
		expect(observed).toEqual([]);
		expect((await manager.get(session.id)).status).toBe("stopped");
	});

	it("surfaces event-stream failure without exposing its underlying error", async () => {
		const state = await temporaryDirectory();
		const received = deferred<HarnessEvent>();
		const harness = harnessPort({
			launch: async () => ({
				processId: "process" as never,
				exit: new Promise(() => {}),
				events: {
					[Symbol.asyncIterator]() {
						return {
							async next(): Promise<IteratorResult<HarnessEvent>> {
								throw new Error("sensitive adapter detail");
							},
						};
					},
				},
				async send() {},
				async cancel() {},
				async shutdown() {},
			}),
		}).harness;
		const manager = new SessionManager(await SqliteSessionStore.open(state), [
			harness,
		]);
		manager.subscribe((event) => received.resolve(event));
		const session = await manager.create({
			id: "event-error",
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		expect(await received.promise).toEqual({
			sessionId: session.id,
			kind: "error",
			text: "Harness event stream failed",
			fatal: true,
		});
		await manager.stop(session.id);
	});

	it("waits for an in-flight launch before making an operator stop terminal", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const started = deferred<void>();
		const launchResult = deferred<HarnessInstance>();
		let shutdownCalls = 0;
		const { harness } = harnessPort({
			launch: async () => {
				started.resolve(undefined);
				return launchResult.promise;
			},
		});
		const manager = new SessionManager(store, [harness]);
		const id = "stop-during-launch" as SessionId;
		const createPromise = manager.create({
			id,
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		await started.promise;
		const stopPromise = manager.stop(id);
		expect((await manager.get(id)).status).toBe("starting");
		launchResult.resolve({
			processId: "process" as never,
			exit: new Promise(() => {}),
			events: (async function* () {})(),
			async send() {},
			async cancel() {},
			async shutdown() {
				shutdownCalls += 1;
			},
		});
		await createPromise;
		await stopPromise;
		expect((await manager.get(id)).status).toBe("stopped");
		expect(shutdownCalls).toBe(1);
		store.close();
	});

	it("validates paths before launch and accepts broad existing directories", async () => {
		const state = await temporaryDirectory();
		const { harness, launched } = harnessPort();
		const manager = new SessionManager(await SqliteSessionStore.open(state), [
			harness,
		]);
		const regularFile = path.join(state, "not-a-directory");
		await writeFile(regularFile, "file");
		await expect(
			manager.create({
				id: "bad",
				harnessId: harness.descriptor.id,
				cwd: path.join(state, "missing"),
			}),
		).rejects.toBeInstanceOf(InvalidWorkingDirectoryError);
		await expect(
			manager.create({
				id: "not-directory",
				harnessId: harness.descriptor.id,
				cwd: regularFile,
			}),
		).rejects.toBeInstanceOf(InvalidWorkingDirectoryError);
		expect(launched).toHaveLength(0);
		const broad = await manager.create({
			id: "root-ok",
			harnessId: harness.descriptor.id,
			cwd: path.parse(state).root,
		});
		expect(broad.cwd).toBe(path.parse(state).root);
		expect(launched).toHaveLength(1);
	});

	it("does not launch for duplicate IDs or unsupported capabilities and records failed starts", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const broken = harnessPort({
			launch: async () => {
				throw new Error("launch failed");
			},
		});
		const manager = new SessionManager(store, [broken.harness]);
		await expect(
			manager.create({
				id: "duplicate",
				harnessId: broken.harness.descriptor.id,
				cwd: os.homedir(),
			}),
		).rejects.toThrow("launch failed");
		await expect(
			manager.create({
				id: "duplicate",
				harnessId: broken.harness.descriptor.id,
				cwd: os.homedir(),
			}),
		).rejects.toThrow("already exists");
		expect((await manager.get("duplicate" as SessionId)).status).toBe("failed");
		expect(broken.launched).toHaveLength(1);
		const unsupported = new SessionManager(store, [
			harnessPort({ capabilities: [] }).harness,
		]);
		await expect(
			unsupported.create({
				harnessId: "mock-harness" as AdapterId,
				cwd: os.homedir(),
			}),
		).rejects.toBeInstanceOf(UnsupportedCapabilityError);
		store.close();
	});

	it("retains an instance for stop retry when startup persistence and cleanup both fail", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const update = store.update.bind(store);
		let updateFailures = 1;
		store.update = async (session) => {
			if (updateFailures > 0) {
				updateFailures -= 1;
				throw new Error("running persistence failed");
			}
			await update(session);
		};
		let shutdownCalls = 0;
		const { harness } = harnessPort({
			launch: async () => ({
				processId: "process" as never,
				exit: new Promise(() => {}),
				events: (async function* () {})(),
				async send() {},
				async cancel() {},
				async shutdown() {
					shutdownCalls += 1;
					if (shutdownCalls === 1) throw new Error("shutdown failed");
				},
			}),
		});
		const manager = new SessionManager(store, [harness]);
		const id = "cleanup-retry" as SessionId;
		const failure = await manager
			.create({ id, harnessId: harness.descriptor.id, cwd: os.homedir() })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toHaveLength(2);
		expect((await manager.get(id)).status).toBe("failed");
		store.update = update;
		await manager.stop(id);
		expect(shutdownCalls).toBe(2);
		expect((await manager.get(id)).status).toBe("stopped");
		store.close();
	});

	it("manager close attempts all live instances and retains failed sessions", async () => {
		const store = await SqliteSessionStore.open(await temporaryDirectory());
		const closed: string[] = [];
		const harness = harnessPort({
			launch: async (request) => ({
				processId: `process-${request.sessionId}` as never,
				exit: new Promise(() => {}),
				events: (async function* () {})(),
				async send() {},
				async cancel() {},
				async shutdown() {
					closed.push(request.sessionId);
					if (request.sessionId === "close-a")
						throw new Error("private failure");
				},
			}),
		}).harness;
		const manager = new SessionManager(store, [harness]);
		const a = await manager.create({
			id: "close-a",
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		const b = await manager.create({
			id: "close-b",
			harnessId: harness.descriptor.id,
			cwd: os.homedir(),
		});
		await expect(manager.close()).rejects.toBeInstanceOf(AggregateError);
		expect(closed).toEqual([a.id, b.id]);
		expect((await manager.get(a.id)).status).toBe("running");
		expect((await manager.get(b.id)).status).toBe("stopped");
		store.close();
	});

	it("rejects relative state-directory inputs without consulting process cwd", async () => {
		const originalHarnessd = process.env.HARNESSD_STATE_DIR;
		const originalXdg = process.env.XDG_STATE_HOME;
		try {
			delete process.env.HARNESSD_STATE_DIR;
			delete process.env.XDG_STATE_HOME;
			expect(() => resolveStateDirectory("relative/state")).toThrow(
				InvalidStateDirectoryError,
			);
			process.env.HARNESSD_STATE_DIR = "relative/state";
			expect(() => resolveStateDirectory()).toThrow(InvalidStateDirectoryError);
			delete process.env.HARNESSD_STATE_DIR;
			process.env.XDG_STATE_HOME = "relative/xdg";
			expect(() => resolveStateDirectory()).toThrow(InvalidStateDirectoryError);
		} finally {
			if (originalHarnessd === undefined) delete process.env.HARNESSD_STATE_DIR;
			else process.env.HARNESSD_STATE_DIR = originalHarnessd;
			if (originalXdg === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = originalXdg;
		}
	});

	it("rejects drive-less rooted Windows state paths but accepts drive and UNC paths", () => {
		expect(() => validateStateDirectoryPath("/state", "test", "win32")).toThrow(
			InvalidStateDirectoryError,
		);
		expect(() =>
			validateStateDirectoryPath("\\state", "test", "win32"),
		).toThrow(InvalidStateDirectoryError);
		expect(validateStateDirectoryPath("C:\\state", "test", "win32")).toBe(
			"C:\\state",
		);
		expect(
			validateStateDirectoryPath("\\\\server\\share\\state", "test", "win32"),
		).toBe("\\\\server\\share\\state");
		expect(
			validateStateDirectoryPath("//server/share/state", "test", "win32"),
		).toBe("\\\\server\\share\\state");
		expect(
			validateStateDirectoryPath("\\\\?\\C:\\state", "test", "win32"),
		).toBe("\\\\?\\C:\\state");
		expect(
			validateStateDirectoryPath(
				"\\\\?\\UNC\\server\\share\\state",
				"test",
				"win32",
			),
		).toBe("\\\\?\\UNC\\server\\share\\state");
	});

	it("rejects an existing POSIX state directory with group or other access", async () => {
		if (process.platform === "win32") return;
		const state = await temporaryDirectory();
		await chmod(state, 0o755);
		await expect(SqliteSessionStore.open(state)).rejects.toBeInstanceOf(
			InvalidStateDirectoryError,
		);
		expect(await readdir(state)).toEqual([]);
	});

	it("closes SQLite handles when initialization fails after opening the database", async () => {
		if (process.platform !== "linux") return;
		const state = await temporaryDirectory();
		const databasePath = path.join(state, "sessions.sqlite3");
		await writeFile(databasePath, "not a sqlite database");
		await expect(SqliteSessionStore.open(state)).rejects.toBeInstanceOf(
			SessionStoreError,
		);
		const descriptors = await readdir("/proc/self/fd");
		const targets = await Promise.all(
			descriptors.map((descriptor) =>
				readlink(`/proc/self/fd/${descriptor}`).catch(() => ""),
			),
		);
		expect(targets).not.toContain(databasePath);
		await rm(databasePath);
		const reopened = await SqliteSessionStore.open(state);
		reopened.close();
	});

	it("rejects malformed session IDs", async () => {
		const { harness } = harnessPort();
		const manager = new SessionManager(
			await SqliteSessionStore.open(await temporaryDirectory()),
			[harness],
		);
		await expect(
			manager.create({
				id: "bad/id",
				harnessId: harness.descriptor.id,
				cwd: os.homedir(),
			}),
		).rejects.toThrow("Invalid session ID");
	});
});
