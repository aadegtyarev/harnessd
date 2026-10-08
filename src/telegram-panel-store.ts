import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

interface StoredPanels {
	readonly version: 2;
	readonly messages: Readonly<Record<string, number>>;
	readonly selectedSessions: Readonly<Record<string, string>>;
}

/** Persists per-bot Telegram panel IDs and chat selections, never prompt data. */
export class TelegramPanelStore {
	readonly filePath: string;
	private readonly messages = new Map<number, number>();
	private readonly selectedSessions = new Map<number, string>();
	private writes: Promise<void> = Promise.resolve();

	private constructor(stateDirectory: string, token: string) {
		const tokenHash = createHash("sha256").update(token).digest("hex");
		this.filePath = path.join(
			stateDirectory,
			`telegram-panels-${tokenHash}.json`,
		);
	}

	static async open(
		stateDirectory: string,
		token: string,
	): Promise<TelegramPanelStore> {
		const store = new TelegramPanelStore(stateDirectory, token);
		await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
		await store.load();
		return store;
	}

	get(chatId: number): number | undefined {
		return this.messages.get(chatId);
	}

	panels(): readonly (readonly [number, number])[] {
		return [...this.messages.entries()];
	}

	getSelected(chatId: number): string | undefined {
		return this.selectedSessions.get(chatId);
	}

	selections(): readonly (readonly [number, string])[] {
		return [...this.selectedSessions.entries()];
	}

	async setSelected(chatId: number, sessionId: string): Promise<void> {
		validateChatId(chatId);
		if (!isSessionId(sessionId)) throw new TypeError("Invalid session ID");
		this.selectedSessions.set(chatId, sessionId);
		await this.persist();
	}

	async clearSelected(chatId: number): Promise<void> {
		validateChatId(chatId);
		if (!this.selectedSessions.delete(chatId)) return;
		await this.persist();
	}

	async set(chatId: number, messageId: number): Promise<void> {
		validateChatId(chatId);
		if (!Number.isSafeInteger(messageId) || messageId <= 0)
			throw new TypeError("Invalid Telegram message ID");
		this.messages.set(chatId, messageId);
		await this.persist();
	}

	async delete(chatId: number): Promise<void> {
		if (!this.messages.delete(chatId)) return;
		await this.persist();
	}

	private async load(): Promise<void> {
		let contents: string;
		try {
			contents = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isCode(error, "ENOENT")) return;
			throw new Error("Could not load Telegram panel state");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(contents);
		} catch {
			return;
		}
		if (
			!isRecord(parsed) ||
			(parsed.version !== 1 && parsed.version !== 2) ||
			!isRecord(parsed.messages)
		)
			return;
		for (const [rawChatId, rawMessageId] of Object.entries(parsed.messages)) {
			const chatId = Number(rawChatId);
			if (
				Number.isSafeInteger(chatId) &&
				chatId > 0 &&
				Number.isSafeInteger(rawMessageId) &&
				Number(rawMessageId) > 0
			)
				this.messages.set(chatId, Number(rawMessageId));
		}
		if (parsed.version === 2 && isRecord(parsed.selectedSessions)) {
			for (const [rawChatId, sessionId] of Object.entries(
				parsed.selectedSessions,
			)) {
				const chatId = Number(rawChatId);
				if (
					Number.isSafeInteger(chatId) &&
					chatId > 0 &&
					isSessionId(sessionId)
				)
					this.selectedSessions.set(chatId, sessionId);
			}
		}
	}

	private persist(): Promise<void> {
		const write = this.writes.then(() => this.writeSnapshot());
		this.writes = write.catch(() => {});
		return write;
	}

	private async writeSnapshot(): Promise<void> {
		const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		const contents: StoredPanels = {
			version: 2,
			messages: Object.fromEntries(
				[...this.messages.entries()].map(([chatId, messageId]) => [
					String(chatId),
					messageId,
				]),
			),
			selectedSessions: Object.fromEntries(
				[...this.selectedSessions.entries()].map(([chatId, sessionId]) => [
					String(chatId),
					sessionId,
				]),
			),
		};
		try {
			await writeFile(temporaryPath, JSON.stringify(contents), {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await rename(temporaryPath, this.filePath);
		} catch {
			await unlink(temporaryPath).catch(() => {});
			throw new Error("Could not persist Telegram panel state");
		}
	}
}

function validateChatId(chatId: number): void {
	if (!Number.isSafeInteger(chatId) || chatId <= 0)
		throw new TypeError("Invalid private Telegram chat ID");
}

function isSessionId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		!/\p{Cc}/u.test(value)
	);
}

function isCode(error: unknown, code: string): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === code
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
