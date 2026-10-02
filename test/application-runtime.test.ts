import { mkdtemp, rm } from "node:fs/promises";
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
import { UncertainInputDeliveryError } from "../src/harness/pi-rpc-harness.js";

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
	it("returns correlated typed results and rejects dispatch once closing starts", async () => {
		let dispatch!: RuntimeDispatch;
		const sent: string[] = [];
		const harness: HarnessAdapter = {
			descriptor: {
				id: "mock" as never,
				capabilities: ["harness.launch", "harness.stop", "input.submit"],
			},
			async launch() {
				return {
					processId: "proc" as never,
					exit: new Promise(() => {}),
					events: (async function* () {})(),
					async send(input) {
						if (input.text === "uncertain private prompt")
							throw new UncertainInputDeliveryError(input.id);
						if (input.text === "sensitive failure")
							throw Object.assign(new Error("private detail"), {
								code: "SECRET_PRIVATE_DETAIL",
							});
						sent.push(input.text);
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
				message: "Working directory is invalid or inaccessible",
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
		const input = await dispatch({
			requestId: "request-submit",
			principalId: "operator",
			kind: "submit",
			sessionId: created.value.id,
			text: "hello",
		});
		expect(input).toMatchObject({ requestId: "request-submit", ok: true });
		if (!input.ok || typeof input.value !== "string")
			throw new Error("submit result missing input ID");
		expect(sent).toEqual(["hello"]);
		const safeFailure = await dispatch({
			requestId: "request-sensitive",
			principalId: "operator",
			kind: "submit",
			sessionId: created.value.id,
			text: "sensitive failure",
		});
		expect(safeFailure).toEqual({
			requestId: "request-sensitive",
			ok: false,
			error: { code: "OPERATION_FAILED", message: "Operation failed" },
		});
		expect(JSON.stringify(safeFailure)).not.toContain("private detail");
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
				message: "Input delivery is uncertain",
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
