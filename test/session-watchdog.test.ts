import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	HarnessAdapter,
	HarnessInstance,
	SessionId,
	SessionStore,
} from "../src/core/index.js";
import {
	SessionManager,
	SqliteSessionStore,
	UnsupportedCapabilityError,
} from "../src/core/index.js";
import { UncertainInputDeliveryError } from "../src/harness/pi-rpc-harness.js";

const directories: string[] = [];
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
async function flush() {
	for (let index = 0; index < 12; index++) await Promise.resolve();
}
const neverExit = new Promise<{ code: number | null; signal: string | null }>(
	() => {},
);
function instance(
	exit: Promise<{ code: number | null; signal: string | null }> = neverExit,
): HarnessInstance {
	return {
		processId: "proc" as never,
		exit,
		nativeSessionId: "native-exact",
		events: (async function* () {})(),
		async send() {},
		async cancel() {},
		async shutdown() {},
	};
}
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});
async function setup(harness: HarnessAdapter, id?: string) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "watchdog-test-"));
	directories.push(directory);
	const store = await SqliteSessionStore.open(directory);
	const manager = new SessionManager(store, [harness]);
	const session = await manager.create({
		harnessId: harness.descriptor.id,
		cwd: directory,
		...(id === undefined ? {} : { id }),
	});
	return { manager, store, session };
}

describe("in-process watchdog", () => {
	it("does not restart at event EOF, but resumes on explicit exit with stored native ID", async () => {
		vi.useFakeTimers();
		let exit!: (value: { code: number | null; signal: string | null }) => void;
		const processExit = new Promise<{
			code: number | null;
			signal: string | null;
		}>((resolve) => {
			exit = resolve;
		});
		const resumed: unknown[] = [];
		const harness: HarnessAdapter & { calls: unknown[] } = {
			calls: resumed,
			descriptor: {
				id: "watch" as never,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.resume",
					"input.submit",
				],
			},
			async launch() {
				return instance(processExit);
			},
			async resume(request) {
				this.calls.push(request);
				return instance();
			},
		};
		const { manager, store, session } = await setup(harness);
		await Promise.resolve();
		await Promise.resolve();
		expect(resumed).toHaveLength(0);
		exit({ code: 1, signal: null });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(249);
		expect(resumed).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(resumed).toEqual([
			{
				sessionId: session.id,
				cwd: session.cwd,
				nativeSessionId: "native-exact",
			},
		]);
		expect((await store.get(session.id as SessionId))?.status).toBe("running");
		await manager.close();
		store.close();
	});

	it("requires the harness.stop capability before operator shutdown", async () => {
		let shutdowns = 0;
		const harness: HarnessAdapter = {
			descriptor: { id: "no-stop" as never, capabilities: ["harness.launch"] },
			async launch() {
				return {
					...instance(),
					async shutdown() {
						shutdowns++;
					},
				};
			},
		};
		const { manager, store, session } = await setup(harness);
		await expect(manager.stop(session.id)).rejects.toBeInstanceOf(
			UnsupportedCapabilityError,
		);
		expect(shutdowns).toBe(0);
		await expect(manager.close()).rejects.toThrow("shutdown was incomplete");
		expect(shutdowns).toBe(0);
		store.close();
	});

	it("fails closed without resume capability and never invokes launch as fallback", async () => {
		vi.useFakeTimers();
		let exit!: (value: { code: number | null; signal: string | null }) => void;
		const processExit = new Promise<{
			code: number | null;
			signal: string | null;
		}>((resolve) => {
			exit = resolve;
		});
		let launches = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "no-resume" as never,
				capabilities: ["harness.launch", "harness.stop"],
			},
			async launch() {
				launches++;
				return instance(processExit);
			},
		};
		const { manager, store, session } = await setup(harness);
		exit({ code: 2, signal: null });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect((await store.get(session.id))?.status).toBe("failed");
		expect(launches).toBe(1);
		await manager.close();
		store.close();
	});

	it("drains final events before resume and scopes recovery to the exited session", async () => {
		vi.useFakeTimers();
		const exits = new Map<
			string,
			ReturnType<
				typeof deferred<{ code: number | null; signal: string | null }>
			>
		>();
		const resumed: string[] = [];
		const finalGate = deferred<void>();
		const finishGate = deferred<void>();
		const seen: string[] = [];
		const harness: HarnessAdapter = {
			descriptor: {
				id: "isolation" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch(request) {
				const childExit = deferred<{
					code: number | null;
					signal: string | null;
				}>();
				exits.set(request.sessionId, childExit);
				return {
					...instance(childExit.promise),
					events: (async function* () {
						if (request.sessionId === "drain-A") {
							await finalGate.promise;
							yield {
								sessionId: request.sessionId,
								kind: "output" as const,
								text: "final",
							};
							await finishGate.promise;
						}
					})(),
				};
			},
			async resume(request) {
				resumed.push(request.sessionId);
				return instance();
			},
		};
		const { manager, store, session } = await setup(harness, "drain-A");
		const statusWrites: string[] = [];
		const setStatus = store.setStatus.bind(store);
		store.setStatus = async (id, status) => {
			statusWrites.push(status);
			await setStatus(id, status);
		};
		let runningBeforeRecovered = false;
		const other = await manager.create({
			id: "drain-B",
			harnessId: harness.descriptor.id,
			cwd: session.cwd,
		});
		manager.subscribe((event) => {
			if (event.text) seen.push(event.text);
			if (event.text === "harness_recovered")
				runningBeforeRecovered = statusWrites.at(-1) === "running";
		});
		exits.get(session.id)?.resolve({ code: 1, signal: null });
		await flush();
		expect(resumed).toEqual([]);
		finalGate.resolve();
		await flush();
		expect(seen).toContain("final");
		await vi.advanceTimersByTimeAsync(5000);
		expect(resumed).toEqual([]);
		finishGate.resolve();
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		await flush();
		expect(seen.indexOf("final")).toBeLessThan(
			seen.indexOf("harness_restarting"),
		);
		expect(seen.indexOf("harness_restarting")).toBeLessThan(
			seen.indexOf("harness_recovered"),
		);
		expect(runningBeforeRecovered).toBe(true);
		expect(resumed).toEqual([session.id]);
		expect((await store.get(other.id))?.status).toBe("running");
		await manager.close();
		store.close();
	});

	it("keeps input, events, cancellation and recovery bound to distinct workspace and native IDs", async () => {
		vi.useFakeTimers();
		const stateDirectory = await mkdtemp(
			path.join(os.tmpdir(), "watchdog-state-"),
		);
		directories.push(stateDirectory);
		const workspaceA = await realpath(
			await mkdtemp(path.join(os.tmpdir(), "watchdog-workspace-a-")),
		);
		directories.push(workspaceA);
		const workspaceB = await realpath(
			await mkdtemp(path.join(os.tmpdir(), "watchdog-workspace-b-")),
		);
		directories.push(workspaceB);
		const exits = new Map<
			string,
			ReturnType<
				typeof deferred<{ code: number | null; signal: string | null }>
			>
		>();
		const launches: { sessionId: string; cwd: string }[] = [];
		const submissions: { sessionId: string; cwd: string; text: string }[] = [];
		const cancellations: {
			sessionId: string;
			cwd: string;
			inputId: string;
		}[] = [];
		const resumptions: {
			sessionId: string;
			cwd: string;
			nativeSessionId: string;
		}[] = [];
		const observed: { sessionId: string; kind: string; text?: string }[] = [];
		const harness: HarnessAdapter = {
			descriptor: {
				id: "distinct-contexts" as never,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.resume",
					"input.submit",
					"harness.cancel",
				],
			},
			async launch(request) {
				launches.push({ sessionId: request.sessionId, cwd: request.cwd });
				const childExit = deferred<{
					code: number | null;
					signal: string | null;
				}>();
				exits.set(request.sessionId, childExit);
				const nativeSessionId =
					request.cwd === workspaceA ? "native-A" : "native-B";
				return {
					...instance(childExit.promise),
					nativeSessionId,
					events: (async function* () {
						yield {
							sessionId: request.sessionId,
							kind: "output" as const,
							text: `event-${nativeSessionId}`,
						};
					})(),
					async send(input) {
						submissions.push({
							sessionId: request.sessionId,
							cwd: request.cwd,
							text: input.text,
						});
					},
					async cancel(inputId) {
						cancellations.push({
							sessionId: request.sessionId,
							cwd: request.cwd,
							inputId,
						});
					},
				};
			},
			async resume(request) {
				if (request.nativeSessionId === undefined)
					throw new Error("Expected native session ID for recovery");
				resumptions.push({
					sessionId: request.sessionId,
					cwd: request.cwd,
					nativeSessionId: request.nativeSessionId,
				});
				return { ...instance(), nativeSessionId: request.nativeSessionId };
			},
		};
		const store = await SqliteSessionStore.open(stateDirectory);
		const manager = new SessionManager(store, [harness]);
		manager.subscribe((event) => {
			observed.push({
				sessionId: event.sessionId,
				kind: event.kind,
				...(event.text === undefined ? {} : { text: event.text }),
			});
		});
		try {
			const sessionA = await manager.create({
				id: "distinct-A",
				harnessId: harness.descriptor.id,
				cwd: workspaceA,
			});
			const sessionB = await manager.create({
				id: "distinct-B",
				harnessId: harness.descriptor.id,
				cwd: workspaceB,
			});
			await flush();
			expect(launches).toEqual([
				{ sessionId: sessionA.id, cwd: workspaceA },
				{ sessionId: sessionB.id, cwd: workspaceB },
			]);
			expect(observed.filter((event) => event.kind === "output")).toEqual([
				{ sessionId: sessionA.id, kind: "output", text: "event-native-A" },
				{ sessionId: sessionB.id, kind: "output", text: "event-native-B" },
			]);
			expect((await store.get(sessionA.id))?.nativeSessionId).toBe("native-A");
			expect((await store.get(sessionB.id))?.nativeSessionId).toBe("native-B");

			const inputA = await manager.submit(sessionA.id, "input-A");
			const inputB = await manager.submit(sessionB.id, "input-B");
			await manager.cancel(sessionA.id, inputA);
			await manager.cancel(sessionB.id, inputB);
			expect(submissions).toEqual([
				{ sessionId: sessionA.id, cwd: workspaceA, text: "input-A" },
				{ sessionId: sessionB.id, cwd: workspaceB, text: "input-B" },
			]);
			expect(cancellations).toEqual([
				{ sessionId: sessionA.id, cwd: workspaceA, inputId: inputA },
				{ sessionId: sessionB.id, cwd: workspaceB, inputId: inputB },
			]);

			exits.get(sessionA.id)?.resolve({ code: 1, signal: null });
			await flush();
			await vi.advanceTimersByTimeAsync(250);
			await flush();
			expect(resumptions).toEqual([
				{
					sessionId: sessionA.id,
					cwd: workspaceA,
					nativeSessionId: "native-A",
				},
			]);
			expect((await store.get(sessionA.id))?.status).toBe("running");
			expect((await store.get(sessionB.id))?.status).toBe("running");
			await manager.submit(sessionB.id, "peer-still-active");
			expect(submissions.at(-1)).toEqual({
				sessionId: sessionB.id,
				cwd: workspaceB,
				text: "peer-still-active",
			});
		} finally {
			await manager.close();
			store.close();
		}
	});

	it("keeps a credential sentinel out of supervisor diagnostics and metadata", async () => {
		const stateDirectory = await mkdtemp(
			path.join(os.tmpdir(), "watchdog-credential-state-"),
		);
		directories.push(stateDirectory);
		const workspaceA = await realpath(
			await mkdtemp(path.join(os.tmpdir(), "watchdog-credential-workspace-a-")),
		);
		directories.push(workspaceA);
		const workspaceB = await realpath(
			await mkdtemp(path.join(os.tmpdir(), "watchdog-credential-workspace-b-")),
		);
		directories.push(workspaceB);
		const sentinel = "known-credential-sentinel-7f92";
		const store = await SqliteSessionStore.open(stateDirectory);
		const harness: HarnessAdapter = {
			descriptor: {
				id: "credential-sentinel" as never,
				capabilities: ["harness.launch", "harness.stop"],
			},
			async launch({ sessionId }) {
				return {
					...instance(),
					events: (async function* () {
						yield { sessionId, kind: "status" as const, text: "started" };
					})(),
				};
			},
		};
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new SessionManager(store, [harness]);
		const bothEventsObserved = deferred<void>();
		let observedCount = 0;
		manager.subscribe(() => {
			throw new Error(sentinel);
		});
		manager.subscribe(() => {
			observedCount += 1;
			if (observedCount === 2) bothEventsObserved.resolve(undefined);
		});
		const credentialVariable = "HARNESSD_TELEGRAM_BOT_TOKEN";
		const previousCredential = process.env[credentialVariable];
		process.env[credentialVariable] = sentinel;
		try {
			expect(process.env[credentialVariable]).toBe(sentinel);
			await manager.create({
				id: "credential-A",
				harnessId: harness.descriptor.id,
				cwd: workspaceA,
			});
			await manager.create({
				id: "credential-B",
				harnessId: harness.descriptor.id,
				cwd: workspaceB,
			});
			await bothEventsObserved.promise;
			const records = await store.list();
			expect(new Set(records.map(({ cwd }) => cwd))).toEqual(
				new Set([workspaceA, workspaceB]),
			);
			expect(JSON.stringify(records)).not.toContain(sentinel);
			expect(diagnostic.mock.calls).toEqual([
				["[harnessd] Session event observer failed"],
				["[harnessd] Session event observer failed"],
			]);
			expect(await readdir(workspaceA)).toEqual([]);
			expect(await readdir(workspaceB)).toEqual([]);
			expect(await readdir(stateDirectory)).toContain("sessions.sqlite3");
		} finally {
			try {
				await manager.close();
			} finally {
				try {
					store.close();
				} finally {
					diagnostic.mockRestore();
					if (previousCredential === undefined)
						delete process.env[credentialVariable];
					else process.env[credentialVariable] = previousCredential;
				}
			}
		}
	});

	it("keeps another session submit-capable while one exhausts recovery", async () => {
		vi.useFakeTimers();
		const exits = new Map<
			string,
			ReturnType<
				typeof deferred<{ code: number | null; signal: string | null }>
			>
		>();
		const submitted: string[] = [];
		const harness: HarnessAdapter = {
			descriptor: {
				id: "independent" as never,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.resume",
					"input.submit",
				],
			},
			async launch(request) {
				const exit = deferred<{ code: number | null; signal: string | null }>();
				exits.set(request.sessionId, exit);
				return {
					...instance(exit.promise),
					async send(input) {
						submitted.push(`${request.sessionId}:${input.text}`);
					},
				};
			},
			async resume(request) {
				if (request.sessionId === "isolated-failure")
					throw new Error("private resume error");
				return instance();
			},
		};
		const { manager, store, session: healthy } = await setup(harness);
		const failing = await manager.create({
			id: "isolated-failure",
			harnessId: harness.descriptor.id,
			cwd: healthy.cwd,
		});
		exits.get(failing.id)?.resolve({ code: 1, signal: null });
		await flush();
		await manager.submit(healthy.id, "still active");
		await vi.advanceTimersByTimeAsync(250);
		await flush();
		await vi.advanceTimersByTimeAsync(1000);
		await flush();
		await vi.advanceTimersByTimeAsync(4000);
		await flush();
		expect((await store.get(failing.id))?.status).toBe("failed");
		expect((await store.get(healthy.id))?.status).toBe("running");
		await manager.submit(healthy.id, "still active after failure");
		expect(submitted).toEqual([
			`${healthy.id}:still active`,
			`${healthy.id}:still active after failure`,
		]);
		await manager.close();
		store.close();
	});

	it("uses the exact three delays, exhausts the lifetime budget, and marks failed", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		const calls: number[] = [];
		const harness: HarnessAdapter = {
			descriptor: {
				id: "exhaust" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				calls.push(Date.now());
				throw new Error("private failure");
			},
		};
		const { manager, store, session } = await setup(harness);
		const began = Date.now();
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(249);
		expect(calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		await flush();
		await vi.advanceTimersByTimeAsync(999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await flush();
		await vi.advanceTimersByTimeAsync(3999);
		expect(calls).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		await flush();
		expect(calls).toHaveLength(3);
		expect(calls.map((value) => value - began)).toEqual([250, 1250, 5250]);
		expect((await store.get(session.id))?.status).toBe("failed");
		await manager.close();
		store.close();
	});

	it("does not recover without a native ID or resume method", async () => {
		vi.useFakeTimers();
		for (const mode of ["native", "method"] as const) {
			const childExit = deferred<{
				code: number | null;
				signal: string | null;
			}>();
			let resumes = 0;
			const harness: HarnessAdapter = {
				descriptor: {
					id: `missing-${mode}` as never,
					capabilities: ["harness.launch", "harness.stop", "harness.resume"],
				},
				async launch() {
					const value = instance(childExit.promise);
					return mode === "native"
						? { ...value, nativeSessionId: undefined }
						: value;
				},
				...(mode === "native"
					? {
							async resume() {
								resumes++;
								return instance();
							},
						}
					: {}),
			};
			const { manager, store, session } = await setup(harness);
			childExit.resolve({ code: 1, signal: null });
			await flush();
			expect((await store.get(session.id))?.status).toBe("failed");
			expect(resumes).toBe(0);
			await manager.close();
			store.close();
		}
	});

	it("reports uncertain IDs exactly once, never replays the old input, and allows a new explicit input", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		const uncertaintyEvent = deferred<void>();
		let uncertainId: string | undefined;
		const reported: string[] = [];
		const sent: string[] = [];
		let launch = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "inputs" as never,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.resume",
					"input.submit",
				],
			},
			async launch(request) {
				launch++;
				return {
					...instance(launch === 1 ? childExit.promise : neverExit),
					events: (async function* () {
						if (launch === 1) {
							await uncertaintyEvent.promise;
							if (uncertainId)
								yield {
									sessionId: request.sessionId,
									kind: "input" as const,
									inputEvent: {
										inputId: uncertainId as never,
										state: "uncertain" as const,
									},
								};
						}
					})(),
					async send(input) {
						sent.push(input.text);
						if (input.text === "old private prompt")
							throw new UncertainInputDeliveryError(input.id);
					},
				};
			},
			async resume() {
				return {
					...instance(),
					async send(input) {
						sent.push(input.text);
					},
				};
			},
		};
		const { manager, store, session } = await setup(harness);
		manager.subscribe((event) => {
			if (event.kind === "input" && event.inputEvent)
				reported.push(event.inputEvent.inputId);
		});
		try {
			await manager.submit(session.id, "old private prompt");
		} catch (error) {
			if (error instanceof UncertainInputDeliveryError)
				uncertainId = error.inputId;
		}
		expect(uncertainId).toBeDefined();
		uncertaintyEvent.resolve();
		await flush();
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		await flush();
		expect(reported).toEqual([uncertainId]);
		expect(sent).toEqual(["old private prompt"]);
		const nextId = await manager.submit(session.id, "new prompt");
		expect(nextId).not.toBe(uncertainId);
		expect(sent.at(-1)).toBe("new prompt");
		await manager.close();
		store.close();
	});

	it("synthesizes uncertainty once for an unsettled input and never replays it", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		const reported: string[] = [];
		const oldSends: string[] = [];
		const replacementSends: string[] = [];
		const harness: HarnessAdapter = {
			descriptor: {
				id: "synth-uncertain" as never,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.resume",
					"input.submit",
				],
			},
			async launch() {
				return {
					...instance(childExit.promise),
					async send(input) {
						oldSends.push(input.text);
					},
				};
			},
			async resume() {
				return {
					...instance(),
					async send(input) {
						replacementSends.push(input.text);
					},
				};
			},
		};
		const { manager, store, session } = await setup(harness);
		manager.subscribe((event) => {
			if (event.kind === "input" && event.inputEvent)
				reported.push(event.inputEvent.inputId);
		});
		const originalId = await manager.submit(session.id, "must not replay");
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		await flush();
		expect(reported).toEqual([originalId]);
		expect(oldSends).toEqual(["must not replay"]);
		expect(replacementSends).toEqual([]);
		const laterId = await manager.submit(session.id, "explicit new prompt");
		expect(laterId).not.toBe(originalId);
		expect(replacementSends).toEqual(["explicit new prompt"]);
		await manager.close();
		store.close();
	});

	it("removes definitely rejected inputs from uncertainty tracking", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		const events: string[] = [];
		const harness: HarnessAdapter = {
			descriptor: {
				id: "reject" as never,
				capabilities: [
					"harness.launch",
					"harness.stop",
					"harness.resume",
					"input.submit",
				],
			},
			async launch() {
				return {
					...instance(childExit.promise),
					async send() {
						throw new Error("definite reject");
					},
				};
			},
			async resume() {
				return instance();
			},
		};
		const { manager, store, session } = await setup(harness);
		manager.subscribe((event) => {
			if (event.kind === "input") events.push("uncertain");
		});
		await expect(manager.submit(session.id, "not accepted")).rejects.toThrow(
			"definite reject",
		);
		childExit.resolve({ code: 1, signal: null });
		await flush();
		expect(events).toEqual([]);
		await manager.close();
		store.close();
	});

	it("joins delayed recovery failure finalization before writing terminal stopped status", async () => {
		vi.useFakeTimers();
		const directory = await mkdtemp(path.join(os.tmpdir(), "watchdog-test-"));
		directories.push(directory);
		const base = await SqliteSessionStore.open(directory);
		const failureWriteStarted = deferred<void>();
		const releaseFailureWrite = deferred<void>();
		const statusWrites: string[] = [];
		let startingWrites = 0;
		const store: SessionStore = {
			create: base.create.bind(base),
			list: base.list.bind(base),
			get: base.get.bind(base),
			delete: base.delete.bind(base),
			update: base.update.bind(base),
			setName: base.setName.bind(base),
			async setStatus(id, status) {
				if (status === "starting" && ++startingWrites === 2)
					throw new Error("starting status failed");
				if (status === "failed") {
					failureWriteStarted.resolve();
					await releaseFailureWrite.promise;
				}
				await base.setStatus(id, status);
				statusWrites.push(status);
			},
		};
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		let resumes = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "finalizer" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				resumes++;
				return instance();
			},
		};
		const manager = new SessionManager(store, [harness]);
		const session = await manager.create({
			harnessId: harness.descriptor.id,
			cwd: directory,
		});
		const statuses: string[] = [];
		manager.subscribe((event) => {
			if (event.text) statuses.push(event.text);
		});
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		await failureWriteStarted.promise;
		const stopping = manager.stop(session.id);
		await flush();
		expect((await base.get(session.id))?.status).not.toBe("stopped");
		releaseFailureWrite.resolve();
		await expect(stopping).rejects.toThrow("shutdown was incomplete");
		expect(resumes).toBe(0);
		expect((await base.get(session.id))?.status).toBe("stopped");
		expect(statusWrites.slice(-2)).toEqual(["failed", "stopped"]);
		expect(statuses).not.toContain("harness_recovery_failed");
		await manager.close();
		base.close();
	});

	it("notifies safe recovery failure when failed-status persistence also rejects", async () => {
		vi.useFakeTimers();
		const directory = await mkdtemp(path.join(os.tmpdir(), "watchdog-test-"));
		directories.push(directory);
		const base = await SqliteSessionStore.open(directory);
		let rejectStatusWrites = false;
		const store: SessionStore = {
			create: base.create.bind(base),
			list: base.list.bind(base),
			get: base.get.bind(base),
			delete: base.delete.bind(base),
			update: base.update.bind(base),
			setName: base.setName.bind(base),
			async setStatus(id, status) {
				if (rejectStatusWrites)
					throw new Error("PRIVATE status persistence failure");
				await base.setStatus(id, status);
			},
		};
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		let resumes = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "failure-notification" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				resumes++;
				throw new Error("PRIVATE resume failure");
			},
		};
		const manager = new SessionManager(store, [harness]);
		const session = await manager.create({
			harnessId: harness.descriptor.id,
			cwd: directory,
		});
		const received: import("../src/core/types.js").HarnessEvent[] = [];
		manager.subscribe((event) => received.push(event));
		rejectStatusWrites = true;
		childExit.resolve({ code: 1, signal: null });
		await flush();
		// Starting persistence fails before a resume attempt; the failure finalizer also cannot persist.
		await flush();
		const terminalFailures = received.filter(
			(event) =>
				event.kind === "status" && event.text === "harness_recovery_failed",
		);
		expect(terminalFailures).toHaveLength(1);
		expect(terminalFailures[0]).toMatchObject({
			sessionId: session.id,
			kind: "status",
			text: "harness_recovery_failed",
		});
		expect(JSON.stringify(received)).not.toContain("PRIVATE");
		expect(resumes).toBe(0);
		expect((await manager.get(session.id)).status).toBe("running");
		rejectStatusWrites = false;
		await expect(manager.stop(session.id)).rejects.toThrow(
			"shutdown was incomplete",
		);
		expect((await manager.get(session.id)).status).toBe("stopped");
		await manager.close();
		base.close();
	});

	it("does not call resume when stop or close wins during pre-resume status persistence", async () => {
		vi.useFakeTimers();
		for (const action of ["stop", "close"] as const) {
			const directory = await mkdtemp(path.join(os.tmpdir(), "watchdog-test-"));
			directories.push(directory);
			const base = await SqliteSessionStore.open(directory);
			const statusPending = deferred<void>();
			const releaseStatus = deferred<void>();
			let startingWrites = 0;
			const store: SessionStore = {
				create: base.create.bind(base),
				list: base.list.bind(base),
				get: base.get.bind(base),
				delete: base.delete.bind(base),
				update: base.update.bind(base),
				setName: base.setName.bind(base),
				async setStatus(id, status) {
					if (status === "starting" && ++startingWrites === 2) {
						statusPending.resolve();
						await releaseStatus.promise;
					}
					await base.setStatus(id, status);
				},
			};
			const childExit = deferred<{
				code: number | null;
				signal: string | null;
			}>();
			let resumes = 0;
			const harness: HarnessAdapter = {
				descriptor: {
					id: `pre-resume-${action}` as never,
					capabilities: ["harness.launch", "harness.stop", "harness.resume"],
				},
				async launch() {
					return instance(childExit.promise);
				},
				async resume() {
					resumes++;
					return instance();
				},
			};
			const manager = new SessionManager(store, [harness]);
			const session = await manager.create({
				harnessId: harness.descriptor.id,
				cwd: directory,
			});
			childExit.resolve({ code: 1, signal: null });
			await flush();
			await vi.advanceTimersByTimeAsync(250);
			await statusPending.promise;
			const terminal =
				action === "stop" ? manager.stop(session.id) : manager.close();
			releaseStatus.resolve();
			await terminal;
			expect(resumes).toBe(0);
			expect((await base.get(session.id))?.status).toBe("stopped");
			if (action === "stop") await manager.close();
			base.close();
		}
	});

	it("cancels pending backoff when stopped", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		let resumeCalls = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "stop-race" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				resumeCalls++;
				return instance();
			},
		};
		const { manager, store, session } = await setup(harness);
		childExit.resolve({ code: 1, signal: null });
		await flush();
		const stopping = manager.stop(session.id);
		await stopping;
		await vi.advanceTimersByTimeAsync(1000);
		expect(resumeCalls).toBe(0);
		expect((await store.get(session.id))?.status).toBe("stopped");
		await manager.close();
		store.close();
	});

	it("waits for a resume race and shuts down the returned instance", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		const resumeResult = deferred<HarnessInstance>();
		let shutdowns = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "inflight-stop" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				return resumeResult.promise;
			},
		};
		const { manager, store, session } = await setup(harness);
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		await flush();
		const stopping = manager.stop(session.id);
		resumeResult.resolve({
			...instance(),
			async shutdown() {
				shutdowns++;
			},
		});
		await stopping;
		expect(shutdowns).toBe(1);
		expect((await store.get(session.id))?.status).toBe("stopped");
		await manager.close();
		store.close();
	});

	it("does not terminalize a nonexistent ID and can later recover that ID", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		let resumes = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "unknown-stop" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				resumes++;
				return instance();
			},
		};
		const directory = await mkdtemp(path.join(os.tmpdir(), "watchdog-test-"));
		directories.push(directory);
		const store = await SqliteSessionStore.open(directory);
		const manager = new SessionManager(store, [harness]);
		await expect(manager.stop("reuse-id" as SessionId)).rejects.toThrow();
		const session = await manager.create({
			id: "reuse-id",
			harnessId: harness.descriptor.id,
			cwd: directory,
		});
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		await flush();
		expect(resumes).toBe(1);
		await manager.close();
		store.close();
		void session;
	});

	it("isolates manager close to recovery and closes a late resumed child", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		let resumes = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "close-recovery" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				resumes++;
				return instance();
			},
		};
		const { manager, store, session } = await setup(harness);
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await manager.close();
		expect(resumes).toBe(0);
		expect((await store.get(session.id))?.status).toBe("stopped");
		store.close();
	});

	it("ignores an exit that arrives after intentional stop", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		let resumes = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "stale-exit" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				resumes++;
				return instance();
			},
		};
		const { manager, store, session } = await setup(harness);
		await manager.stop(session.id);
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(5000);
		expect(resumes).toBe(0);
		expect((await store.get(session.id))?.status).toBe("stopped");
		await manager.close();
		store.close();
	});

	it("ignores a late exit from a superseded instance", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		let resumes = 0;
		let shutdowns = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "superseded" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				resumes++;
				return instance();
			},
		};
		const { manager, store, session } = await setup(harness);
		const replacement = {
			...instance(),
			async shutdown() {
				shutdowns++;
			},
		};
		(
			manager as unknown as { instances: Map<SessionId, HarnessInstance> }
		).instances.set(session.id, replacement);
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(5000);
		expect(resumes).toBe(0);
		await manager.close();
		expect(shutdowns).toBe(1);
		store.close();
	});

	it("keeps a replacement owned and surfaces repeated shutdown failure for retry", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		const resumeResult = deferred<HarnessInstance>();
		let shutdowns = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "shutdown-failure" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				return resumeResult.promise;
			},
		};
		const { manager, store, session } = await setup(harness);
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		await flush();
		const stopping = manager.stop(session.id);
		resumeResult.resolve({
			...instance(),
			async shutdown() {
				shutdowns++;
				if (shutdowns <= 2) throw new Error("cleanup failed");
			},
		});
		await expect(stopping).rejects.toThrow("shutdown was incomplete");
		expect(shutdowns).toBe(2);
		expect((await store.get(session.id))?.status).not.toBe("stopped");
		await manager.stop(session.id);
		expect(shutdowns).toBe(3);
		expect((await store.get(session.id))?.status).toBe("stopped");
		await manager.close();
		store.close();
	});

	it("shuts down a replacement when recovery status persistence fails", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		let shutdowns = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "persist-failure" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				return {
					...instance(),
					async shutdown() {
						shutdowns++;
					},
				};
			},
		};
		const directory = await mkdtemp(path.join(os.tmpdir(), "watchdog-test-"));
		directories.push(directory);
		const base = await SqliteSessionStore.open(directory);
		let failRunning = false;
		const store = {
			create: base.create.bind(base),
			list: base.list.bind(base),
			get: base.get.bind(base),
			delete: base.delete.bind(base),
			update: base.update.bind(base),
			setName: base.setName.bind(base),
			async setStatus(
				id: SessionId,
				status: import("../src/core/types.js").SessionStatus,
			) {
				if (status === "running" && failRunning) {
					failRunning = false;
					throw new Error("store failure");
				}
				await base.setStatus(id, status);
			},
		};
		const manager = new SessionManager(store, [harness]);
		const session = await manager.create({
			harnessId: harness.descriptor.id,
			cwd: directory,
		});
		failRunning = true;
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		await flush();
		expect(shutdowns).toBe(1);
		expect((await base.get(session.id))?.status).toBe("failed");
		await manager.close();
		base.close();
	});

	it("closes manager during an in-flight resume and shuts down the late instance", async () => {
		vi.useFakeTimers();
		const childExit = deferred<{
			code: number | null;
			signal: string | null;
		}>();
		const resumeResult = deferred<HarnessInstance>();
		let shutdowns = 0;
		const harness: HarnessAdapter = {
			descriptor: {
				id: "close-inflight" as never,
				capabilities: ["harness.launch", "harness.stop", "harness.resume"],
			},
			async launch() {
				return instance(childExit.promise);
			},
			async resume() {
				return resumeResult.promise;
			},
		};
		const { manager, store, session } = await setup(harness);
		childExit.resolve({ code: 1, signal: null });
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		await flush();
		const closing = manager.close();
		resumeResult.resolve({
			...instance(),
			async shutdown() {
				shutdowns++;
			},
		});
		await closing;
		expect(shutdowns).toBe(1);
		expect((await store.get(session.id))?.status).toBe("stopped");
		store.close();
	});
});
