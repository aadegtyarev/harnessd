import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import {
	DuplicateAdapterIdError,
	DuplicateSessionIdError,
	InvalidWorkingDirectoryError,
	requireCapability,
	SessionNotFoundError,
	UnsupportedCapabilityError,
} from "./errors.js";
import type { HarnessAdapter, HarnessInstance } from "./ports.js";
import type { SessionStore } from "./session-store.js";
import type { AdapterId, Input, SessionId, SessionSummary } from "./types.js";

export interface CreateSessionRequest {
	readonly harnessId: AdapterId;
	readonly cwd: string;
	readonly id?: string;
}

export class SessionManager {
	private readonly harnesses: ReadonlyMap<AdapterId, HarnessAdapter>;
	private readonly instances = new Map<SessionId, HarnessInstance>();

	constructor(
		private readonly store: SessionStore,
		harnesses: readonly HarnessAdapter[],
	) {
		const registered = new Map<AdapterId, HarnessAdapter>();
		for (const harness of harnesses) {
			const id = harness.descriptor.id;
			if (registered.has(id)) throw new DuplicateAdapterIdError(id);
			registered.set(id, harness);
		}
		this.harnesses = registered;
	}

	list(): Promise<readonly SessionSummary[]> {
		return this.store.list();
	}

	async get(id: SessionId): Promise<SessionSummary> {
		const session = await this.store.get(id);
		if (!session) throw new SessionNotFoundError(id);
		return session;
	}

	async create(request: CreateSessionRequest): Promise<SessionSummary> {
		const id = parseSessionId(request.id ?? randomUUID());
		if (await this.store.get(id)) throw new DuplicateSessionIdError(id);
		const harness = this.harnesses.get(request.harnessId);
		if (!harness)
			throw new UnsupportedCapabilityError("harness.launch", request.harnessId);
		requireCapability(
			harness.descriptor.capabilities,
			"harness.launch",
			harness.descriptor.id,
		);
		const cwd = await validateWorkingDirectory(request.cwd);
		const starting: SessionSummary = {
			id,
			harnessId: request.harnessId,
			cwd,
			status: "starting",
		};
		await this.store.create(starting);
		let instance: HarnessInstance | undefined;
		try {
			instance = await harness.launch({ sessionId: id, cwd });
			const running: SessionSummary = {
				...starting,
				...(instance.nativeSessionId
					? { nativeSessionId: instance.nativeSessionId }
					: {}),
				status: "running",
			};
			await this.store.update(running);
			this.instances.set(id, instance);
			return running;
		} catch (error) {
			if (instance) await instance.shutdown().catch(() => undefined);
			await this.store.setStatus(id, "failed");
			throw error;
		}
	}

	async stop(id: SessionId): Promise<void> {
		const session = await this.get(id);
		if (session.status === "stopped") return;
		const instance = this.instances.get(id);
		if (instance) {
			const harness = this.harnesses.get(session.harnessId);
			if (!harness)
				throw new UnsupportedCapabilityError("harness.stop", session.harnessId);
			requireCapability(
				harness.descriptor.capabilities,
				"harness.stop",
				harness.descriptor.id,
			);
			await instance.shutdown();
			this.instances.delete(id);
		}
		await this.store.setStatus(id, "stopped");
	}

	async submit(id: SessionId, text: string): Promise<void> {
		const session = await this.get(id);
		const harness = this.harnesses.get(session.harnessId);
		if (!harness)
			throw new UnsupportedCapabilityError("input.submit", session.harnessId);
		requireCapability(
			harness.descriptor.capabilities,
			"input.submit",
			harness.descriptor.id,
		);
		const instance = this.instances.get(id);
		if (!instance || session.status !== "running")
			throw new SessionNotFoundError(id);
		const input: Input = {
			id: randomUUID() as Input["id"],
			sessionId: id,
			text,
			createdAt: new Date(),
		};
		await instance.send(input);
	}
}

function parseSessionId(value: string): SessionId {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
		throw new TypeError(`Invalid session ID: ${value}`);
	}
	return value as SessionId;
}

async function validateWorkingDirectory(
	requestedPath: string,
): Promise<string> {
	try {
		const canonicalPath = await realpath(requestedPath);
		const metadata = await stat(canonicalPath);
		if (!metadata.isDirectory()) throw new Error("not a directory");
		await access(canonicalPath, constants.R_OK | constants.X_OK);
		return canonicalPath;
	} catch (error) {
		throw new InvalidWorkingDirectoryError(requestedPath, { cause: error });
	}
}
