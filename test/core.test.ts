import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	AdapterId,
	HarnessAdapter,
	HarnessInstance,
	SessionId,
	SessionPort,
	TransportAdapter,
	TransportEvent,
} from "../src/core/index.js";
import {
	DuplicateAdapterIdError,
	InvalidWorkingDirectoryError,
	requireCapability,
	SessionManager,
	SqliteSessionStore,
	UnsupportedCapabilityError,
} from "../src/core/index.js";

const tempDirectories: string[] = [];
async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "harnessd-test-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
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
		await manager.submit(session.id, "addressed input");
		expect(submitted).toEqual(["addressed input"]);
		await manager.stop(session.id);
		expect((await manager.get(session.id)).status).toBe("stopped");
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
