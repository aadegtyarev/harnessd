import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { validateAdapterOptions } from "./adapter-options.js";
import { InvalidStateDirectoryError, SessionStoreError } from "./errors.js";
import type {
	AdapterId,
	SessionId,
	SessionStatus,
	SessionSummary,
} from "./types.js";

export interface SessionStore {
	create(session: SessionSummary): Promise<void>;
	list(): Promise<readonly SessionSummary[]>;
	get(id: SessionId): Promise<SessionSummary | undefined>;
	delete(id: SessionId): Promise<boolean>;
	setStatus(id: SessionId, status: SessionStatus): Promise<void>;
	setName(id: SessionId, name?: string): Promise<void>;
	update(session: SessionSummary): Promise<void>;
}

export function resolveStateDirectory(configuredPath?: string): string {
	if (configuredPath !== undefined)
		return requireAbsoluteStateDirectory(configuredPath, "configured path");
	if (process.env.HARNESSD_STATE_DIR)
		return requireAbsoluteStateDirectory(
			process.env.HARNESSD_STATE_DIR,
			"HARNESSD_STATE_DIR",
		);
	const xdgStateHome = process.env.XDG_STATE_HOME;
	const stateHome = xdgStateHome
		? requireAbsoluteStateDirectory(xdgStateHome, "XDG_STATE_HOME")
		: path.join(os.homedir(), ".local", "state");
	return path.join(stateHome, "harnessd");
}

function requireAbsoluteStateDirectory(value: string, source: string): string {
	return validateStateDirectoryPath(value, source);
}

export function validateStateDirectoryPath(
	value: string,
	source: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	const isFullyQualifiedWindowsPath =
		platform !== "win32" ||
		/^[A-Za-z]:[\\/]/.test(value) ||
		/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value) ||
		/^\\\\\?\\[A-Za-z]:[\\/]/i.test(value) ||
		/^\\\\\?\\UNC\\[^\\/]+\\[^\\/]+(?:\\|$)/i.test(value);
	if (!pathApi.isAbsolute(value) || !isFullyQualifiedWindowsPath) {
		const requirement =
			platform === "win32"
				? "a fully qualified Windows drive or UNC path"
				: "an absolute path";
		throw new InvalidStateDirectoryError(
			value,
			`${source} must be ${requirement}; state paths cannot depend on process cwd`,
		);
	}
	return pathApi.normalize(value);
}

async function assertPrivateStateDirectory(directory: string): Promise<void> {
	const metadata = await stat(directory);
	if (!metadata.isDirectory()) {
		throw new InvalidStateDirectoryError(
			directory,
			`Supervisor state path is not a directory: ${directory}`,
		);
	}
	if (process.platform === "win32") return;
	if (
		typeof process.getuid === "function" &&
		metadata.uid !== process.getuid()
	) {
		throw new InvalidStateDirectoryError(
			directory,
			`Supervisor state directory must be owned by the current user: ${directory}`,
		);
	}
	if ((metadata.mode & 0o077) !== 0) {
		throw new InvalidStateDirectoryError(
			directory,
			`Supervisor state directory must not grant group/other access; secure it to mode 0700: ${directory}`,
		);
	}
}

export class SqliteSessionStore implements SessionStore {
	readonly stateDirectory: string;
	readonly databasePath: string;
	private readonly database: Database.Database;

	private constructor(stateDirectory: string, database: Database.Database) {
		this.stateDirectory = stateDirectory;
		this.databasePath = path.join(stateDirectory, "sessions.sqlite3");
		this.database = database;
	}

	static async open(configuredPath?: string): Promise<SqliteSessionStore> {
		const stateDirectory = resolveStateDirectory(configuredPath);
		let database: Database.Database | undefined;
		try {
			await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
			await assertPrivateStateDirectory(stateDirectory);
			const databasePath = path.join(stateDirectory, "sessions.sqlite3");
			database = new Database(databasePath);
			database.pragma("journal_mode = WAL");
			database.pragma("foreign_keys = ON");
			database.exec(`CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				harness_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				native_session_id TEXT,
				status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopped', 'failed', 'uncertain')),
				name TEXT,
				adapter_options TEXT,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`);
			const columns = database.pragma("table_info(sessions)") as {
				name: string;
			}[];
			if (!columns.some((column) => column.name === "name"))
				database.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
			if (!columns.some((column) => column.name === "adapter_options"))
				database.exec("ALTER TABLE sessions ADD COLUMN adapter_options TEXT");
			return new SqliteSessionStore(stateDirectory, database);
		} catch (error) {
			try {
				database?.close();
			} catch {
				// Preserve the initialization error that prevented a store from opening.
			}
			if (error instanceof InvalidStateDirectoryError) throw error;
			throw new SessionStoreError(
				`Could not open session store at ${stateDirectory}`,
				{ cause: error },
			);
		}
	}

	async create(session: SessionSummary): Promise<void> {
		try {
			const adapterOptions = session.adapterOptions
				? JSON.stringify(validateAdapterOptions(session.adapterOptions))
				: null;
			this.database
				.prepare(`INSERT INTO sessions (id, harness_id, cwd, native_session_id, status, name, adapter_options)
				VALUES (?, ?, ?, ?, ?, ?, ?)`)
				.run(
					session.id,
					session.harnessId,
					session.cwd,
					session.nativeSessionId ?? null,
					session.status,
					session.name ?? null,
					adapterOptions,
				);
		} catch (error) {
			throw new SessionStoreError(`Could not persist session '${session.id}'`, {
				cause: error,
			});
		}
	}

	async list(): Promise<readonly SessionSummary[]> {
		try {
			const rows = this.database
				.prepare(
					"SELECT id, harness_id, cwd, native_session_id, status, name, adapter_options FROM sessions ORDER BY created_at, id",
				)
				.all() as SessionRow[];
			return rows.map(fromRow);
		} catch (error) {
			throw new SessionStoreError("Could not list sessions", { cause: error });
		}
	}

	async get(id: SessionId): Promise<SessionSummary | undefined> {
		try {
			const row = this.database
				.prepare(
					"SELECT id, harness_id, cwd, native_session_id, status, name, adapter_options FROM sessions WHERE id = ?",
				)
				.get(id) as SessionRow | undefined;
			return row ? fromRow(row) : undefined;
		} catch (error) {
			throw new SessionStoreError(`Could not load session '${id}'`, {
				cause: error,
			});
		}
	}

	async delete(id: SessionId): Promise<boolean> {
		try {
			const result = this.database
				.prepare("DELETE FROM sessions WHERE id = ?")
				.run(id);
			return result.changes === 1;
		} catch (error) {
			throw new SessionStoreError(`Could not delete session '${id}'`, {
				cause: error,
			});
		}
	}

	async setName(id: SessionId, name?: string): Promise<void> {
		try {
			const result = this.database
				.prepare("UPDATE sessions SET name = ? WHERE id = ?")
				.run(name ?? null, id);
			if (result.changes !== 1)
				throw new Error("session record does not exist");
		} catch (error) {
			throw new SessionStoreError(`Could not rename session '${id}'`, {
				cause: error,
			});
		}
	}

	async update(session: SessionSummary): Promise<void> {
		try {
			const result = this.database
				.prepare(
					"UPDATE sessions SET native_session_id = ?, status = ? WHERE id = ?",
				)
				.run(session.nativeSessionId ?? null, session.status, session.id);
			if (result.changes !== 1)
				throw new Error("session record does not exist");
		} catch (error) {
			throw new SessionStoreError(`Could not update session '${session.id}'`, {
				cause: error,
			});
		}
	}

	async setStatus(id: SessionId, status: SessionStatus): Promise<void> {
		try {
			const result = this.database
				.prepare("UPDATE sessions SET status = ? WHERE id = ?")
				.run(status, id);
			if (result.changes !== 1)
				throw new Error("session record does not exist");
		} catch (error) {
			throw new SessionStoreError(`Could not update session '${id}'`, {
				cause: error,
			});
		}
	}

	close(): void {
		try {
			this.database.close();
		} catch (error) {
			throw new SessionStoreError("Could not close session store", {
				cause: error,
			});
		}
	}
}

interface SessionRow {
	id: string;
	harness_id: string;
	cwd: string;
	native_session_id: string | null;
	status: SessionStatus;
	name: string | null;
	adapter_options: string | null;
}

function fromRow(row: SessionRow): SessionSummary {
	return {
		id: row.id as SessionId,
		...(row.name === null ? {} : { name: row.name }),
		...(row.adapter_options === null
			? {}
			: {
					adapterOptions: validateAdapterOptions(
						JSON.parse(row.adapter_options),
					),
				}),
		harnessId: row.harness_id as AdapterId,
		cwd: row.cwd,
		...(row.native_session_id === null
			? {}
			: { nativeSessionId: row.native_session_id }),
		status: row.status,
	};
}
