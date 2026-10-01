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
	InvalidStateDirectoryError,
	InvalidWorkingDirectoryError,
	requireCapability,
	resolveStateDirectory,
	SessionManager,
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
	async stop() {
		throw new UnsupportedCapabilityError("session.stop", "memory");
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
	it("uses required fields for each transport event kind", () => {
		const events: TransportEvent[] = [
			{ principalId: "operator", kind: "list-sessions" },
			{
				principalId: "operator",
				kind: "create-session",
				harnessId: "mock" as never,
				cwd: "/workspace",
			},
			{
				principalId: "operator",
				kind: "stop-session",
				sessionId: "session" as never,
			},
			{
				principalId: "operator",
				kind: "submit-input",
				sessionId: "session" as never,
				text: "hello",
			},
		];
		expect(events.map((event) => event.kind)).toEqual([
			"list-sessions",
			"create-session",
			"stop-session",
			"submit-input",
		]);
	});

	it("throws explicit unsupported-capability errors", async () => {
		await expect(
			mockSessionPort.stop("session" as never),
		).rejects.toBeInstanceOf(UnsupportedCapabilityError);
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
		});
		expect(session).toMatchObject({
			id: "session-1",
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
