import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, realpath, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bot, InputFile } from "grammy";
import {
	getTelegramCommands,
	getTelegramHelpUsages,
} from "./command-catalog.js";
import type {
	AgentFileSendRequest,
	AgentFileSendResult,
	AgentFileSendTransport,
	HarnessEffortCatalog,
	HarnessModelCatalog,
	HarnessModelChangeResult,
	HarnessModelInfo,
	HarnessSessionStatus,
	HarnessUsageStats,
	TransportAdapter,
	TransportEvent,
	TransportEventSubscription,
	TransportResult,
} from "./core/ports.js";
import type {
	AdapterId,
	HarnessEvent,
	SessionId,
	SessionSummary,
} from "./core/types.js";
import { describeError, redactDiagnosticText } from "./error-diagnostics.js";
import {
	listDirectoryEntries,
	parsePathArgument,
	resolveExistingDirectory,
	resolvePathFrom,
	safeAttachmentName,
} from "./telegram-filesystem.js";
import { TelegramInbox, TelegramInboxQuotaError } from "./telegram-inbox.js";
import { TelegramPanelStore } from "./telegram-panel-store.js";

const TELEGRAM_LIMIT = 4096;
const SEND_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 6000;
const MAX_QUEUED_MESSAGES = 32;
const MAX_OUTPUT_MESSAGES = 24;
const MAX_INPUT_MESSAGES = 8;
const MAX_QUEUED_CHARACTERS = 32_768;
const INPUT_CHARACTER_RESERVE = 4096;
const OUTPUT_COALESCE_MS = 40;
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_DOWNLOAD_BYTES = 20_000_000;
const INBOX_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const TYPING_REFRESH_MS = 4000;
const OVERFLOW_NOTICE =
	"Additional notifications were omitted because the queue is full.";
type UpdateContext = {
	from?: { id: number };
	chat?: { id: number; type: string };
	message?: {
		text?: string;
		caption?: string;
		message_id?: number;
		document?: {
			file_id: string;
			file_name?: string;
			mime_type?: string;
			file_size?: number;
		};
		photo?: readonly {
			file_id: string;
			file_size?: number;
			width: number;
			height: number;
		}[];
		reply_to_message?: { message_id?: number };
	};
	callbackQuery?: {
		id: string;
		data?: string;
		message?: { message_id: number };
	};
};
type TelegramPhotoSize = NonNullable<
	NonNullable<UpdateContext["message"]>["photo"]
>[number];
type TelegramBot = {
	api: {
		sendMessage(
			chatId: number,
			text: string,
			other?: unknown,
			signal?: AbortSignal,
		): Promise<unknown>;
		editMessageText(
			chatId: number,
			messageId: number,
			text: string,
			other?: unknown,
			signal?: AbortSignal,
		): Promise<unknown>;
		pinChatMessage(
			chatId: number,
			messageId: number,
			other?: unknown,
			signal?: AbortSignal,
		): Promise<unknown>;
		getFile(
			fileId: string,
			signal?: AbortSignal,
		): Promise<{ file_path?: string; file_size?: number }>;
		sendChatAction(
			chatId: number,
			action: string,
			other?: unknown,
			signal?: AbortSignal,
		): Promise<unknown>;
		sendDocument(
			chatId: number,
			document: unknown,
			other?: unknown,
			signal?: AbortSignal,
		): Promise<unknown>;
		answerCallbackQuery(
			callbackQueryId: string,
			other?: unknown,
			signal?: AbortSignal,
		): Promise<unknown>;
		setMessageReaction(
			chatId: number,
			messageId: number,
			reaction: readonly { readonly type: "emoji"; readonly emoji: string }[],
			other?: unknown,
			signal?: AbortSignal,
		): Promise<unknown>;
		setMyCommands(
			commands: readonly {
				readonly command: string;
				readonly description: string;
			}[],
			other?: { readonly scope?: { readonly type: "all_private_chats" } },
			signal?: AbortSignal,
		): Promise<unknown>;
	};
	use(
		handler: (
			context: UpdateContext,
			next: () => Promise<void>,
		) => Promise<void>,
	): void;
	on(filter: string, handler: (context: UpdateContext) => Promise<void>): void;
	init(signal?: AbortSignal): Promise<void>;
	start(options?: { onStart?: () => void }): Promise<void>;
	stop(): Promise<void>;
};
type BotFactory = (token: string) => TelegramBot;
type TelegramRequest = TransportEvent extends infer Event
	? Event extends TransportEvent
		? Omit<Event, "requestId" | "principalId">
		: never
	: never;
type QueuedMessage = {
	readonly sessionId: SessionId;
	readonly text: string;
	readonly inputId?: string;
	inputState?: string;
	overflow?: true;
};
type PendingNameFlow =
	| {
			readonly kind: "create";
			readonly cwd: string;
			readonly promptMessageId: number;
	  }
	| {
			readonly kind: "rename";
			readonly sessionId: SessionId;
			readonly promptMessageId: number;
	  };
type PendingNameRequest =
	| { readonly kind: "create"; readonly cwd: string }
	| { readonly kind: "rename"; readonly sessionId: SessionId };
type ModelChoices = {
	readonly sessionId: SessionId;
	readonly models: readonly HarnessModelInfo[];
};
type EffortChoices = {
	readonly sessionId: SessionId;
	readonly levels: readonly string[];
};
type CallbackQueryContext = UpdateContext & {
	callbackQuery: NonNullable<UpdateContext["callbackQuery"]>;
};
type ChatQueue = {
	readonly messages: QueuedMessage[];
	pendingCharacters: number;
	draining?: Promise<void>;
	drainTimer?: NodeJS.Timeout;
	failed: boolean;
	overflowQueued: boolean;
};
type TurnBuffer = {
	readonly chunks: string[];
	characters: number;
	overflow: boolean;
};

export interface TelegramTransportOptions {
	readonly token: string;
	readonly allowedUserIds: readonly number[];
	readonly stateDirectory: string;
	readonly initialCwd: string;
	readonly signal?: AbortSignal;
	readonly onFatal?: () => void;
	readonly botFactory?: BotFactory;
}

export function telegramLockPath(
	token: string,
	stateDirectory: string,
): string {
	const digest = createHash("sha256").update(token).digest("hex");
	return path.join(stateDirectory, `telegram-${digest}.lock`);
}

export async function acquireTelegramPollingLock(
	token: string,
	stateDirectory: string,
): Promise<() => Promise<void>> {
	const lockPath = telegramLockPath(token, stateDirectory);
	const acquire = async () => {
		const file = await open(lockPath, "wx", 0o600);
		try {
			await file.writeFile(String(process.pid));
			await file.close();
		} catch (error) {
			await file.close().catch(() => {});
			await unlink(lockPath).catch(() => {});
			throw error;
		}
	};
	try {
		await acquire();
	} catch (error) {
		if (!isCode(error, "EEXIST")) throw error;
		const recoveryPath = `${lockPath}.recovery`;
		let recovery: Awaited<ReturnType<typeof open>> | undefined;
		try {
			recovery = await open(recoveryPath, "wx", 0o600);
			await recovery.writeFile(String(process.pid));
		} catch {
			if (recovery) {
				await recovery.close().catch(() => {});
				await unlink(recoveryPath).catch(() => {});
			}
			throw new Error("Telegram polling lock recovery is unavailable");
		}
		let acquired = false;
		let operationFailure: unknown;
		try {
			const existing = await readFile(lockPath, "utf8").catch(() => "");
			if (existing) {
				if (!/^\d+$/.test(existing.trim()) || Number(existing) <= 0)
					throw new Error("Telegram polling lock is ambiguous");
				try {
					process.kill(Number(existing), 0);
					throw new Error("Telegram polling is already active");
				} catch (probeError) {
					if (isCode(probeError, "EPERM"))
						throw new Error("Telegram polling lock is ambiguous");
					if (!isCode(probeError, "ESRCH")) throw probeError;
				}
				await unlink(lockPath);
			}
			try {
				await acquire();
				acquired = true;
			} catch {
				throw new Error("Telegram polling lock is unavailable");
			}
		} catch (error) {
			operationFailure = error;
		}
		let recoveryCleanupFailed = false;
		try {
			await recovery.close();
		} catch {
			recoveryCleanupFailed = true;
		}
		try {
			await removeOwnedLock(recoveryPath, process.pid);
		} catch {
			recoveryCleanupFailed = true;
		}
		if (recoveryCleanupFailed) {
			if (acquired)
				await removeOwnedLock(lockPath, process.pid).catch(() => {});
			throw new Error("Telegram polling lock recovery cleanup is incomplete");
		}
		if (operationFailure !== undefined) throw operationFailure;
	}
	let released = false;
	return async () => {
		if (released) return;
		await removeOwnedLock(lockPath, process.pid);
		released = true;
	};
}

async function removeOwnedLock(lockPath: string, pid: number): Promise<void> {
	const current = await readFile(lockPath, "utf8");
	if (current.trim() !== String(pid))
		throw new Error("Telegram polling lock ownership changed");
	await unlink(lockPath);
}

function telegramFileDownloadUrl(token: string, filePath: string): URL {
	const segments = filePath.split("/");
	if (
		!filePath ||
		filePath.startsWith("/") ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	)
		throw new Error("Invalid Telegram file path");
	return new URL(
		`/file/bot${token}/${segments.map(encodeURIComponent).join("/")}`,
		"https://api.telegram.org",
	);
}

function largestPhoto(
	photos: readonly TelegramPhotoSize[] | undefined,
): TelegramPhotoSize | undefined {
	let largest = photos?.[0];
	for (const photo of photos?.slice(1) ?? []) {
		const photoArea = photo.width * photo.height;
		const largestArea = (largest?.width ?? 0) * (largest?.height ?? 0);
		if (
			photoArea > largestArea ||
			(photoArea === largestArea &&
				(photo.file_size ?? 0) > (largest?.file_size ?? 0))
		)
			largest = photo;
	}
	return largest;
}

function isCode(error: unknown, code: string): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === code
	);
}
class TelegramAttachmentTooLargeError extends Error {}
async function readBoundedFile(
	rootPath: string,
	filePath: string,
): Promise<Buffer> {
	const handle = await open(
		filePath,
		fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
	);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("not a regular file");
		if (info.size > MAX_TELEGRAM_FILE_BYTES)
			throw new TelegramAttachmentTooLargeError();
		const openedPath = await realpath(filePath);
		const relative = path.relative(rootPath, openedPath);
		if (
			!relative ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		)
			throw new Error("file is outside session cwd");
		const pathInfo = await stat(openedPath);
		if (pathInfo.dev !== info.dev || pathInfo.ino !== info.ino)
			throw new Error("file changed during validation");
		const chunks: Buffer[] = [];
		let length = 0;
		for await (const chunk of handle.createReadStream({ autoClose: false })) {
			const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			length += data.length;
			if (length > MAX_TELEGRAM_FILE_BYTES)
				throw new TelegramAttachmentTooLargeError();
			chunks.push(data);
		}
		return Buffer.concat(chunks, length);
	} finally {
		await handle.close();
	}
}
async function readBoundedResponse(
	response: Response,
	maxBytes = MAX_TELEGRAM_FILE_BYTES,
): Promise<Buffer> {
	if (!response.body) throw new Error("empty response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > maxBytes) {
			await reader.cancel();
			throw new TelegramAttachmentTooLargeError();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks, length);
}
function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}
function sessionLabel(session: Pick<SessionSummary, "id" | "name">): string {
	return `${session.name ? `${oneLine(session.name)} · ` : ""}#${session.id}`;
}
function shortSessionLabel(
	session: Pick<SessionSummary, "id" | "name">,
): string {
	return `${session.name ? `${buttonLabel(session.name, 25)} · ` : ""}#${session.id.slice(0, 8)}`;
}
function formatSession(session: SessionSummary): string {
	const cwd = [...oneLine(session.cwd)];
	const displayCwd =
		cwd.length > 600 ? `${cwd.slice(0, 599).join("")}…` : cwd.join("");
	return `${escapeHtml(sessionLabel(session))} · ${escapeHtml(session.status)}\n${escapeHtml(displayCwd)}`;
}
function oneLine(value: string): string {
	return [...value]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 ? " " : character;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}
function modelId(model: HarnessModelInfo): string {
	return `${oneLine(model.provider)}/${oneLine(model.id)}`;
}
function isSessionIdToken(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
type InlineButton = { readonly text: string; readonly callback_data: string };
function keyboard(rows: readonly (readonly InlineButton[])[]): unknown {
	return { inline_keyboard: rows };
}
function inlineButton(text: string, callbackData: string): InlineButton {
	return { text, callback_data: callbackData };
}
function buttonLabel(value: string, limit = 44): string {
	const text = [...oneLine(value)];
	return text.length > limit
		? `${text.slice(0, limit - 1).join("")}…`
		: text.join("");
}
function panelPath(value: string): string {
	return buttonLabel(value, 1200);
}
function messageIdFrom(value: unknown): number | undefined {
	if (value === null || typeof value !== "object" || !("message_id" in value))
		return undefined;
	const messageId = value.message_id;
	return Number.isSafeInteger(messageId) && Number(messageId) > 0
		? Number(messageId)
		: undefined;
}
function apiErrorDescription(error: unknown): string | undefined {
	if (error === null || typeof error !== "object") return undefined;
	if ("description" in error && typeof error.description === "string")
		return error.description;
	return undefined;
}
function isMessageNotModified(error: unknown): boolean {
	return (
		apiErrorDescription(error)
			?.toLowerCase()
			.includes("message is not modified") ?? false
	);
}
function isMessageNotFound(error: unknown): boolean {
	const description = apiErrorDescription(error)?.toLowerCase() ?? "";
	return description.includes("message to edit not found");
}
function formatCount(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}
function compactCount(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
	const compact = (divisor: number, suffix: string) =>
		`${(value / divisor).toFixed(1).replace(/\.0$/, "")}${suffix}`;
	if (value >= 1_000_000) return compact(1_000_000, "M");
	if (value >= 1_000) return compact(1_000, "k");
	return String(Math.round(value));
}
function compactCost(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
	return `~$${value.toFixed(3).replace(/\.?0+$/, "")}`;
}
function cacheHitRate(usage: HarnessUsageStats | undefined): string {
	if (
		usage?.inputTokens === undefined ||
		usage.cacheReadTokens === undefined ||
		usage.cacheWriteTokens === undefined
	)
		return "—";
	const prompt =
		usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	return prompt > 0
		? `${((usage.cacheReadTokens / prompt) * 100).toFixed(1)}%`
		: "—";
}
function compactUsage(usage: HarnessUsageStats | undefined): string {
	return [
		`↑${compactCount(usage?.inputTokens)}`,
		`↓${compactCount(usage?.outputTokens)}`,
		`R${compactCount(usage?.cacheReadTokens)}`,
		`CH${cacheHitRate(usage)}`,
		compactCost(usage?.costUsd),
	].join(" ");
}
function formatStatus(status: HarnessSessionStatus): string {
	const { session, live } = status;
	const lines = [
		`Folder: ${oneLine(session.cwd)}`,
		`Session: ${session.status}`,
		`Model: ${live?.model ? modelId(live.model) : "unavailable"}`,
		`Effort: ${live?.effort ? oneLine(live.effort) : "unavailable"}`,
	];
	const usage = live?.usage;
	lines.push(
		`Tokens: ${usage?.totalTokens !== undefined ? formatCount(usage.totalTokens) : "unavailable"}`,
		`Estimated cost: ${usage?.costUsd !== undefined ? `~$${usage.costUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}` : "unavailable"}`,
	);
	if (!live) lines.push("Live Pi data: unavailable for this session.");
	return lines.join("\n");
}
function chunks(text: string): string[] {
	return splitChunks(text, TELEGRAM_LIMIT);
}
function sessionIdEntity(
	text: string,
	sessionId: SessionId,
):
	| {
			readonly entities: readonly {
				readonly type: "code";
				readonly offset: number;
				readonly length: number;
			}[];
	  }
	| undefined {
	const offset = text.lastIndexOf(sessionId);
	if (offset < 0) return undefined;
	return {
		entities: [{ type: "code", offset, length: sessionId.length }],
	};
}
function splitMessageWithFooter(text: string, footer: string): string[] {
	const body = text || " ";
	let total = 1;
	for (let attempt = 0; attempt < 128; attempt++) {
		const parts: string[] = [];
		let offset = 0;
		for (let index = 1; index <= total && offset < body.length; index++) {
			const suffix = total > 1 ? ` · ${index}/${total}` : "";
			const ending = `\n\n${footer}${suffix}`;
			const remaining = body.slice(offset);
			const contentLimit = TELEGRAM_LIMIT - ending.length;
			if (contentLimit < 1)
				throw new Error("Telegram footer exceeds message limit");
			const length =
				remaining.length > contentLimit
					? splitPoint(remaining, contentLimit)
					: remaining.length;
			parts.push(`${remaining.slice(0, length)}${ending}`);
			offset += length;
		}
		if (offset < body.length) {
			total = Math.max(total + 1, parts.length + 1);
			continue;
		}
		if (parts.length !== total) {
			total = parts.length;
			continue;
		}
		return parts;
	}
	throw new Error("Could not split Telegram message within the part limit");
}
function splitPoint(text: string, limit: number): number {
	const newline = text.lastIndexOf("\n", limit - 1);
	let split = newline >= Math.floor(limit / 2) ? newline + 1 : limit;
	if (/[\uD800-\uDBFF]/.test(text[split - 1] ?? "")) split--;
	return split;
}
function splitChunks(text: string, limit: number): string[] {
	const result: string[] = [];
	let remaining = text;
	while (remaining.length > limit) {
		const newline = remaining.lastIndexOf("\n", limit - 1);
		let split = newline < 0 ? limit : newline + 1;
		if (/[\uD800-\uDBFF]/.test(remaining[split - 1] ?? "")) split--;
		result.push(remaining.slice(0, split));
		remaining = remaining.slice(split);
	}
	if (remaining) result.push(remaining);
	return result;
}
function safeResultError(error: {
	readonly code: string;
	readonly message: string;
	readonly inputId?: string;
}): string {
	if (error.code === "UNCERTAIN_INPUT_DELIVERY" && error.inputId)
		return `${error.message} (InputId ${error.inputId}; not resent)`;
	return error.message;
}
function statusMessage(value: string | undefined): string {
	switch (value) {
		case "harness_restarting":
			return "Harness is restarting.";
		case "harness_recovered":
			return "Harness recovered.";
		case "harness_recovery_failed":
			return "Harness recovery failed.";
		default:
			return "Session status changed.";
	}
}
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("deadline")), timeoutMs);
		void promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export class TelegramTransportAdapter
	implements TransportAdapter, AgentFileSendTransport
{
	readonly descriptor = {
		id: "telegram" as AdapterId,
		capabilities: ["transport.poll"] as const,
	};
	private readonly selected = new Map<number, SessionId>();
	private readonly sessionNames = new Map<SessionId, string>();
	private readonly knownSessions = new Set<SessionId>();
	private readonly reportedErrors = new Set<SessionId>();
	private readonly previews = new Map<number, SessionId>();
	private readonly pendingNames = new Map<
		number,
		Map<number, PendingNameFlow>
	>();
	private readonly modelChoices = new Map<number, ModelChoices>();
	private readonly effortChoices = new Map<number, EffortChoices>();
	private readonly turnBuffers = new Map<SessionId, TurnBuffer>();
	private readonly currentDirectories = new Map<number, string>();
	private readonly panelMessageIds = new Map<number, number>();
	private readonly sessionPages = new Map<number, number>();
	private readonly folderPages = new Map<number, number>();
	private readonly modelPages = new Map<number, number>();
	private readonly effortPages = new Map<number, number>();
	private readonly queues = new Map<number, ChatQueue>();
	private readonly typingTimers = new Map<
		SessionId,
		ReturnType<typeof setInterval>
	>();
	private readonly typingChats = new Map<SessionId, Set<number>>();
	private readonly activeTypingSessions = new Set<SessionId>();
	private readonly sessionCwds = new Map<SessionId, string>();
	private panelStore?: TelegramPanelStore;
	private readonly pendingSends = new Set<AbortController>();
	private readonly activeSends = new Set<Promise<boolean>>();
	private readonly bot: TelegramBot;
	private readonly authorized: Set<number>;
	private readonly authorizedChatPrincipals = new Map<number, number>();
	private dispatch?: (event: TransportEvent) => Promise<TransportResult>;
	private listSessions?: () => Promise<readonly SessionSummary[]>;
	private inbox?: TelegramInbox;
	private inboxSweepTimer?: NodeJS.Timeout;
	private inboxSweepPromise?: Promise<void>;
	private unsubscribe?: () => void;
	private releaseLock?: () => Promise<void>;
	private stopPromise?: Promise<void>;
	private pollingPromise?: Promise<void>;
	private initializationPromise?: Promise<{ readonly ok: boolean }>;
	private initializationAbort?: AbortController;
	private readonly pollingFinished: Promise<void>;
	private resolvePollingFinished!: () => void;
	private ready = false;
	private stopping = false;

	constructor(private readonly options: TelegramTransportOptions) {
		this.authorized = new Set(options.allowedUserIds);
		this.bot = (
			options.botFactory ??
			((token) => new Bot(token) as unknown as TelegramBot)
		)(options.token);
		this.pollingFinished = new Promise<void>((resolve) => {
			this.resolvePollingFinished = resolve;
		});
	}

	async start(
		dispatch: (event: TransportEvent) => Promise<TransportResult>,
		subscribe: TransportEventSubscription,
		listSessions?: () => Promise<readonly SessionSummary[]>,
	): Promise<void> {
		this.dispatch = dispatch;
		this.listSessions = listSessions;
		this.releaseLock = await acquireTelegramPollingLock(
			this.options.token,
			this.options.stateDirectory,
		);
		try {
			this.panelStore = await TelegramPanelStore.open(
				this.options.stateDirectory,
				this.options.token,
			);
			this.inbox = new TelegramInbox(this.options.stateDirectory);
			if (this.options.signal?.aborted)
				throw new Error("Telegram startup aborted");
			this.unsubscribe = subscribe((event) => this.onEvent(event));
			this.bot.use(async (ctx, next) => {
				if (this.isAuthorized(ctx)) await next();
			});
			this.bot.on("message:text", async (ctx) => this.onText(ctx));
			this.bot.on("message:document", async (ctx) => this.onMedia(ctx));
			this.bot.on("message:photo", async (ctx) => this.onMedia(ctx));
			for (const filter of [
				"message:video",
				"message:audio",
				"message:voice",
				"message:animation",
				"message:sticker",
				"message:video_note",
			])
				this.bot.on(filter, async (ctx) => this.onUnsupportedMedia(ctx));
			this.bot.on("callback_query:data", async (ctx) =>
				this.onCallback(ctx as CallbackQueryContext),
			);
			let ready!: () => void;
			let failReady!: (error: Error) => void;
			const readiness = new Promise<void>((resolve, reject) => {
				ready = resolve;
				failReady = reject;
			});
			this.initializationAbort = new AbortController();
			const abortInitialization = () => this.initializationAbort?.abort();
			this.options.signal?.addEventListener("abort", abortInitialization, {
				once: true,
			});
			try {
				if (this.options.signal?.aborted)
					throw new Error("Telegram startup aborted");
				let initializationError: unknown;
				this.initializationPromise = this.bot
					.init(this.initializationAbort.signal)
					.then(
						() => ({ ok: true }),
						(error: unknown) => {
							initializationError = error;
							return { ok: false };
						},
					);
				const initialized = await this.initializationPromise;
				if (!initialized.ok)
					throw new Error("Telegram initialization failed", {
						cause: initializationError,
					});
				try {
					await withDeadline(
						this.bot.api.setMyCommands(
							getTelegramCommands(),
							{ scope: { type: "all_private_chats" } },
							this.initializationAbort.signal,
						),
						SEND_TIMEOUT_MS,
					);
				} catch (error) {
					this.reportError("Telegram command menu registration failed", error);
				}
			} finally {
				this.options.signal?.removeEventListener("abort", abortInitialization);
			}
			if (this.options.signal?.aborted)
				throw new Error("Telegram startup aborted");
			const abortPolling = () =>
				failReady(new Error("Telegram startup aborted"));
			this.options.signal?.addEventListener("abort", abortPolling, {
				once: true,
			});
			try {
				if (this.options.signal?.aborted)
					throw new Error("Telegram startup aborted");
				this.pollingPromise = this.bot.start({ onStart: ready }).then(
					() =>
						this.pollingEnded(
							failReady,
							new Error("Telegram polling stopped unexpectedly"),
						),
					(error: unknown) =>
						this.pollingEnded(
							failReady,
							new Error("Telegram polling failed", { cause: error }),
						),
				);
				await readiness;
				if (this.options.signal?.aborted)
					throw new Error("Telegram startup aborted");
				this.ready = true;
				this.scheduleInboxSweep();
			} finally {
				this.options.signal?.removeEventListener("abort", abortPolling);
			}
		} catch (error) {
			this.reportError("Telegram transport startup failed", error);
			try {
				await this.stop();
			} catch (cleanupError) {
				this.reportError(
					"Telegram transport startup cleanup failed",
					cleanupError,
				);
				/* lock is retained if shutdown cannot be confirmed */
			}
			throw new Error("Telegram transport could not start", { cause: error });
		}
	}

	private pollingEnded(failReady: (error: Error) => void, error: Error): void {
		this.reportError("Telegram polling ended", error);
		this.resolvePollingFinished();
		if (this.stopping) return;
		if (!this.ready) failReady(error);
		else {
			try {
				this.options.onFatal?.();
			} catch {
				/* fatal callback failures are isolated */
			}
		}
	}

	private scheduleInboxSweep(): void {
		const run = () => {
			if (this.stopping || this.inboxSweepPromise) return;
			const task = this.sweepSessionInboxes();
			this.inboxSweepPromise = task;
			void task
				.catch((error: unknown) => {
					this.reportError("Telegram inbox cleanup failed", error);
				})
				.finally(() => {
					if (this.inboxSweepPromise === task)
						this.inboxSweepPromise = undefined;
				});
		};
		setTimeout(run, 0);
		this.inboxSweepTimer = setInterval(run, INBOX_SWEEP_INTERVAL_MS);
	}

	private async sweepSessionInboxes(): Promise<void> {
		const listSessions = this.listSessions;
		if (!listSessions || !this.inbox || this.stopping) return;
		const sessions = await listSessions();
		await this.inbox.sweep(sessions, listSessions);
	}

	private async deleteSessionAndInbox(
		sender: number,
		sessionId: SessionId,
	): Promise<{
		readonly result: TransportResult;
		readonly cleanupPending: boolean;
	}> {
		const inbox = this.inbox;
		if (!inbox)
			return {
				result: await this.request(sender, { kind: "delete", sessionId }),
				cleanupPending: false,
			};
		return inbox.withSessionLock(sessionId, async () => {
			const result = await this.request(sender, { kind: "delete", sessionId });
			if (!result.ok) return { result, cleanupPending: false };
			try {
				await inbox.removeSessionUnderLock(sessionId);
				return { result, cleanupPending: false };
			} catch (error) {
				this.reportError("Telegram session inbox cleanup failed", error);
				return { result, cleanupPending: true };
			}
		});
	}

	stop(): Promise<void> {
		if (!this.stopPromise) this.stopPromise = this.stopPolling();
		return this.stopPromise;
	}

	private async stopPolling(): Promise<void> {
		this.stopping = true;
		if (this.inboxSweepTimer) clearInterval(this.inboxSweepTimer);
		this.inboxSweepTimer = undefined;
		if (this.inboxSweepPromise)
			await withDeadline(this.inboxSweepPromise, STOP_TIMEOUT_MS).catch(
				() => {},
			);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.initializationAbort?.abort();
		for (const controller of this.pendingSends) controller.abort();
		for (const timer of this.typingTimers.values()) clearInterval(timer);
		this.typingTimers.clear();
		this.typingChats.clear();
		this.activeTypingSessions.clear();
		for (const queue of this.queues.values()) {
			if (queue.drainTimer) clearTimeout(queue.drainTimer);
			queue.messages.length = 0;
			queue.pendingCharacters = 0;
		}
		try {
			if (this.initializationPromise)
				await withDeadline(this.initializationPromise, STOP_TIMEOUT_MS);
			await withDeadline(
				Promise.all([...this.activeSends]).then(() => undefined),
				STOP_TIMEOUT_MS,
			);
			const drains = [...this.queues.values()].flatMap((queue) =>
				queue.draining ? [queue.draining] : [],
			);
			await withDeadline(
				Promise.all(drains).then(() => undefined),
				STOP_TIMEOUT_MS,
			);
			await withDeadline(this.bot.stop(), STOP_TIMEOUT_MS);
			if (this.pollingPromise) {
				await withDeadline(this.pollingPromise, STOP_TIMEOUT_MS);
				await withDeadline(this.pollingFinished, STOP_TIMEOUT_MS);
			}
		} catch (error) {
			throw new Error("Telegram shutdown incomplete; polling lock retained", {
				cause: error,
			});
		}
		if (this.releaseLock) {
			await this.releaseLock();
			this.releaseLock = undefined;
		}
	}

	private setSelected(chatId: number, sessionId: SessionId): void {
		const previous = this.selected.get(chatId);
		this.selected.set(chatId, sessionId);
		if (previous && previous !== sessionId && this.typingTimers.has(previous))
			this.refreshTyping(previous);
		if (this.activeTypingSessions.has(sessionId)) this.startTyping(sessionId);
	}

	private clearSelected(chatId: number): void {
		const previous = this.selected.get(chatId);
		this.selected.delete(chatId);
		if (previous && this.typingTimers.has(previous))
			this.refreshTyping(previous);
	}

	private isAuthorized(ctx: UpdateContext): boolean {
		if (
			ctx.from === undefined ||
			!Number.isSafeInteger(ctx.from.id) ||
			ctx.from.id <= 0 ||
			!this.authorized.has(ctx.from.id) ||
			ctx.chat?.type !== "private"
		)
			return false;
		this.authorizedChatPrincipals.set(ctx.chat.id, ctx.from.id);
		return true;
	}

	private async onText(ctx: UpdateContext): Promise<void> {
		const chatId = ctx.chat?.id;
		const sender = ctx.from?.id;
		const text = ctx.message?.text;
		if (chatId === undefined || sender === undefined || text === undefined)
			return;
		try {
			const replyTo = ctx.message?.reply_to_message?.message_id;
			const pending =
				replyTo === undefined
					? undefined
					: this.pendingNames.get(chatId)?.get(replyTo);
			if (pending) {
				await this.handleNameReply(chatId, sender, pending, text);
				return;
			}
			if (ctx.message?.reply_to_message)
				return this.sendDirect(
					chatId,
					"This reply does not match an active prompt. Send it as a new message if it is intended for the session.",
				);
			if (text.startsWith("/")) await this.command(chatId, sender, text);
			else {
				const sessionId = this.selected.get(chatId);
				if (!sessionId)
					return this.sendDirect(chatId, "Select a session with /use first.");
				const result = await this.request(sender, {
					kind: "submit",
					sessionId,
					text,
				});
				if (result.ok)
					await this.confirmInputAccepted(
						chatId,
						ctx.message?.message_id,
						result.value as string,
						`Input accepted: ${result.value as string}`,
					);
				else await this.sendDirect(chatId, safeResultError(result.error));
			}
		} catch (error) {
			const reference = this.reportError(
				"Telegram update handler failed",
				error,
				[text],
			);
			await this.sendDiagnostic(
				chatId,
				`Request failed (ref ${reference}). Details are recorded in the harnessd journal.\n\n${describeError(error, [this.options.token, text])}`,
			);
		}
	}

	async sendAgentFile(
		request: AgentFileSendRequest,
	): Promise<AgentFileSendResult> {
		if (this.stopping) throw new Error("Telegram transport is stopping");
		if (request.caption !== undefined && [...request.caption].length > 1024)
			throw new Error("Invalid file caption");
		const recipients = [...this.selected].flatMap(([chatId, sessionId]) =>
			sessionId === request.sessionId &&
			Number.isSafeInteger(chatId) &&
			this.authorized.has(this.authorizedChatPrincipals.get(chatId) ?? -1)
				? [chatId]
				: [],
		);
		if (recipients.length === 0)
			throw new Error("No authorized chat currently selects this session");
		let delivered = 0;
		for (const chatId of recipients) {
			if (
				await this.sendFileToChat(
					request.sessionId,
					request.path,
					chatId,
					request.caption,
				)
			)
				delivered += 1;
		}
		return {
			fileName: safeAttachmentName(path.basename(request.path)),
			delivered,
			recipients: recipients.length,
		};
	}

	private async sendFileToChat(
		sessionId: SessionId,
		filePath: string,
		chatId: number,
		caption?: string,
	): Promise<boolean> {
		const cwd = this.sessionCwds.get(sessionId);
		if (!cwd) return false;
		if (
			!Number.isSafeInteger(chatId) ||
			!this.authorized.has(this.authorizedChatPrincipals.get(chatId) ?? -1) ||
			this.selected.get(chatId) !== sessionId
		)
			return false;
		try {
			const candidate = path.resolve(cwd, filePath);
			const canonicalRoot = await realpath(cwd);
			const canonicalFile = await realpath(candidate);
			const relative = path.relative(canonicalRoot, canonicalFile);
			if (
				!relative ||
				relative === ".." ||
				relative.startsWith(`..${path.sep}`) ||
				path.isAbsolute(relative)
			)
				return false;
			const data = await readBoundedFile(canonicalRoot, canonicalFile);
			if (this.stopping || this.selected.get(chatId) !== sessionId)
				return false;
			const sent = await this.telegramCall((signal) =>
				this.bot.api.sendDocument(
					chatId,
					new InputFile(data, path.basename(canonicalFile)),
					caption === undefined ? {} : { caption },
					signal,
				),
			);
			if (!sent.ok) {
				this.reportError("Telegram agent file delivery failed", sent.error, [
					filePath,
					caption,
				]);
				return false;
			}
			return true;
		} catch (error) {
			this.reportError("Telegram agent file preparation failed", error, [
				filePath,
				caption,
			]);
			return false;
		}
	}

	private async onUnsupportedMedia(ctx: UpdateContext): Promise<void> {
		const chatId = ctx.chat?.id;
		if (chatId !== undefined)
			await this.sendDirect(
				chatId,
				"Unsupported attachment type. Send a Telegram document or photo instead.",
			);
	}

	private async onMedia(ctx: UpdateContext): Promise<void> {
		const chatId = ctx.chat?.id;
		const sender = ctx.from?.id;
		const message = ctx.message;
		if (chatId === undefined || sender === undefined || !message) return;
		const sessionId = this.selected.get(chatId);
		if (!sessionId)
			return this.sendDirect(
				chatId,
				"Select a session with /use before sending files.",
			);
		const document = message.document;
		const photo = largestPhoto(message.photo);
		if (!document && !photo)
			return this.sendDirect(chatId, "Unsupported attachment type.");
		const fileId = document?.file_id ?? photo?.file_id;
		if (!fileId)
			return this.sendDirect(chatId, "Could not identify the attachment.");
		const declaredSize = document?.file_size ?? photo?.file_size;
		if (
			declaredSize !== undefined &&
			declaredSize > MAX_TELEGRAM_DOWNLOAD_BYTES
		)
			return this.sendDirect(
				chatId,
				"Attachment exceeds Telegram's 20 MB download limit.",
			);
		const inbox = this.inbox;
		if (!inbox)
			return this.sendDirect(chatId, "The session inbox is unavailable.");
		await inbox.withSessionLock(sessionId, async () => {
			const inspected = await this.request(sender, {
				kind: "inspect",
				sessionId,
			});
			if (!inspected.ok) {
				await this.sendDirect(chatId, inspected.error.message);
				return;
			}
			const session = inspected.value as SessionSummary;
			this.rememberSession(session);
			try {
				const file = await this.bot.api.getFile(fileId);
				if ((file.file_size ?? 0) > MAX_TELEGRAM_DOWNLOAD_BYTES)
					throw new TelegramAttachmentTooLargeError();
				if (!file.file_path) throw new Error("file unavailable");
				const url = telegramFileDownloadUrl(this.options.token, file.file_path);
				const response = await fetch(url);
				if (!response.ok) throw new Error("download failed");
				const data = await readBoundedResponse(
					response,
					MAX_TELEGRAM_DOWNLOAD_BYTES,
				);
				if (!data.length || data.length > MAX_TELEGRAM_DOWNLOAD_BYTES)
					throw new Error("file size invalid");
				const saved = await inbox.saveUnderLock(
					session.id,
					document?.file_name ?? (photo ? "photo.jpg" : "attachment"),
					data,
					session.status === "stopped" || session.status === "failed",
					session.cwd,
				);
				const caption = message.caption?.trim();
				const text = `The user sent an attachment saved in the harnessd inbox at ${saved.path}.${caption ? ` Caption (untrusted user text): ${caption}` : ""}`;
				const image = photo
					? [{ mimeType: "image/jpeg", data: data.toString("base64") }]
					: undefined;
				const submitted = await this.dispatchRequest(sender, {
					kind: "submit",
					sessionId,
					text,
					...(image ? { images: image } : {}),
				});
				if (!submitted.ok)
					return this.sendDirect(chatId, submitted.error.message);
				return this.confirmInputAccepted(
					chatId,
					message.message_id,
					submitted.value as string,
					`Attachment saved and submitted: ${saved.path}`,
				);
			} catch (error) {
				if (error instanceof TelegramAttachmentTooLargeError)
					return this.sendDirect(
						chatId,
						"Attachment exceeds Telegram's 20 MB download limit.",
					);
				if (error instanceof TelegramInboxQuotaError)
					return this.sendDirect(
						chatId,
						"Session inbox quota reached (10 files or 100 MiB). Remove files or wait for expired files to be cleaned.",
					);
				return this.sendDirect(
					chatId,
					"Could not safely download or save this attachment. Please try again later.",
				);
			}
		});
	}

	private async command(
		chatId: number,
		sender: number,
		raw: string,
	): Promise<void> {
		if (/^\/menu(?:@[^\s]+)?$/.test(raw))
			return this.renderPanel(chatId, sender);
		const renameCommand = /^\/rename(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(raw);
		if (renameCommand)
			return this.renameCommand(chatId, sender, renameCommand[1] ?? "");
		const newCommand = /^\/new(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(raw);
		if (newCommand) {
			const parsedPath = parsePathArgument(newCommand[1]);
			if (!parsedPath.ok)
				return this.sendDirect(
					chatId,
					"Use matching quotes around the entire path, or remove the quotes.",
				);
			const currentDirectory =
				this.currentDirectories.get(chatId) ?? this.options.initialCwd;
			const cwd = parsedPath.path
				? resolvePathFrom(parsedPath.path, currentDirectory)
				: currentDirectory;
			const result = await this.request(sender, {
				kind: "create",
				harnessId: "pi-rpc" as never,
				cwd,
			});
			if (!result.ok) return this.sendDirect(chatId, result.error.message);
			const session = result.value as SessionSummary;
			this.rememberSession(session);
			this.setSelected(chatId, session.id);
			this.previews.delete(chatId);
			await this.refreshExistingPanel(chatId, sender);
			return this.sendDirect(
				chatId,
				`Created and selected ${sessionLabel(session)}.`,
			);
		}
		const sendCommand = /^\/send(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(raw);
		if (sendCommand) {
			const parsedPath = parsePathArgument(sendCommand[1]);
			if (!parsedPath.ok || !parsedPath.path)
				return this.sendDirect(chatId, "Usage: /send <path>");
			const sessionId = this.selected.get(chatId);
			if (!sessionId) return this.sendDirect(chatId, "Select a session first.");
			const sent = await this.sendFileToChat(
				sessionId,
				parsedPath.path,
				chatId,
			);
			return this.sendDirect(
				chatId,
				sent
					? "File sent."
					: "Could not send file. Use a regular file inside the selected session folder, no larger than 20 MiB.",
			);
		}
		const pathCommand = /^\/(ls|cd)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(raw);
		if (pathCommand) {
			const parsedPath = parsePathArgument(pathCommand[2]);
			if (!parsedPath.ok)
				return this.sendDirect(
					chatId,
					"Use matching quotes around the entire path, or remove the quotes.",
				);
			const currentDirectory =
				this.currentDirectories.get(chatId) ?? this.options.initialCwd;
			if (pathCommand[1] === "cd") {
				const target = parsedPath.path
					? resolvePathFrom(parsedPath.path, currentDirectory)
					: os.homedir();
				try {
					const directory = await resolveExistingDirectory(target);
					this.currentDirectories.set(chatId, directory);
					await this.refreshExistingPanel(chatId, sender);
					return this.sendDirect(
						chatId,
						`Working folder: ${oneLine(directory)}`,
					);
				} catch {
					return this.sendDirect(
						chatId,
						"Directory is missing, inaccessible, or not a directory; current folder unchanged.",
					);
				}
			}
			const target = parsedPath.path
				? resolvePathFrom(parsedPath.path, currentDirectory)
				: currentDirectory;
			try {
				const listing = await listDirectoryEntries(target);
				const entries = listing.entries.map((entry) =>
					entry.kind === "directory"
						? `📁 ${oneLine(entry.name)}/`
						: `📄 ${oneLine(entry.name)}`,
				);
				if (listing.truncated)
					entries.push(`… showing first 100 of ${listing.total} entries`);
				return this.sendDirect(
					chatId,
					[`Directory: ${oneLine(listing.cwd)}`, ...entries].join("\n"),
				);
			} catch {
				return this.sendDirect(
					chatId,
					"Directory is missing, inaccessible, or not a directory.",
				);
			}
		}
		const [command, ...args] = raw.trim().split(/\s+/);
		const name = command.split("@")[0];
		if (name === "/help" && args.length === 0)
			return this.sendDirect(chatId, getTelegramHelpUsages().join("\n"));
		if (name === "/status" && args.length === 0) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId) return this.sendDirect(chatId, "Select a session first.");
			const result = await this.request(sender, {
				kind: "session_status",
				sessionId,
			});
			return this.sendDirect(
				chatId,
				result.ok
					? formatStatus(result.value as HarnessSessionStatus)
					: result.error.message,
			);
		}
		if (name === "/model" && args.length === 0) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId) return this.sendDirect(chatId, "Select a session first.");
			const result = await this.request(sender, {
				kind: "model_list",
				sessionId,
			});
			if (!result.ok) return this.sendDirect(chatId, result.error.message);
			const catalog = result.value as HarnessModelCatalog;
			const choices = catalog.models.map((model) => {
				const label = modelId(model);
				const name = oneLine(model.name);
				return `• ${label}${name && name !== model.id ? ` — ${name}` : ""}${catalog.current && model.provider === catalog.current.provider && model.id === catalog.current.id ? " (current)" : ""}`;
			});
			return this.sendDirect(
				chatId,
				choices.length ? choices.join("\n") : "No models available.",
			);
		}
		if (name === "/model" && args.length >= 1 && args.length <= 2) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId) return this.sendDirect(chatId, "Select a session first.");
			const slash = args[0].indexOf("/");
			if (slash <= 0 || slash === args[0].length - 1)
				return this.sendDirect(
					chatId,
					"Usage: /model <provider/modelId> [effort]",
				);
			const effort = args[1];
			const result = await this.request(sender, {
				kind: "model_set",
				sessionId,
				provider: args[0].slice(0, slash),
				modelId: args[0].slice(slash + 1),
				...(effort !== undefined ? { effort } : {}),
			});
			if (!result.ok) return this.sendDirect(chatId, result.error.message);
			const change = result.value as HarnessModelChangeResult;
			if (change.effortConfirmed === false)
				return this.sendDirect(
					chatId,
					`Switched to ${modelId(change.model)}, but Pi did not confirm effort ${oneLine(effort ?? "")}. Check /status before retrying.`,
				);
			return this.sendDirect(
				chatId,
				effort === undefined
					? `Switched to ${modelId(change.model)}.`
					: `Switched to ${modelId(change.model)}; effort set to ${oneLine(effort)}.`,
			);
		}
		if (name === "/effort" && args.length === 0) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId) return this.sendDirect(chatId, "Select a session first.");
			const result = await this.request(sender, {
				kind: "effort_list",
				sessionId,
			});
			if (!result.ok) return this.sendDirect(chatId, result.error.message);
			const catalog = result.value as HarnessEffortCatalog;
			return this.sendDirect(
				chatId,
				`Effort levels${catalog.current ? ` (current: ${oneLine(catalog.current)})` : ""}: ${catalog.levels.map(oneLine).join(", ") || "unavailable"}`,
			);
		}
		if (name === "/effort" && args.length === 1) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId) return this.sendDirect(chatId, "Select a session first.");
			const result = await this.request(sender, {
				kind: "effort_set",
				sessionId,
				effort: args[0],
			});
			return this.sendDirect(
				chatId,
				result.ok ? `Effort set to ${oneLine(args[0])}.` : result.error.message,
			);
		}
		if (name === "/sessions" && args.length === 0) {
			const result = await this.request(sender, { kind: "list" });
			if (result.ok)
				this.rememberSessions(result.value as readonly SessionSummary[]);
			return this.sendDirectHtml(
				chatId,
				result.ok
					? (result.value as readonly SessionSummary[])
							.map(formatSession)
							.join("\n\n") || "No sessions."
					: escapeHtml(result.error.message),
			);
		}
		if (name === "/use" && args.length === 1) {
			const result = await this.request(sender, {
				kind: "inspect",
				sessionId: args[0] as SessionId,
			});
			if (!result.ok) return this.sendDirect(chatId, result.error.message);
			const session = result.value as SessionSummary;
			this.rememberSession(session);
			this.setSelected(chatId, session.id);
			this.previews.delete(chatId);
			await this.refreshExistingPanel(chatId, sender);
			return this.sendDirect(chatId, `Selected ${sessionLabel(session)}.`);
		}
		if (name === "/resume") {
			if (args.length > 1)
				return this.sendDirect(chatId, "Usage: /resume [sessionId]");
			const sessionId =
				(args[0] as SessionId | undefined) ?? this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(
					chatId,
					"Provide a session ID or select a session with /use first.",
				);
			const result = await this.request(sender, { kind: "resume", sessionId });
			if (result.ok) {
				this.rememberSession(result.value as SessionSummary);
				await this.refreshExistingPanel(chatId, sender);
			}
			return this.sendDirect(
				chatId,
				result.ok
					? `Session ${this.sessionFooter(sessionId)} is running.`
					: result.error.message,
			);
		}
		if (name === "/inspect" && args.length <= 1) {
			const sessionId =
				(args[0] as SessionId | undefined) ?? this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(
					chatId,
					"Provide a session ID or select a session first.",
				);
			const result = await this.request(sender, { kind: "inspect", sessionId });
			if (result.ok) this.rememberSession(result.value as SessionSummary);
			return this.sendDirectHtml(
				chatId,
				result.ok
					? formatSession(result.value as SessionSummary)
					: escapeHtml(result.error.message),
			);
		}
		if (name === "/stop" && args.length <= 1) {
			const sessionId =
				(args[0] as SessionId | undefined) ?? this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(
					chatId,
					"Provide a session ID or select a session first.",
				);
			const result = await this.request(sender, { kind: "stop", sessionId });
			if (result.ok && this.selected.get(chatId) === sessionId) {
				this.clearSelected(chatId);
				this.previews.delete(chatId);
			}
			if (result.ok) await this.refreshExistingPanel(chatId, sender);
			return this.sendDirect(
				chatId,
				result.ok
					? `Session ${this.sessionFooter(sessionId)} stopped.`
					: result.error.message,
			);
		}
		if (name === "/delete") {
			if (args.length !== 1)
				return this.sendDirect(chatId, "Usage: /delete <sessionId>");
			const sessionId = args[0] as SessionId;
			const { result, cleanupPending } = await this.deleteSessionAndInbox(
				sender,
				sessionId,
			);
			if (result.ok) {
				this.sessionNames.delete(sessionId);
				this.knownSessions.delete(sessionId);
				this.reportedErrors.delete(sessionId);
				for (const [selectedChat, selectedId] of this.selected) {
					if (selectedId === sessionId) {
						this.clearSelected(selectedChat);
						this.previews.delete(selectedChat);
					}
				}
				await this.refreshExistingPanel(chatId, sender);
			}
			return this.sendDirect(
				chatId,
				result.ok
					? `Deleted stopped session ${this.sessionFooter(sessionId)} from harnessd.${cleanupPending ? " Inbox cleanup is pending." : ""}`
					: result.error.message,
			);
		}
		if (name === "/cancel" && args.length === 1) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId) return this.sendDirect(chatId, "Select a session first.");
			const result = await this.request(sender, {
				kind: "cancel",
				sessionId,
				inputId: args[0] as never,
			});
			return this.sendDirect(
				chatId,
				result.ok
					? `Cancellation requested for ${sessionId}.`
					: result.error.message,
			);
		}
		return this.sendDirect(chatId, "Invalid command. Use /help.");
	}

	private async renameCommand(
		chatId: number,
		sender: number,
		remainder: string,
	): Promise<void> {
		const trimmed = remainder.trim();
		if (!trimmed)
			return this.sendDirect(
				chatId,
				"Usage: /rename [sessionId] <name> (or --clear).",
			);
		let sessionId = this.selected.get(chatId);
		let nameText = trimmed;
		const firstSpace = trimmed.search(/\s/);
		const firstToken = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
		if (firstSpace > 0 && isSessionIdToken(firstToken)) {
			const explicitId =
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					firstToken,
				);
			if (explicitId) {
				sessionId = firstToken as SessionId;
				nameText = trimmed.slice(firstSpace + 1).trim();
			} else {
				const inspected = await this.request(sender, {
					kind: "inspect",
					sessionId: firstToken as SessionId,
				});
				if (inspected.ok) {
					sessionId = firstToken as SessionId;
					nameText = trimmed.slice(firstSpace + 1).trim();
				} else if (inspected.error.code !== "SESSION_NOT_FOUND") {
					return this.sendDirect(chatId, inspected.error.message);
				}
			}
		}
		if (!sessionId)
			return this.sendDirect(
				chatId,
				"Provide a session ID or select a session first.",
			);
		if (!nameText)
			return this.sendDirect(
				chatId,
				"Usage: /rename [sessionId] <name> (or --clear).",
			);
		const name = nameText === "--clear" ? undefined : nameText;
		const result = await this.request(sender, {
			kind: "rename",
			sessionId,
			...(name !== undefined ? { name } : {}),
		});
		if (!result.ok) return this.sendDirect(chatId, result.error.message);
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		await this.refreshExistingPanel(chatId, sender);
		await this.sendDirect(
			chatId,
			`Session name updated: ${sessionLabel(session)}.`,
		);
	}

	private async promptForName(
		chatId: number,
		flow: PendingNameRequest,
		text: string,
	): Promise<void> {
		const sent = await this.telegramCall((signal) =>
			this.bot.api.sendMessage(
				chatId,
				text,
				{ reply_markup: { force_reply: true, selective: true } },
				signal,
			),
		);
		const messageId = sent.ok ? messageIdFrom(sent.value) : undefined;
		if (messageId === undefined) {
			await this.sendDirect(
				chatId,
				"Could not open the name prompt; use /rename instead.",
			);
			return;
		}
		let pending = this.pendingNames.get(chatId);
		if (!pending) {
			pending = new Map();
			this.pendingNames.set(chatId, pending);
		}
		const pendingFlow: PendingNameFlow =
			flow.kind === "create"
				? { ...flow, promptMessageId: messageId }
				: { ...flow, promptMessageId: messageId };
		pending.set(messageId, pendingFlow);
		while (pending.size > 8) {
			const oldest = pending.keys().next().value as number | undefined;
			if (oldest === undefined) break;
			pending.delete(oldest);
		}
	}

	private async handleNameReply(
		chatId: number,
		sender: number,
		flow: PendingNameFlow,
		text: string,
	): Promise<void> {
		const pending = this.pendingNames.get(chatId);
		pending?.delete(flow.promptMessageId);
		if (pending?.size === 0) this.pendingNames.delete(chatId);
		const reply = text.trim();
		if (reply === "/cancel")
			return this.sendDirect(chatId, "Name operation cancelled.");
		if (!reply || (flow.kind === "rename" && reply === "/skip"))
			return this.sendDirect(
				chatId,
				"Name was not changed; use /rename to retry.",
			);
		if (flow.kind === "create") {
			const name = reply === "/skip" ? undefined : text;
			const result = await this.request(sender, {
				kind: "create",
				harnessId: "pi-rpc" as AdapterId,
				cwd: flow.cwd,
				...(name !== undefined ? { name } : {}),
			});
			if (!result.ok) return this.sendDirect(chatId, result.error.message);
			const session = result.value as SessionSummary;
			this.rememberSession(session);
			this.setSelected(chatId, session.id);
			this.previews.delete(chatId);
			await this.refreshExistingPanel(chatId, sender);
			return this.sendDirect(
				chatId,
				`Created and selected ${sessionLabel(session)}.`,
			);
		}
		const result = await this.request(sender, {
			kind: "rename",
			sessionId: flow.sessionId,
			name: text,
		});
		if (!result.ok) return this.sendDirect(chatId, result.error.message);
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		await this.refreshExistingPanel(chatId, sender);
		await this.sendDirect(
			chatId,
			`Session name updated: ${sessionLabel(session)}.`,
		);
	}

	private request(
		sender: number,
		request: TelegramRequest,
	): Promise<TransportResult> {
		const operation = () => this.dispatchRequest(sender, request);
		if (this.inbox && (request.kind === "resume" || request.kind === "submit"))
			return this.inbox.withSessionLock(request.sessionId, operation);
		return operation();
	}

	private dispatchRequest(
		sender: number,
		request: TelegramRequest,
	): Promise<TransportResult> {
		if (!this.dispatch) throw new Error("Transport is not started");
		return this.dispatch({
			...request,
			requestId: randomUUID(),
			principalId: String(sender),
		} as TransportEvent);
	}

	private async renderPanel(
		chatId: number,
		sender: number,
		messageId?: number,
	): Promise<void> {
		const listed = await this.request(sender, { kind: "list" });
		const sessions = listed.ok
			? (listed.value as readonly SessionSummary[])
			: [];
		if (listed.ok) this.rememberSessions(sessions);
		const selectedId = this.selected.get(chatId);
		if (selectedId && !sessions.some((session) => session.id === selectedId)) {
			this.clearSelected(chatId);
			this.previews.delete(chatId);
		}
		let previewId = this.previews.get(chatId);
		if (previewId && !sessions.some((session) => session.id === previewId)) {
			this.previews.delete(chatId);
			previewId = undefined;
		}
		if (!previewId) {
			previewId = this.selected.get(chatId) ?? sessions[0]?.id;
			if (previewId && previewId !== this.selected.get(chatId))
				this.previews.set(chatId, previewId);
		}
		const current = sessions.find(
			(session) => session.id === this.selected.get(chatId),
		);
		const preview = sessions.find((session) => session.id === previewId);
		let status: HarnessSessionStatus | undefined;
		if (preview) {
			const result = await this.request(sender, {
				kind: "session_status",
				sessionId: preview.id,
			});
			if (result.ok) {
				status = result.value as HarnessSessionStatus;
				this.rememberSession(status.session);
			}
		}
		const lines = [
			"📌 Текущая сессия",
			`Выбрана: ${current ? sessionLabel(current) : "не выбрана"}`,
		];
		if (preview && preview.id !== current?.id)
			lines.push(`Просмотр: ${sessionLabel(preview)}`);
		const display = status?.session ?? preview ?? current;
		if (display) {
			lines.push(
				`Папка: ${panelPath(display.cwd)}`,
				`Статус: ${display.status}`,
			);
			lines.push(compactUsage(status?.live?.usage));
			if (status?.live?.model)
				lines.push(
					`Модель: ${modelId(status.live.model)}${status.live.effort ? ` · ${oneLine(status.live.effort)}` : ""}`,
				);
		} else if (!listed.ok) lines.push(listed.error.message);
		else
			lines.push(
				`Папка: ${panelPath(this.currentDirectories.get(chatId) ?? this.options.initialCwd)}`,
			);
		const rows: InlineButton[][] = [];
		if (sessions.length)
			rows.push([
				inlineButton("◀", "session:prev"),
				inlineButton("Выбрать", "session:choose"),
				inlineButton("▶", "session:next"),
			]);
		rows.push([
			inlineButton("Сессии", "menu:sessions"),
			inlineButton("Папки", "menu:folders"),
		]);
		rows.push([inlineButton("Новая сессия", "menu:new")]);
		rows.push([
			inlineButton("Модель", "menu:models"),
			inlineButton("Усилие", "menu:efforts"),
		]);
		if (current)
			rows.push([
				inlineButton("Остановить", `session:stop:${current.id}`),
				inlineButton("Удалить", `session:delete:${current.id}`),
			]);
		await this.updatePanel(chatId, lines.join("\n"), keyboard(rows), messageId);
	}

	private async refreshExistingPanel(
		chatId: number,
		sender: number,
	): Promise<void> {
		const messageId =
			this.panelMessageIds.get(chatId) ?? this.panelStore?.get(chatId);
		if (messageId !== undefined)
			await this.renderPanel(chatId, sender, messageId);
	}

	private async updatePanel(
		chatId: number,
		text: string,
		replyMarkup: unknown,
		messageId?: number,
	): Promise<boolean> {
		const existing =
			messageId ??
			this.panelMessageIds.get(chatId) ??
			this.panelStore?.get(chatId);
		if (existing !== undefined) {
			const edited = await this.telegramCall((signal) =>
				this.bot.api.editMessageText(
					chatId,
					existing,
					text,
					{ reply_markup: replyMarkup },
					signal,
				),
			);
			if (edited.ok || isMessageNotModified(edited.error)) {
				await this.savePanelReference(chatId, existing);
				return true;
			}
			if (!isMessageNotFound(edited.error)) return false;
		}
		const sent = await this.telegramCall((signal) =>
			this.bot.api.sendMessage(
				chatId,
				text,
				{ reply_markup: replyMarkup },
				signal,
			),
		);
		if (!sent.ok) return false;
		const createdMessageId = messageIdFrom(sent.value);
		if (createdMessageId === undefined) return false;
		await this.savePanelReference(chatId, createdMessageId);
		const pinned = await this.telegramCall((signal) =>
			this.bot.api.pinChatMessage(chatId, createdMessageId, {}, signal),
		);
		if (!pinned.ok || pinned.value === false) {
			this.reportError(
				"Telegram control panel could not be pinned",
				pinned.ok ? new Error("Telegram returned false") : pinned.error,
			);
			await this.sendDirect(
				chatId,
				"Панель открыта, но Telegram не закрепил её. Её можно обновить командой /menu.",
			);
		}
		return true;
	}

	private async savePanelReference(
		chatId: number,
		messageId: number,
	): Promise<void> {
		this.panelMessageIds.set(chatId, messageId);
		try {
			await this.panelStore?.set(chatId, messageId);
		} catch (error) {
			this.reportError("Telegram panel reference could not be saved", error);
		}
	}

	private async onCallback(ctx: CallbackQueryContext): Promise<void> {
		const chatId = ctx.chat?.id;
		const sender = ctx.from?.id;
		const callback = ctx.callbackQuery;
		if (!callback) return;
		const messageId = callback.message?.message_id;
		if (
			!this.isAuthorized(ctx) ||
			chatId === undefined ||
			sender === undefined ||
			messageId === undefined
		)
			return;
		await this.telegramCall((signal) =>
			this.bot.api.answerCallbackQuery(callback.id, {}, signal),
		);
		await this.savePanelReference(chatId, messageId);
		if (!callback.data || callback.data.length > 64) return;
		try {
			await this.dispatchCallback(chatId, sender, callback.data, messageId);
		} catch (error) {
			const reference = this.reportError(
				"Telegram callback action failed",
				error,
			);
			await this.sendDiagnostic(
				chatId,
				`Не удалось выполнить действие (ref ${reference}). Попробуйте открыть /menu ещё раз.\n\n${describeError(error, [this.options.token])}`,
			);
		}
	}

	private async dispatchCallback(
		chatId: number,
		sender: number,
		data: string,
		messageId: number,
	): Promise<void> {
		if (data === "menu:home")
			return this.renderPanel(chatId, sender, messageId);
		if (data === "session:prev" || data === "session:next")
			return this.browseSessions(
				chatId,
				sender,
				data === "session:prev" ? -1 : 1,
				messageId,
			);
		if (data === "session:choose")
			return this.choosePreview(chatId, sender, messageId);
		if (data === "menu:sessions")
			return this.renderSessions(chatId, sender, messageId);
		if (data === "menu:folders")
			return this.renderFolders(chatId, sender, messageId);
		if (data === "menu:new")
			return this.promptForName(
				chatId,
				{
					kind: "create",
					cwd: this.currentDirectories.get(chatId) ?? this.options.initialCwd,
				},
				"Ответьте именем новой сессии или /skip, чтобы создать её без имени. Для отмены ответьте /cancel.",
			);
		if (data === "folder:parent")
			return this.changeFolder(chatId, sender, "parent", messageId);
		if (data === "folder:new")
			return this.promptForName(
				chatId,
				{
					kind: "create",
					cwd: this.currentDirectories.get(chatId) ?? this.options.initialCwd,
				},
				`Ответьте именем сессии для папки ${oneLine(this.currentDirectories.get(chatId) ?? this.options.initialCwd)} или /skip. Для отмены — /cancel.`,
			);
		if (data.startsWith("folder:page:"))
			return this.setPageAndRender(
				chatId,
				sender,
				"folder",
				data.slice(12),
				messageId,
			);
		if (data.startsWith("folder:open:"))
			return this.openFolder(chatId, sender, data.slice(12), messageId);
		if (data.startsWith("sessions:page:"))
			return this.setPageAndRender(
				chatId,
				sender,
				"session",
				data.slice(14),
				messageId,
			);
		if (data.startsWith("session:select:")) {
			const id = this.sessionCallbackId(data.slice(15));
			return id
				? this.selectSession(chatId, sender, id, messageId)
				: this.showStaleCallback(chatId, messageId);
		}
		if (data.startsWith("session:details:")) {
			const id = this.sessionCallbackId(data.slice(16));
			return id
				? this.renderSessionDetails(chatId, sender, id, messageId)
				: this.showStaleCallback(chatId, messageId);
		}
		if (data.startsWith("session:resume:")) {
			const id = this.sessionCallbackId(data.slice(15));
			return id
				? this.resumeSessionFromPanel(chatId, sender, id, messageId)
				: this.showStaleCallback(chatId, messageId);
		}
		if (data.startsWith("session:rename:")) {
			const id = this.sessionCallbackId(data.slice(15));
			return id
				? this.promptRename(chatId, sender, id)
				: this.showStaleCallback(chatId, messageId);
		}
		if (data.startsWith("session:clear:")) {
			const id = this.sessionCallbackId(data.slice(14));
			return id
				? this.clearSessionName(chatId, sender, id, messageId)
				: this.showStaleCallback(chatId, messageId);
		}
		if (data.startsWith("session:stop:")) {
			const id = this.sessionCallbackId(data.slice(13));
			return id
				? this.confirmSessionAction(chatId, sender, "stop", id, messageId)
				: this.showStaleCallback(chatId, messageId);
		}
		if (data.startsWith("session:delete:")) {
			const id = this.sessionCallbackId(data.slice(15));
			return id
				? this.confirmSessionAction(chatId, sender, "delete", id, messageId)
				: this.showStaleCallback(chatId, messageId);
		}
		if (data.startsWith("action:confirm-stop:")) {
			const id = this.sessionCallbackId(data.slice(20));
			return id
				? this.performSessionAction(chatId, sender, "stop", id, messageId)
				: this.showStaleCallback(chatId, messageId);
		}
		if (data.startsWith("action:confirm-delete:")) {
			const id = this.sessionCallbackId(data.slice(22));
			return id
				? this.performSessionAction(chatId, sender, "delete", id, messageId)
				: this.showStaleCallback(chatId, messageId);
		}
		if (data === "action:cancel")
			return this.renderSessions(chatId, sender, messageId);
		if (data === "menu:models")
			return this.renderModels(chatId, sender, messageId);
		if (data.startsWith("models:page:"))
			return this.setPageAndRender(
				chatId,
				sender,
				"model",
				data.slice(12),
				messageId,
			);
		if (data.startsWith("model:select:"))
			return this.applyModelChoice(chatId, sender, data.slice(13), messageId);
		if (data === "menu:efforts")
			return this.renderEfforts(chatId, sender, messageId);
		if (data.startsWith("efforts:page:"))
			return this.setPageAndRender(
				chatId,
				sender,
				"effort",
				data.slice(13),
				messageId,
			);
		if (data.startsWith("effort:select:"))
			return this.applyEffortChoice(chatId, sender, data.slice(14), messageId);
		if (data === "noop") return;
		await this.showStaleCallback(chatId, messageId);
	}

	private sessionCallbackId(rawId: string): SessionId | undefined {
		return isSessionIdToken(rawId) && this.knownSessions.has(rawId as SessionId)
			? (rawId as SessionId)
			: undefined;
	}

	private async showStaleCallback(
		chatId: number,
		messageId: number,
	): Promise<void> {
		await this.updatePanel(
			chatId,
			"Это действие устарело. Откройте /menu и выберите ещё раз.",
			keyboard([[inlineButton("В меню", "menu:home")]]),
			messageId,
		);
	}

	private async sendDirect(chatId: number, text: string): Promise<void> {
		const errorPrefixes = [
			"Invalid ",
			"Unsupported ",
			"Could not ",
			"Cannot ",
			"Failed ",
			"Request failed",
			"Operation failed",
			"No authorized ",
			"Select a session",
			"The session ",
			"This reply ",
			"Directory is ",
			"Attachment ",
			"Session is ",
			"Input delivery is ",
			"Usage:",
			"Не удалось",
			"Недоступно",
			"Некорректно",
			"Неподдерживаемая",
		];
		if (
			text.includes("\n\nError:") ||
			errorPrefixes.some((prefix) => text.startsWith(prefix))
		)
			return this.sendDiagnostic(chatId, text);
		for (const chunk of chunks(text || " "))
			await this.sendWithDeadline(chatId, chunk);
	}

	private async confirmInputAccepted(
		chatId: number,
		messageId: number | undefined,
		inputId: string,
		acknowledgement: string,
	): Promise<void> {
		if (messageId !== undefined)
			void this.reactToAcceptedInput(chatId, messageId, inputId);
		await this.sendDirect(chatId, acknowledgement);
	}

	private async reactToAcceptedInput(
		chatId: number,
		messageId: number,
		inputId: string,
	): Promise<void> {
		try {
			const reaction = await this.telegramCall((signal) =>
				this.bot.api.setMessageReaction(
					chatId,
					messageId,
					[{ type: "emoji", emoji: "👀" }],
					{},
					signal,
				),
			);
			if (!reaction.ok)
				this.reportError(
					"Telegram input acceptance reaction failed",
					reaction.error,
					[inputId],
				);
		} catch (error) {
			this.reportError("Telegram input acceptance reaction failed", error, [
				inputId,
			]);
		}
	}

	private async sendDiagnostic(chatId: number, text: string): Promise<void> {
		let body = "";
		for (const character of redactDiagnosticText(text, [this.options.token])) {
			const escaped = escapeHtml(character);
			if (body.length + escaped.length > 3900) {
				body += "\n… [trace truncated]";
				break;
			}
			body += escaped;
		}
		await this.sendWithDeadline(chatId, `<pre><code>${body}</code></pre>`, {
			parse_mode: "HTML",
		});
	}

	private reportError(
		context: string,
		error: unknown,
		redactions: readonly (string | undefined)[] = [],
	): string {
		const reference = randomUUID().slice(0, 8);
		const details = describeError(error, [this.options.token, ...redactions]);
		console.error(`harnessd: ${context} (ref ${reference})\n${details}`);
		return reference;
	}

	private async browseSessions(
		chatId: number,
		sender: number,
		direction: -1 | 1,
		messageId: number,
	): Promise<void> {
		const result = await this.request(sender, { kind: "list" });
		if (!result.ok) return this.sendDirect(chatId, result.error.message);
		const sessions = result.value as readonly SessionSummary[];
		this.rememberSessions(sessions);
		if (!sessions.length) return this.renderPanel(chatId, sender, messageId);
		const currentId =
			this.previews.get(chatId) ?? this.selected.get(chatId) ?? sessions[0]?.id;
		const currentIndex = sessions.findIndex(
			(session) => session.id === currentId,
		);
		const index =
			currentIndex < 0
				? 0
				: (currentIndex + direction + sessions.length) % sessions.length;
		const next = sessions[index];
		if (next) this.previews.set(chatId, next.id);
		await this.renderPanel(chatId, sender, messageId);
	}

	private async choosePreview(
		chatId: number,
		sender: number,
		messageId: number,
	): Promise<void> {
		const sessionId = this.previews.get(chatId) ?? this.selected.get(chatId);
		if (!sessionId) return this.renderPanel(chatId, sender, messageId);
		const result = await this.request(sender, { kind: "inspect", sessionId });
		if (!result.ok) {
			this.previews.delete(chatId);
			return this.renderPanel(chatId, sender, messageId);
		}
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		this.setSelected(chatId, session.id);
		this.previews.delete(chatId);
		await this.renderPanel(chatId, sender, messageId);
	}

	private async selectSession(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		messageId: number,
	): Promise<void> {
		const result = await this.request(sender, { kind: "inspect", sessionId });
		if (!result.ok) {
			await this.sendDirect(chatId, result.error.message);
			return this.renderSessions(chatId, sender, messageId);
		}
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		this.setSelected(chatId, session.id);
		this.previews.delete(chatId);
		await this.renderPanel(chatId, sender, messageId);
	}

	private async renderSessions(
		chatId: number,
		sender: number,
		messageId: number,
	): Promise<void> {
		const result = await this.request(sender, { kind: "list" });
		if (!result.ok) {
			await this.updatePanel(
				chatId,
				result.error.message,
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
			);
			return;
		}
		const sessions = result.value as readonly SessionSummary[];
		this.rememberSessions(sessions);
		const pageSize = 6;
		const lastPage = Math.max(0, Math.ceil(sessions.length / pageSize) - 1);
		const page = Math.min(
			Math.max(0, this.sessionPages.get(chatId) ?? 0),
			lastPage,
		);
		this.sessionPages.set(chatId, page);
		const visible = sessions.slice(page * pageSize, (page + 1) * pageSize);
		const rows: InlineButton[][] = visible.flatMap((session) => [
			[
				inlineButton(
					shortSessionLabel(session),
					`session:select:${session.id}`,
				),
				inlineButton("Подробнее", `session:details:${session.id}`),
			],
		]);
		if (lastPage > 0)
			rows.push([
				inlineButton("◀", `sessions:page:${Math.max(0, page - 1)}`),
				inlineButton(`${page + 1}/${lastPage + 1}`, "noop"),
				inlineButton("▶", `sessions:page:${Math.min(lastPage, page + 1)}`),
			]);
		rows.push([inlineButton("Назад", "menu:home")]);
		await this.updatePanel(
			chatId,
			sessions.length
				? `Сессии · ${sessions.length}\nВыберите сессию или откройте подробности.`
				: "Сохранённых сессий пока нет.",
			keyboard(rows),
			messageId,
		);
	}

	private async renderSessionDetails(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		messageId: number,
	): Promise<void> {
		const result = await this.request(sender, { kind: "inspect", sessionId });
		if (!result.ok) {
			await this.sendDirect(chatId, result.error.message);
			return this.renderSessions(chatId, sender, messageId);
		}
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		const rows: InlineButton[][] = [
			[
				inlineButton("Выбрать", `session:select:${session.id}`),
				inlineButton("Переименовать", `session:rename:${session.id}`),
			],
		];
		if (session.name)
			rows.push([inlineButton("Убрать имя", `session:clear:${session.id}`)]);
		if (session.status === "running")
			rows.push([inlineButton("Остановить…", `session:stop:${session.id}`)]);
		else if (session.status === "stopped")
			rows.push([inlineButton("Продолжить", `session:resume:${session.id}`)]);
		rows.push([inlineButton("Удалить…", `session:delete:${session.id}`)]);
		rows.push([inlineButton("К списку", "menu:sessions")]);
		await this.updatePanel(
			chatId,
			`${sessionLabel(session)}\nСтатус: ${session.status}\nПапка: ${panelPath(session.cwd)}`,
			keyboard(rows),
			messageId,
		);
	}

	private async setPageAndRender(
		chatId: number,
		sender: number,
		kind: "session" | "folder" | "model" | "effort",
		rawPage: string,
		messageId: number,
	): Promise<void> {
		const page = Number(rawPage);
		if (!Number.isSafeInteger(page) || page < 0)
			return this.showStaleCallback(chatId, messageId);
		if (kind === "session") {
			this.sessionPages.set(chatId, page);
			return this.renderSessions(chatId, sender, messageId);
		}
		if (kind === "folder") {
			this.folderPages.set(chatId, page);
			return this.renderFolders(chatId, sender, messageId);
		}
		if (kind === "model") {
			this.modelPages.set(chatId, page);
			return this.renderModels(chatId, sender, messageId);
		}
		this.effortPages.set(chatId, page);
		return this.renderEfforts(chatId, sender, messageId);
	}

	private async renderFolders(
		chatId: number,
		_sender: number,
		messageId: number,
	): Promise<void> {
		const directory =
			this.currentDirectories.get(chatId) ?? this.options.initialCwd;
		try {
			const listing = await listDirectoryEntries(directory);
			const folders = listing.entries
				.map((entry, index) => ({ entry, index }))
				.filter(({ entry }) => entry.kind === "directory");
			const pageSize = 8;
			const lastPage = Math.max(0, Math.ceil(folders.length / pageSize) - 1);
			const page = Math.min(
				Math.max(0, this.folderPages.get(chatId) ?? 0),
				lastPage,
			);
			this.folderPages.set(chatId, page);
			const visible = folders.slice(page * pageSize, (page + 1) * pageSize);
			const rows: InlineButton[][] = visible.map(({ entry, index }) => [
				inlineButton(
					`📁 ${buttonLabel(entry.name, 48)}/`,
					`folder:open:${index}`,
				),
			]);
			rows.push([
				inlineButton("Наверх", "folder:parent"),
				inlineButton("Создать здесь", "folder:new"),
			]);
			if (lastPage > 0)
				rows.push([
					inlineButton("◀", `folder:page:${Math.max(0, page - 1)}`),
					inlineButton(`${page + 1}/${lastPage + 1}`, "noop"),
					inlineButton("▶", `folder:page:${Math.min(lastPage, page + 1)}`),
				]);
			rows.push([inlineButton("Назад", "menu:home")]);
			await this.updatePanel(
				chatId,
				`Папки\n${panelPath(listing.cwd)}${listing.truncated ? `\nПоказаны первые ${listing.entries.length} элементов.` : ""}`,
				keyboard(rows),
				messageId,
			);
		} catch {
			await this.updatePanel(
				chatId,
				"Не удалось прочитать эту папку.",
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
			);
		}
	}

	private async changeFolder(
		chatId: number,
		sender: number,
		_direction: "parent",
		messageId: number,
	): Promise<void> {
		const current =
			this.currentDirectories.get(chatId) ?? this.options.initialCwd;
		try {
			this.currentDirectories.set(
				chatId,
				await resolveExistingDirectory(path.dirname(current)),
			);
			this.folderPages.set(chatId, 0);
		} catch {
			return this.renderFolders(chatId, sender, messageId);
		}
		await this.renderFolders(chatId, sender, messageId);
	}

	private async openFolder(
		chatId: number,
		sender: number,
		rawIndex: string,
		messageId: number,
	): Promise<void> {
		const index = Number(rawIndex);
		if (!Number.isSafeInteger(index) || index < 0)
			return this.renderFolders(chatId, sender, messageId);
		const directory =
			this.currentDirectories.get(chatId) ?? this.options.initialCwd;
		try {
			const listing = await listDirectoryEntries(directory);
			const entry = listing.entries[index];
			if (entry?.kind !== "directory")
				return this.renderFolders(chatId, sender, messageId);
			this.currentDirectories.set(
				chatId,
				await resolveExistingDirectory(path.join(listing.cwd, entry.name)),
			);
			this.folderPages.set(chatId, 0);
		} catch {
			return this.renderFolders(chatId, sender, messageId);
		}
		await this.renderFolders(chatId, sender, messageId);
	}

	private async renderModels(
		chatId: number,
		sender: number,
		messageId: number,
	): Promise<void> {
		const sessionId = this.selected.get(chatId);
		if (!sessionId)
			return this.updatePanel(
				chatId,
				"Сначала выберите сессию.",
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
			).then(() => {});
		const result = await this.request(sender, {
			kind: "model_list",
			sessionId,
		});
		if (!result.ok)
			return this.updatePanel(
				chatId,
				result.error.message,
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
			).then(() => {});
		const catalog = result.value as HarnessModelCatalog;
		this.modelChoices.set(chatId, { sessionId, models: catalog.models });
		const pageSize = 8;
		const lastPage = Math.max(
			0,
			Math.ceil(catalog.models.length / pageSize) - 1,
		);
		const page = Math.min(
			Math.max(0, this.modelPages.get(chatId) ?? 0),
			lastPage,
		);
		this.modelPages.set(chatId, page);
		const rows: InlineButton[][] = catalog.models
			.slice(page * pageSize, (page + 1) * pageSize)
			.map((model, offset) => {
				const index = page * pageSize + offset;
				const current =
					catalog.current?.provider === model.provider &&
					catalog.current.id === model.id;
				return [
					inlineButton(
						`${current ? "✓ " : ""}${buttonLabel(modelId(model), 50)}`,
						`model:select:${index}`,
					),
				];
			});
		if (lastPage > 0)
			rows.push([
				inlineButton("◀", `models:page:${Math.max(0, page - 1)}`),
				inlineButton(`${page + 1}/${lastPage + 1}`, "noop"),
				inlineButton("▶", `models:page:${Math.min(lastPage, page + 1)}`),
			]);
		rows.push([inlineButton("Назад", "menu:home")]);
		await this.updatePanel(
			chatId,
			`Модель · ${sessionLabel({ id: sessionId, name: this.sessionNames.get(sessionId) })}`,
			keyboard(rows),
			messageId,
		);
	}

	private async applyModelChoice(
		chatId: number,
		sender: number,
		rawIndex: string,
		messageId: number,
	): Promise<void> {
		const choices = this.modelChoices.get(chatId);
		const index = Number(rawIndex);
		const model = choices?.models[index];
		if (
			!choices ||
			!Number.isSafeInteger(index) ||
			!model ||
			this.selected.get(chatId) !== choices.sessionId
		)
			return this.renderModels(chatId, sender, messageId);
		const result = await this.request(sender, {
			kind: "model_set",
			sessionId: choices.sessionId,
			provider: model.provider,
			modelId: model.id,
		});
		if (!result.ok) {
			await this.sendDirect(chatId, result.error.message);
			return this.renderModels(chatId, sender, messageId);
		}
		const change = result.value as HarnessModelChangeResult;
		if (change.effortConfirmed === false)
			await this.sendDirect(
				chatId,
				`Модель выбрана, но усилие не подтверждено. Проверьте /status перед повтором.`,
			);
		await this.renderPanel(chatId, sender, messageId);
	}

	private async renderEfforts(
		chatId: number,
		sender: number,
		messageId: number,
	): Promise<void> {
		const sessionId = this.selected.get(chatId);
		if (!sessionId)
			return this.updatePanel(
				chatId,
				"Сначала выберите сессию.",
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
			).then(() => {});
		const result = await this.request(sender, {
			kind: "effort_list",
			sessionId,
		});
		if (!result.ok)
			return this.updatePanel(
				chatId,
				result.error.message,
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
			).then(() => {});
		const catalog = result.value as HarnessEffortCatalog;
		this.effortChoices.set(chatId, { sessionId, levels: catalog.levels });
		const pageSize = 8;
		const lastPage = Math.max(
			0,
			Math.ceil(catalog.levels.length / pageSize) - 1,
		);
		const page = Math.min(
			Math.max(0, this.effortPages.get(chatId) ?? 0),
			lastPage,
		);
		this.effortPages.set(chatId, page);
		const rows: InlineButton[][] = catalog.levels
			.slice(page * pageSize, (page + 1) * pageSize)
			.map((level, offset) => {
				const index = page * pageSize + offset;
				return [
					inlineButton(
						`${catalog.current === level ? "✓ " : ""}${buttonLabel(level, 50)}`,
						`effort:select:${index}`,
					),
				];
			});
		if (lastPage > 0)
			rows.push([
				inlineButton("◀", `efforts:page:${Math.max(0, page - 1)}`),
				inlineButton(`${page + 1}/${lastPage + 1}`, "noop"),
				inlineButton("▶", `efforts:page:${Math.min(lastPage, page + 1)}`),
			]);
		rows.push([inlineButton("Назад", "menu:home")]);
		await this.updatePanel(
			chatId,
			`Усилие · ${catalog.current ? oneLine(catalog.current) : "не задано"}`,
			keyboard(rows),
			messageId,
		);
	}

	private async applyEffortChoice(
		chatId: number,
		sender: number,
		rawIndex: string,
		messageId: number,
	): Promise<void> {
		const choices = this.effortChoices.get(chatId);
		const index = Number(rawIndex);
		const effort = choices?.levels[index];
		if (
			!choices ||
			!Number.isSafeInteger(index) ||
			effort === undefined ||
			this.selected.get(chatId) !== choices.sessionId
		)
			return this.renderEfforts(chatId, sender, messageId);
		const result = await this.request(sender, {
			kind: "effort_set",
			sessionId: choices.sessionId,
			effort,
		});
		if (!result.ok) await this.sendDirect(chatId, result.error.message);
		await this.renderPanel(chatId, sender, messageId);
	}

	private async resumeSessionFromPanel(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		messageId: number,
	): Promise<void> {
		const result = await this.request(sender, { kind: "resume", sessionId });
		if (!result.ok) await this.sendDirect(chatId, result.error.message);
		else this.rememberSession(result.value as SessionSummary);
		await this.renderSessionDetails(chatId, sender, sessionId, messageId);
	}

	private async promptRename(
		chatId: number,
		sender: number,
		sessionId: SessionId,
	): Promise<void> {
		const result = await this.request(sender, { kind: "inspect", sessionId });
		if (!result.ok) return this.sendDirect(chatId, result.error.message);
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		await this.promptForName(
			chatId,
			{ kind: "rename", sessionId },
			`Ответьте новым именем для ${sessionLabel(session)}. Для отмены ответьте /cancel.`,
		);
	}

	private async clearSessionName(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		messageId: number,
	): Promise<void> {
		const result = await this.request(sender, { kind: "rename", sessionId });
		if (!result.ok) {
			await this.sendDirect(chatId, result.error.message);
			return this.renderSessionDetails(chatId, sender, sessionId, messageId);
		}
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		await this.renderSessionDetails(chatId, sender, sessionId, messageId);
	}

	private async confirmSessionAction(
		chatId: number,
		sender: number,
		action: "stop" | "delete",
		sessionId: SessionId,
		messageId: number,
	): Promise<void> {
		const result = await this.request(sender, { kind: "inspect", sessionId });
		if (!result.ok) {
			await this.sendDirect(chatId, result.error.message);
			return this.renderSessions(chatId, sender, messageId);
		}
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		const prompt =
			action === "stop"
				? `Остановить ${sessionLabel(session)}?`
				: `Удалить запись ${sessionLabel(session)}? Будут удалены только метаданные harnessd; файлы Pi и папка проекта останутся.`;
		const confirmData =
			action === "stop"
				? `action:confirm-stop:${sessionId}`
				: `action:confirm-delete:${sessionId}`;
		await this.updatePanel(
			chatId,
			prompt,
			keyboard([
				[
					inlineButton("Подтвердить", confirmData),
					inlineButton("Отмена", "action:cancel"),
				],
			]),
			messageId,
		);
	}

	private async performSessionAction(
		chatId: number,
		sender: number,
		action: "stop" | "delete",
		sessionId: SessionId,
		messageId: number,
	): Promise<void> {
		const { result, cleanupPending } =
			action === "delete"
				? await this.deleteSessionAndInbox(sender, sessionId)
				: {
						result: await this.request(sender, {
							kind: action,
							sessionId,
						} as TelegramRequest),
						cleanupPending: false,
					};
		if (!result.ok) {
			await this.sendDirect(chatId, result.error.message);
			return this.renderPanel(chatId, sender, messageId);
		}
		if (action === "stop") {
			if (this.selected.get(chatId) === sessionId) {
				this.clearSelected(chatId);
				this.previews.delete(chatId);
			}
		} else {
			this.sessionNames.delete(sessionId);
			this.knownSessions.delete(sessionId);
			this.reportedErrors.delete(sessionId);
			if (cleanupPending)
				await this.sendDirect(
					chatId,
					"Session deleted; inbox cleanup is pending.",
				);
			for (const [selectedChat, selectedId] of this.selected) {
				if (selectedId === sessionId) {
					this.clearSelected(selectedChat);
					this.previews.delete(selectedChat);
				}
			}
		}
		await this.renderPanel(chatId, sender, messageId);
	}

	private async sendDirectHtml(chatId: number, text: string): Promise<void> {
		for (const chunk of chunks(text || " "))
			await this.sendWithDeadline(chatId, chunk, { parse_mode: "HTML" });
	}

	private startTyping(sessionId: SessionId): void {
		this.activeTypingSessions.add(sessionId);
		if (![...this.selected.values()].includes(sessionId)) return;
		if (!this.typingTimers.has(sessionId)) {
			const send = () => this.refreshTyping(sessionId);
			this.typingTimers.set(sessionId, setInterval(send, TYPING_REFRESH_MS));
		}
		this.refreshTyping(sessionId);
	}

	private refreshTyping(sessionId: SessionId): void {
		if (!this.typingTimers.has(sessionId)) return;
		const chats = new Set(
			[...this.selected]
				.filter(([, id]) => id === sessionId)
				.map(([chatId]) => chatId),
		);
		this.typingChats.set(sessionId, chats);
		for (const chatId of chats)
			void this.telegramCall((signal) =>
				this.bot.api.sendChatAction(chatId, "typing", {}, signal),
			);
		if (!chats.size) this.clearTypingTimer(sessionId);
	}

	private stopTyping(sessionId: SessionId): void {
		this.activeTypingSessions.delete(sessionId);
		this.clearTypingTimer(sessionId);
	}

	private clearTypingTimer(sessionId: SessionId): void {
		const timer = this.typingTimers.get(sessionId);
		if (timer) clearInterval(timer);
		this.typingTimers.delete(sessionId);
		this.typingChats.delete(sessionId);
	}

	private onEvent(event: HarnessEvent): void {
		if (event.kind === "output" && typeof event.text === "string") {
			this.appendTurnOutput(event.sessionId, event.text);
			return;
		}
		if (event.kind === "status") {
			if (event.text === "harness_recovered")
				this.reportedErrors.delete(event.sessionId);
			if (event.text === "agent_start") {
				this.startTyping(event.sessionId);
				this.turnBuffers.set(event.sessionId, {
					chunks: [],
					characters: 0,
					overflow: false,
				});
				return;
			}
			if (event.text === "agent_end") return;
			if (event.text === "agent_settled") {
				this.stopTyping(event.sessionId);
				this.flushTurn(event.sessionId);
				return;
			}
			if (event.text === "harness_recovery_failed")
				this.stopTyping(event.sessionId);
			if (
				event.text === "harness_restarting" ||
				event.text === "harness_recovered" ||
				event.text === "harness_recovery_failed"
			)
				this.flushTurn(event.sessionId, true);
			this.enqueueForSelected(event.sessionId, statusMessage(event.text));
			return;
		}
		if (event.kind === "error") {
			this.stopTyping(event.sessionId);
			this.flushTurn(event.sessionId, true);
			if (this.reportedErrors.has(event.sessionId)) return;
			this.reportedErrors.add(event.sessionId);
			this.enqueueForSelected(event.sessionId, "Session reported an error.");
			return;
		}
		if (event.kind === "input" && event.inputEvent) {
			const { inputId, state } = event.inputEvent;
			if (state === "failed" || state === "uncertain")
				this.stopTyping(event.sessionId);
			if (state === "accepted") return;
			this.enqueueForSelected(
				event.sessionId,
				`Input ${inputId}: ${state}${state === "uncertain" ? " (not resent)" : ""}`,
				{ inputId, state },
			);
		}
	}

	private appendTurnOutput(sessionId: SessionId, text: string): void {
		let buffer = this.turnBuffers.get(sessionId);
		if (!buffer) {
			buffer = { chunks: [], characters: 0, overflow: false };
			this.turnBuffers.set(sessionId, buffer);
		}
		const remaining = MAX_QUEUED_CHARACTERS - buffer.characters;
		if (remaining <= 0) {
			buffer.overflow = true;
			return;
		}
		let kept = text;
		if (kept.length > remaining) {
			kept = kept.slice(0, remaining);
			if (/[\uD800-\uDBFF]/.test(kept.at(-1) ?? "")) kept = kept.slice(0, -1);
			buffer.overflow = true;
		}
		if (kept) {
			buffer.chunks.push(kept);
			buffer.characters += kept.length;
		}
	}

	private flushTurn(sessionId: SessionId, interrupted = false): void {
		const buffer = this.turnBuffers.get(sessionId);
		this.turnBuffers.delete(sessionId);
		if (!buffer || (buffer.characters === 0 && !buffer.overflow)) return;
		let text = buffer.chunks.join("");
		if (interrupted) text += "\n\n[Response interrupted before completion.]";
		if (buffer.overflow)
			text +=
				"\n\n[Additional output omitted because the response reached the queue limit.]";
		this.enqueueForSelected(sessionId, text);
	}

	private enqueueForSelected(
		sessionId: SessionId,
		text: string,
		input?: { readonly inputId: string; readonly state: string },
	): void {
		for (const [chatId, selectedId] of this.selected) {
			if (selectedId === sessionId)
				this.enqueue(chatId, sessionId, text, input);
		}
	}

	private sessionFooter(sessionId: SessionId): string {
		const name = this.sessionNames.get(sessionId);
		return `${name ? `${oneLine(name)} · ` : ""}#${sessionId}`;
	}

	private eventFooter(sessionId: SessionId): string {
		const name = this.sessionNames.get(sessionId);
		return `${name ? `${oneLine(name)} · ` : ""}${sessionId}`;
	}

	private rememberSession(session: SessionSummary): void {
		this.knownSessions.add(session.id);
		this.sessionCwds.set(session.id, session.cwd);
		if (session.name) this.sessionNames.set(session.id, session.name);
		else this.sessionNames.delete(session.id);
	}

	private rememberSessions(sessions: readonly SessionSummary[]): void {
		const present = new Set(sessions.map((session) => session.id));
		for (const sessionId of this.knownSessions) {
			if (!present.has(sessionId)) {
				this.knownSessions.delete(sessionId);
				this.sessionNames.delete(sessionId);
				this.reportedErrors.delete(sessionId);
			}
		}
		for (const session of sessions) this.rememberSession(session);
	}

	private enqueue(
		chatId: number,
		sessionId: SessionId,
		text: string,
		input?: { readonly inputId: string; readonly state: string },
	): void {
		let queue = this.queues.get(chatId);
		if (!queue) {
			queue = {
				messages: [],
				pendingCharacters: 0,
				failed: false,
				overflowQueued: false,
			};
			this.queues.set(chatId, queue);
		}
		if (queue.failed || this.stopping) return;
		const parts = splitMessageWithFooter(text, this.eventFooter(sessionId));
		if (input) {
			this.enqueueInput(queue, sessionId, parts[0] ?? text, input);
			this.scheduleDrain(chatId, queue);
			return;
		}
		for (const part of parts) {
			const outputCount = queue.messages.filter(
				(message) => !message.inputId && !message.overflow,
			).length;
			if (
				outputCount >= MAX_OUTPUT_MESSAGES ||
				queue.messages.length >= MAX_QUEUED_MESSAGES ||
				queue.pendingCharacters + part.length >
					MAX_QUEUED_CHARACTERS - INPUT_CHARACTER_RESERVE
			) {
				this.queueOverflow(queue, sessionId);
				break;
			}
			queue.messages.push({ sessionId, text: part });
			queue.pendingCharacters += part.length;
		}
		this.scheduleDrain(chatId, queue);
	}

	private enqueueInput(
		queue: ChatQueue,
		sessionId: SessionId,
		text: string,
		input: { readonly inputId: string; readonly state: string },
	): void {
		const existingIndex = queue.messages.findIndex(
			(message) => message.inputId === input.inputId,
		);
		if (existingIndex >= 0) {
			const existing = queue.messages[existingIndex];
			if (!existing || existing.inputState === "uncertain") return;
			const [superseded] = queue.messages.splice(existingIndex, 1);
			if (superseded) queue.pendingCharacters -= superseded.text.length;
		}
		const messageCharacters = text.length;
		while (
			queue.messages.filter((message) => message.inputId !== undefined)
				.length >= MAX_INPUT_MESSAGES ||
			queue.messages.length >= MAX_QUEUED_MESSAGES + 1 ||
			queue.pendingCharacters + messageCharacters > MAX_QUEUED_CHARACTERS
		) {
			const outputIndex = queue.messages.findIndex(
				(message) => !message.inputId && !message.overflow,
			);
			if (outputIndex >= 0) {
				const [removed] = queue.messages.splice(outputIndex, 1);
				if (removed) queue.pendingCharacters -= removed.text.length;
				this.queueOverflow(queue, sessionId);
				continue;
			}
			const replaceableInputIndex = queue.messages.findIndex(
				(message) => message.inputId && message.inputState !== "uncertain",
			);
			if (replaceableInputIndex >= 0) {
				const [removed] = queue.messages.splice(replaceableInputIndex, 1);
				if (removed) queue.pendingCharacters -= removed.text.length;
				continue;
			}
			return;
		}
		queue.messages.push({
			sessionId,
			text,
			inputId: input.inputId,
			inputState: input.state,
		});
		queue.pendingCharacters += messageCharacters;
	}

	private queueOverflow(queue: ChatQueue, sessionId: SessionId): void {
		if (queue.overflowQueued) return;
		queue.overflowQueued = true;
		const notice = {
			sessionId,
			text:
				splitMessageWithFooter(
					OVERFLOW_NOTICE,
					this.eventFooter(sessionId),
				)[0] ?? OVERFLOW_NOTICE,
			overflow: true as const,
		};
		queue.messages.push(notice);
		queue.pendingCharacters += notice.text.length;
	}

	private scheduleDrain(chatId: number, queue: ChatQueue): void {
		if (queue.draining || queue.drainTimer || !queue.messages.length) return;
		queue.drainTimer = setTimeout(() => {
			queue.drainTimer = undefined;
			const draining = Promise.resolve().then(() => this.drain(chatId, queue));
			queue.draining = draining;
			const finish = () => {
				if (queue.draining !== draining) return;
				queue.draining = undefined;
				this.scheduleDrain(chatId, queue);
			};
			void draining.then(finish, () => {
				queue.failed = true;
				queue.messages.length = 0;
				queue.pendingCharacters = 0;
				finish();
			});
		}, OUTPUT_COALESCE_MS);
	}

	private async drain(chatId: number, queue: ChatQueue): Promise<void> {
		while (!this.stopping && !queue.failed && queue.messages.length) {
			const message = queue.messages.shift();
			if (!message) break;
			queue.pendingCharacters -= message.text.length;
			if (message.overflow) queue.overflowQueued = false;
			if (this.selected.get(chatId) !== message.sessionId) continue;
			const delivered = await this.sendWithDeadline(
				chatId,
				message.text,
				sessionIdEntity(message.text, message.sessionId),
			);
			if (!delivered) {
				queue.failed = true;
				queue.messages.length = 0;
				queue.pendingCharacters = 0;
			}
		}
	}

	private sendWithDeadline(
		chatId: number,
		text: string,
		other?: unknown,
	): Promise<boolean> {
		return this.telegramCall((signal) =>
			this.bot.api.sendMessage(chatId, text, other, signal),
		).then((result) => result.ok);
	}

	private async telegramCall<T>(
		operation: (signal: AbortSignal) => Promise<T>,
	): Promise<
		| { readonly ok: true; readonly value: T }
		| { readonly ok: false; readonly error: unknown }
	> {
		if (this.stopping)
			return { ok: false, error: new Error("transport stopping") };
		const controller = new AbortController();
		this.pendingSends.add(controller);
		let sending: Promise<T>;
		try {
			sending = withDeadline(operation(controller.signal), SEND_TIMEOUT_MS);
		} catch (error) {
			this.pendingSends.delete(controller);
			return { ok: false, error };
		}
		const tracked = sending.then(
			() => true,
			() => false,
		);
		this.activeSends.add(tracked);
		void tracked.finally(() => this.activeSends.delete(tracked));
		try {
			return { ok: true, value: await sending };
		} catch (error) {
			controller.abort();
			return { ok: false, error };
		} finally {
			this.pendingSends.delete(controller);
		}
	}
}
