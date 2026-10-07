import { randomBytes } from "node:crypto";
import {
	link,
	lstat,
	mkdir,
	readdir,
	realpath,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { SessionId, SessionStatus, SessionSummary } from "./core/types.js";
import { safeAttachmentName } from "./telegram-filesystem.js";

export const TELEGRAM_INBOX_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_INBOX_MAX_FILES_PER_SESSION = 10;
export const TELEGRAM_INBOX_MAX_BYTES_PER_SESSION = 100 * 1024 * 1024;
export const TELEGRAM_INBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FILE_NAME_PATTERN = /^(\d{13})-([a-f0-9]{16})-(.+)$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class TelegramInboxQuotaError extends Error {
	constructor() {
		super("Telegram inbox quota exceeded");
		this.name = "TelegramInboxQuotaError";
	}
}

export class TelegramInboxError extends Error {
	constructor(options?: ErrorOptions) {
		super("Telegram inbox operation failed", options);
		this.name = "TelegramInboxError";
	}
}

export interface SavedTelegramAttachment {
	readonly path: string;
	readonly name: string;
	readonly bytes: number;
}

export class TelegramInbox {
	readonly rootDirectory: string;
	private readonly locks = new Map<string, Promise<void>>();

	constructor(
		stateDirectory: string,
		private readonly now: () => number = Date.now,
	) {
		this.rootDirectory = path.join(stateDirectory, "inbox");
	}

	async withSessionLock<T>(
		sessionId: SessionId,
		operation: () => Promise<T>,
	): Promise<T> {
		this.validateSessionId(sessionId);
		const key = String(sessionId);
		const previous = this.locks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.locks.set(key, current);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.locks.get(key) === current) this.locks.delete(key);
		}
	}

	async save(
		sessionId: SessionId,
		originalName: string,
		data: Buffer,
		removeExpired = false,
		workspacePath?: string,
	): Promise<SavedTelegramAttachment> {
		return this.withSessionLock(sessionId, () =>
			this.saveUnderLock(
				sessionId,
				originalName,
				data,
				removeExpired,
				workspacePath,
			),
		);
	}

	async saveUnderLock(
		sessionId: SessionId,
		originalName: string,
		data: Buffer,
		removeExpired = false,
		workspacePath?: string,
	): Promise<SavedTelegramAttachment> {
		this.validateSessionId(sessionId);
		if (!data.length || data.length > TELEGRAM_INBOX_MAX_FILE_BYTES)
			throw new TelegramInboxError();
		try {
			if (workspacePath)
				await this.assertOutsideWorkspace(workspacePath, sessionId);
			const directory = await this.ensureSessionDirectory(sessionId);
			if (removeExpired) await this.removeExpiredFiles(directory);
			const existing = await this.readFiles(directory);
			if (
				existing.length >= TELEGRAM_INBOX_MAX_FILES_PER_SESSION ||
				existing.reduce((total, item) => total + item.size, 0) + data.length >
					TELEGRAM_INBOX_MAX_BYTES_PER_SESSION
			)
				throw new TelegramInboxQuotaError();

			const name = safeAttachmentName(originalName);
			const filename = `${String(this.now()).padStart(13, "0")}-${randomBytes(8).toString("hex")}-${name}`;
			const target = path.join(directory, filename);
			const temporary = `${target}.part`;
			try {
				await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
				await link(temporary, target);
				await unlink(temporary);
			} catch (error) {
				await unlink(target).catch(() => {});
				await unlink(temporary).catch(() => {});
				throw error;
			}

			const canonicalDirectory = await realpath(directory);
			const canonicalFile = await realpath(target);
			if (path.dirname(canonicalFile) !== canonicalDirectory) {
				await unlink(target).catch(() => {});
				throw new Error("Inbox path validation failed");
			}
			return { path: canonicalFile, name, bytes: data.length };
		} catch (error) {
			if (error instanceof TelegramInboxQuotaError) throw error;
			throw new TelegramInboxError({ cause: error });
		}
	}

	async removeSavedAttachmentUnderLock(
		sessionId: SessionId,
		savedPath: string,
	): Promise<void> {
		this.validateSessionId(sessionId);
		try {
			const directory = await realpath(
				path.join(this.rootDirectory, sessionId),
			);
			const canonicalFile = await realpath(savedPath);
			if (
				path.dirname(canonicalFile) !== directory ||
				!FILE_NAME_PATTERN.test(path.basename(canonicalFile))
			)
				throw new Error("Saved attachment path validation failed");
			const info = await lstat(savedPath);
			if (info.isSymbolicLink() || !info.isFile())
				throw new Error("Saved attachment is not a regular file");
			await unlink(canonicalFile);
		} catch (error) {
			if (isCode(error, "ENOENT")) return;
			throw new TelegramInboxError({ cause: error });
		}
	}

	async removeSession(sessionId: SessionId): Promise<void> {
		await this.withSessionLock(sessionId, () =>
			this.removeSessionUnderLock(sessionId),
		);
	}

	async removeSessionUnderLock(sessionId: SessionId): Promise<void> {
		this.validateSessionId(sessionId);
		const directory = path.join(this.rootDirectory, sessionId);
		try {
			await this.assertInboxRoot();
			const info = await lstat(directory);
			if (info.isSymbolicLink()) {
				await unlink(directory);
				return;
			}
			if (!info.isDirectory())
				throw new Error("Inbox entry is not a directory");
			await rm(directory, { recursive: true });
		} catch (error) {
			if (isCode(error, "ENOENT")) return;
			throw new TelegramInboxError({ cause: error });
		}
	}

	async sweep(
		sessions: readonly SessionSummary[],
		getCurrentSessions?: () => Promise<readonly SessionSummary[]>,
	): Promise<void> {
		let entries: import("node:fs").Dirent[];
		try {
			await this.assertInboxRoot();
			entries = await readdir(this.rootDirectory, { withFileTypes: true });
		} catch (error) {
			if (isCode(error, "ENOENT")) return;
			throw new TelegramInboxError({ cause: error });
		}
		const byId = new Map(sessions.map((session) => [session.id, session]));
		for (const entry of entries) {
			if (!SESSION_ID_PATTERN.test(entry.name)) continue;
			const sessionId = entry.name as SessionId;
			const snapshotSession = byId.get(sessionId);
			if (snapshotSession && !isTerminal(snapshotSession.status)) continue;
			await this.withSessionLock(sessionId, async () => {
				const currentSessions = getCurrentSessions
					? await getCurrentSessions()
					: sessions;
				const currentSession = currentSessions.find(
					(candidate) => candidate.id === sessionId,
				);
				if (currentSession && !isTerminal(currentSession.status)) return;
				if (!currentSession) {
					await this.removeSessionUnderLock(sessionId);
					return;
				}
				const directory = await this.sessionDirectoryIfPresent(sessionId);
				if (directory) await this.removeExpiredFiles(directory);
			});
		}
	}

	private async assertOutsideWorkspace(
		workspacePath: string,
		sessionId: SessionId,
	): Promise<void> {
		const canonicalWorkspace = await realpath(workspacePath);
		let inboxRoot: string;
		try {
			inboxRoot = await realpath(this.rootDirectory);
		} catch (error) {
			if (!isCode(error, "ENOENT")) throw error;
			const canonicalParent = await realpath(path.dirname(this.rootDirectory));
			inboxRoot = path.join(canonicalParent, path.basename(this.rootDirectory));
		}
		const sessionInbox = path.join(inboxRoot, sessionId);
		const relative = path.relative(canonicalWorkspace, sessionInbox);
		if (
			!relative ||
			(relative !== ".." &&
				!relative.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relative))
		)
			throw new Error("Inbox cannot be inside the session workspace");
	}

	private async ensureSessionDirectory(sessionId: SessionId): Promise<string> {
		await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
		await this.assertInboxRoot();
		const directory = path.join(this.rootDirectory, sessionId);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const info = await lstat(directory);
		if (info.isSymbolicLink() || !info.isDirectory())
			throw new Error("Unsafe inbox directory");
		if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
			throw new Error("Inbox directory is not private");
		return directory;
	}

	private async assertInboxRoot(): Promise<void> {
		const info = await lstat(this.rootDirectory);
		if (info.isSymbolicLink() || !info.isDirectory())
			throw new Error("Unsafe inbox root");
		if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
			throw new Error("Inbox root is not private");
	}

	private async sessionDirectoryIfPresent(
		sessionId: SessionId,
	): Promise<string | undefined> {
		const directory = path.join(this.rootDirectory, sessionId);
		try {
			const info = await lstat(directory);
			if (info.isSymbolicLink()) {
				await unlink(directory);
				return undefined;
			}
			if (!info.isDirectory()) throw new Error("Unsafe inbox entry");
			return directory;
		} catch (error) {
			if (isCode(error, "ENOENT")) return undefined;
			throw error;
		}
	}

	private async readFiles(
		directory: string,
	): Promise<{ readonly path: string; readonly size: number }[]> {
		const entries = await readdir(directory, { withFileTypes: true });
		const files: { path: string; size: number }[] = [];
		for (const entry of entries) {
			const filePath = path.join(directory, entry.name);
			const info = await lstat(filePath);
			if (info.isSymbolicLink() || !info.isFile())
				throw new Error("Unsafe inbox file");
			files.push({ path: filePath, size: info.size });
		}
		return files;
	}

	private async removeExpiredFiles(directory: string): Promise<void> {
		for (const file of await this.readFiles(directory)) {
			const filename = path.basename(file.path);
			if (filename.endsWith(".part")) {
				await unlink(file.path);
				continue;
			}
			const match = FILE_NAME_PATTERN.exec(filename);
			if (!match) continue;
			const receivedAt = Number(match[1]);
			if (this.now() - receivedAt >= TELEGRAM_INBOX_TTL_MS)
				await unlink(file.path);
		}
	}

	private validateSessionId(sessionId: SessionId): void {
		if (!SESSION_ID_PATTERN.test(sessionId)) throw new TelegramInboxError();
	}
}

function isTerminal(status: SessionStatus): boolean {
	return status === "stopped" || status === "failed";
}

function isCode(error: unknown, code: string): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === code
	);
}
