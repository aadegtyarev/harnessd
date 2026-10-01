import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SessionStoreError } from "./errors.js";
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
	setStatus(id: SessionId, status: SessionStatus): Promise<void>;
	update(session: SessionSummary): Promise<void>;
}

export function resolveStateDirectory(configuredPath?: string): string {
	if (configuredPath) return path.resolve(configuredPath);
	if (process.env.HARNESSD_STATE_DIR)
		return path.resolve(process.env.HARNESSD_STATE_DIR);
	const xdgStateHome = process.env.XDG_STATE_HOME;
	return path.join(
		xdgStateHome
			? path.resolve(xdgStateHome)
			: path.join(os.homedir(), ".local", "state"),
		"harnessd",
	);
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
		try {
			await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
			const databasePath = path.join(stateDirectory, "sessions.sqlite3");
			const database = new Database(databasePath);
			database.pragma("journal_mode = WAL");
			database.pragma("foreign_keys = ON");
			database.exec(`CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				harness_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				native_session_id TEXT,
				status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopped', 'failed', 'uncertain')),
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`);
			return new SqliteSessionStore(stateDirectory, database);
		} catch (error) {
			throw new SessionStoreError(
				`Could not open session store at ${stateDirectory}`,
				{ cause: error },
			);
		}
	}

	async create(session: SessionSummary): Promise<void> {
		try {
			this.database
				.prepare(`INSERT INTO sessions (id, harness_id, cwd, native_session_id, status)
				VALUES (?, ?, ?, ?, ?)`)
				.run(
					session.id,
					session.harnessId,
					session.cwd,
					session.nativeSessionId ?? null,
					session.status,
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
					"SELECT id, harness_id, cwd, native_session_id, status FROM sessions ORDER BY created_at, id",
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
					"SELECT id, harness_id, cwd, native_session_id, status FROM sessions WHERE id = ?",
				)
				.get(id) as SessionRow | undefined;
			return row ? fromRow(row) : undefined;
		} catch (error) {
			throw new SessionStoreError(`Could not load session '${id}'`, {
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
}

function fromRow(row: SessionRow): SessionSummary {
	return {
		id: row.id as SessionId,
		harnessId: row.harness_id as AdapterId,
		cwd: row.cwd,
		...(row.native_session_id === null
			? {}
			: { nativeSessionId: row.native_session_id }),
		status: row.status,
	};
}
