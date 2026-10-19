import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationRuntime } from "../src/application-runtime.js";
import type {
	HarnessAdapter,
	HarnessInstance,
	SessionId,
	SessionStore,
	TransportAdapter,
} from "../src/core/index.js";
import { SessionManager, SqliteSessionStore } from "../src/core/index.js";

type Exit = { code: number | null; signal: string | null };

const directories: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
async function flush() {
	for (let index = 0; index < 12; index++) await Promise.resolve();
}
async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "failure-test-"));
	directories.push(directory);
	return directory;
}
function instance(
	exit: Promise<Exit>,
	options: { readonly nativeSessionId?: string; readonly tail?: string } = {},
): HarnessInstance {
	return {
		processId: "proc" as never,
		exit,
		nativeSessionId: options.nativeSessionId ?? "native-exact",
		events: (async function* () {})(),
		...(options.tail ? { diagnosticTail: () => options.tail } : {}),
		async send() {},
		async cancel() {},
		async shutdown() {},
	};
}
/** A harness whose every instance exits when the test resolves its exit. */
function crashingHarness(
	resume: (attempt: number) => Promise<HarnessInstance>,
): HarnessAdapter & { exits: ReturnType<typeof deferred<Exit>>[] } {
	const exits: ReturnType<typeof deferred<Exit>>[] = [];
	let resumes = 0;
	return {
		exits,
		descriptor: {
			id: "crashing" as never,
			capabilities: ["harness.launch", "harness.stop", "harness.resume"],
		},
		async launch() {
			const exit = deferred<Exit>();
			exits.push(exit);
			return instance(exit.promise, { tail: "pi stderr before crash" });
		},
		async resume() {
			resumes++;
			return resume(resumes);
		},
	};
}
async function setup(harness: HarnessAdapter) {
	const directory = await temporaryDirectory();
	const store = await SqliteSessionStore.open(directory);
	const journal: string[] = [];
	const events: string[] = [];
	const manager = new SessionManager(store, [harness], {
		journal: (line) => journal.push(line),
	});
	manager.subscribe((event) => {
		if (event.kind === "status" && event.text) events.push(event.text);
	});
	const session = await manager.create({
		harnessId: harness.descriptor.id,
		cwd: directory,
	});
	return { manager, store, session, journal, events };
}
function startupError(tail: string): Error {
	const error = Object.assign(new Error("Pi RPC startup failed"), {
		code: "PI_EXITED_BEFORE_READY",
	});
	Object.defineProperty(error, "diagnosticTail", {
		value: tail,
		enumerable: false,
	});
	return error;
}

describe("recovery budget", () => {
	it("recovers four crash cycles in one manager lifetime, each after 250 ms", async () => {
		vi.useFakeTimers();
		const harness = crashingHarness(async () => {
			const exit = deferred<Exit>();
			harness.exits.push(exit);
			return instance(exit.promise);
		});
		const { manager, store, session, events } = await setup(harness);
		for (let cycle = 0; cycle < 4; cycle++) {
			harness.exits.at(-1)?.resolve({ code: 1, signal: null });
			await flush();
			await vi.advanceTimersByTimeAsync(249);
			expect(harness.exits).toHaveLength(cycle + 1);
			await vi.advanceTimersByTimeAsync(1);
			await flush();
			expect(harness.exits).toHaveLength(cycle + 2);
			expect((await store.get(session.id))?.status).toBe("running");
		}
		expect(events.filter((text) => text === "harness_recovered")).toHaveLength(
			4,
		);
		expect(events).not.toContain("harness_recovery_failed");
		await manager.close();
		store.close();
	});

	it("persists failed with unexpected_exit after three consecutive failed resumes and journals each", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-19T12:00:00.000Z"));
		const harness = crashingHarness(async (attempt) => {
			throw startupError(`resume stderr ${attempt}`);
		});
		const { manager, store, session, journal, events } = await setup(harness);
		harness.exits[0]?.resolve({ code: 7, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250 + 1000 + 4000);
		await flush();
		const record = await store.get(session.id);
		expect(record).toMatchObject({
			status: "failed",
			failureReason: "unexpected_exit",
		});
		expect(Date.parse(record?.failedAt ?? "")).toBeGreaterThan(0);
		expect(events.filter((text) => text === "harness_recovery_failed")).toEqual(
			["harness_recovery_failed"],
		);
		expect(journal).toHaveLength(4);
		for (const [index, line] of journal.slice(0, 3).entries()) {
			expect(line.startsWith("harnessd: ")).toBe(true);
			expect(line).toContain(`session ${session.id} recovery attempt failed`);
			expect(line).toContain("reason=unexpected_exit");
			expect(line).toContain(`attempt=${index + 1}/3`);
			expect(line).toContain("exit=code:7");
			expect(line).toContain("error=PI_EXITED_BEFORE_READY");
			expect(line).toContain(`stderr="resume stderr ${index + 1}"`);
			expect(line).not.toContain("\n");
		}
		expect(journal[3]).toContain(`harnessd: session ${session.id} failed`);
		expect(journal[3]).toContain("reason=unexpected_exit attempt=3/3");
		expect(journal[3]).toContain('stderr="resume stderr 3"');
		await manager.close();
		store.close();
	});

	it("resets the budget after operator stop and resume", async () => {
		vi.useFakeTimers();
		let failResumes = true;
		const resumeCalls: number[] = [];
		const harness = crashingHarness(async () => {
			resumeCalls.push(Date.now());
			if (failResumes) throw new Error("transient");
			const exit = deferred<Exit>();
			harness.exits.push(exit);
			return instance(exit.promise);
		});
		const { manager, store, session } = await setup(harness);
		harness.exits[0]?.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250 + 1000);
		await flush();
		expect(resumeCalls).toHaveLength(2);
		// The operator stops during the last backoff, then resumes explicitly.
		await manager.stop(session.id);
		failResumes = false;
		await manager.resume(session.id);
		expect((await store.get(session.id))?.status).toBe("running");
		failResumes = true;
		resumeCalls.length = 0;
		const began = Date.now();
		harness.exits.at(-1)?.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250 + 1000 + 4000);
		await flush();
		// A full budget again: three attempts at the first, second and third delays.
		expect(resumeCalls.map((value) => value - began)).toEqual([
			250, 1250, 5250,
		]);
		expect((await store.get(session.id))?.status).toBe("failed");
		await manager.close();
		store.close();
	});
});

describe("failure causes", () => {
	it("records resume_unavailable and native_id_mismatch with a journal line", async () => {
		vi.useFakeTimers();
		const noResume: HarnessAdapter = {
			descriptor: {
				id: "no-resume" as never,
				capabilities: ["harness.launch", "harness.stop"],
			},
			async launch() {
				return instance(Promise.resolve({ code: null, signal: "SIGKILL" }), {
					tail: "killed",
				});
			},
		};
		const first = await setup(noResume);
		await flush();
		expect(await first.store.get(first.session.id)).toMatchObject({
			status: "failed",
			failureReason: "resume_unavailable",
		});
		expect(first.journal).toEqual([
			`harnessd: session ${first.session.id} failed reason=resume_unavailable attempt=0/3 exit=signal:SIGKILL stderr="killed"`,
		]);
		await first.manager.close();
		first.store.close();

		const mismatch = crashingHarness(async () =>
			instance(new Promise(() => {}), { nativeSessionId: "other" }),
		);
		const second = await setup(mismatch);
		mismatch.exits[0]?.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		await flush();
		expect(await second.store.get(second.session.id)).toMatchObject({
			status: "failed",
			failureReason: "native_id_mismatch",
		});
		expect(second.journal.at(-1)).toContain("reason=native_id_mismatch");
		await second.manager.close();
		second.store.close();
	});

	it("records launch_failed for a failed create", async () => {
		const directory = await temporaryDirectory();
		const store = await SqliteSessionStore.open(directory);
		const journal: string[] = [];
		const harness: HarnessAdapter = {
			descriptor: { id: "broken" as never, capabilities: ["harness.launch"] },
			async launch() {
				throw startupError("no such model");
			},
		};
		const manager = new SessionManager(store, [harness], {
			journal: (line) => journal.push(line),
		});
		await expect(
			manager.create({
				harnessId: "broken" as never,
				cwd: directory,
				id: "launch-1",
			}),
		).rejects.toThrow("Pi RPC startup failed");
		expect(await store.get("launch-1" as SessionId)).toMatchObject({
			status: "failed",
			failureReason: "launch_failed",
		});
		expect(journal).toEqual([
			'harnessd: session launch-1 failed reason=launch_failed attempt=0/3 exit=none error=PI_EXITED_BEFORE_READY stderr="no such model"',
		]);
		await manager.close();
		store.close();
	});

	it("clears the cause when the session runs again", async () => {
		const directory = await temporaryDirectory();
		const store = await SqliteSessionStore.open(directory);
		const harness: HarnessAdapter = {
			descriptor: {
				id: "clear" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(new Promise(() => {}));
			},
			async resume() {
				return instance(new Promise(() => {}));
			},
		};
		const manager = new SessionManager(store, [harness]);
		const session = await manager.create({
			harnessId: "clear" as never,
			cwd: directory,
		});
		await store.setStatus(session.id, "failed", {
			reason: "unexpected_exit",
			at: "2026-10-19T10:00:00.000Z",
		});
		await manager.stop(session.id);
		// Stopping keeps the cause visible.
		expect(await store.get(session.id)).toMatchObject({
			status: "stopped",
			failureReason: "unexpected_exit",
		});
		const resumed = await manager.resume(session.id);
		expect(resumed.failureReason).toBeUndefined();
		expect(resumed.failedAt).toBeUndefined();
		const stored = await store.get(session.id);
		expect(stored?.status).toBe("running");
		expect(stored?.failureReason).toBeUndefined();
		expect(stored?.failedAt).toBeUndefined();
		await manager.close();
		store.close();
	});

	it("migrates a pre-0.3.0 database idempotently", async () => {
		const directory = await temporaryDirectory();
		const legacy = new Database(path.join(directory, "sessions.sqlite3"));
		legacy.exec(`CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			harness_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			native_session_id TEXT,
			status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopped', 'failed', 'uncertain')),
			name TEXT,
			adapter_options TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		legacy
			.prepare(
				"INSERT INTO sessions (id, harness_id, cwd, native_session_id, status) VALUES (?, ?, ?, ?, ?)",
			)
			.run("legacy", "pi-rpc", directory, "native-legacy", "failed");
		legacy.close();
		for (let open = 0; open < 2; open++) {
			const store = await SqliteSessionStore.open(directory);
			const record = await store.get("legacy" as SessionId);
			expect(record?.status).toBe("failed");
			if (open === 0) {
				expect(record?.failureReason).toBeUndefined();
				await store.setStatus("legacy" as SessionId, "failed", {
					reason: "unexpected_exit",
					at: "2026-10-19T10:00:00.000Z",
				});
			} else
				expect(record).toMatchObject({
					failureReason: "unexpected_exit",
					failedAt: "2026-10-19T10:00:00.000Z",
				});
			store.close();
		}
	});
});

describe("runtime shutdown", () => {
	it("treats a harness exit during transport stop as shutdown, not a crash", async () => {
		const directory = await temporaryDirectory();
		const base = await SqliteSessionStore.open(directory);
		const writes: string[] = [];
		const store: SessionStore & { close(): void } = {
			create: (session) => base.create(session),
			list: () => base.list(),
			get: (id) => base.get(id),
			delete: (id) => base.delete(id),
			setName: (id, name) => base.setName(id, name),
			update: (session) => base.update(session),
			async setStatus(id, status, failure) {
				writes.push(status);
				await base.setStatus(id, status, failure);
			},
			close() {},
		};
		const exit = deferred<Exit>();
		let resumes = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "shutdown" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(exit.promise);
			},
			async resume() {
				resumes++;
				return instance(new Promise(() => {}));
			},
		};
		const stopGate = deferred<void>();
		const stopEntered = deferred<void>();
		const transport: TransportAdapter = {
			descriptor: { id: "held" as never, capabilities: [] },
			async start() {},
			async stop() {
				stopEntered.resolve();
				await stopGate.promise;
			},
		};
		const runtime = await ApplicationRuntime.start({
			piExecutable: "/unused/pi",
			store,
			transports: [transport],
			harnesses: [harness],
		});
		const created = await runtime.dispatch({
			requestId: "create",
			principalId: "test",
			kind: "create",
			harnessId: "shutdown" as never,
			cwd: directory,
		});
		if (!created.ok) throw new Error("create failed");
		const sessionId = (created.value as { id: SessionId }).id;
		writes.length = 0;
		const closing = runtime.close();
		await stopEntered.promise;
		// systemd-style: the Pi child dies while transports are still stopping.
		exit.resolve({ code: null, signal: "SIGTERM" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		stopGate.resolve();
		await closing;
		expect(resumes).toBe(0);
		expect(writes).not.toContain("failed");
		expect(writes).not.toContain("starting");
		expect((await base.get(sessionId))?.status).toBe("stopped");
		base.close();
	});
});
