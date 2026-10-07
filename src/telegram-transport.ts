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
	HarnessActivityEvent,
	HarnessEvent,
	InputDeliveryState,
	InputId,
	SessionId,
	SessionSummary,
} from "./core/types.js";
import {
	describeError,
	redactDiagnosticText,
	truncateDiagnostic,
} from "./error-diagnostics.js";
import {
	listDirectoryEntries,
	parsePathArgument,
	resolveExistingDirectory,
	resolvePathFrom,
	safeAttachmentName,
} from "./telegram-filesystem.js";
import { TelegramInbox, TelegramInboxQuotaError } from "./telegram-inbox.js";
import { TelegramPanelStore } from "./telegram-panel-store.js";
import {
	parseNotificationText,
	SubagentTextStream,
} from "./telegram-subagent-stream.js";

const TELEGRAM_LIMIT = 4096;
const ACTIVITY_INPUT_HISTORY_LIMIT = 32;
const ACTIVITY_OVERFLOW_INPUT_LIMIT = 128;
const SEND_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 6000;
const MAX_QUEUED_MESSAGES = 32;
const MAX_OUTPUT_MESSAGES = 24;
const MAX_INPUT_MESSAGES = 8;
const MAX_OVERFLOW_NOTICES = 8;
const MAX_QUEUED_CHARACTERS = 32_768;
const INPUT_CHARACTER_RESERVE = 4096;
const OUTPUT_COALESCE_MS = 40;
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_DOWNLOAD_BYTES = 20_000_000;
const INBOX_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const TYPING_REFRESH_MS = 4000;
const OVERFLOW_NOTICE =
	"Additional notifications were omitted because the queue is full.";
const NAME_PROMPT_MARKER = "Name this session (harnessd name prompt):";
const NAME_PROMPT_ENVELOPE_PREFIX = `${NAME_PROMPT_MARKER}\n`;
const CREATE_NAME_INSTRUCTIONS =
	"Reply with a name. Create unnamed and Cancel buttons are below.";
const RENAME_NAME_INSTRUCTIONS = "Reply with a name; use Cancel below.";
const CREATE_NAME_PREFIX = "New session will be created in ";
const CREATE_NAME_FALLBACK =
	"The exact folder is shown in the preceding messages.";
const RENAME_NAME_FALLBACK =
	"in the exact folder shown in the preceding messages";
const RENAME_NAME_PREFIX = "Rename ";
const RENAME_NAME_SEPARATOR = " in ";
const MAX_CORRELATED_MESSAGES_PER_CHAT = 128;
const MAX_INPUT_ATTRIBUTIONS = 512;
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
		reply_to_message?: {
			message_id?: number;
			text?: string;
			from?: { id: number; is_bot?: boolean };
			entities?: readonly {
				type: string;
				offset: number;
				length: number;
			}[];
		};
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
		deleteMessage(
			chatId: number,
			messageId: number,
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
	readonly output?: true;
	readonly background?: true;
	readonly inputId?: string;
	inputState?: string;
	overflow?: true;
	overflowKey?: string;
};
type PendingNameFlow =
	| {
			readonly kind: "create";
			readonly cwd: string;
			readonly promptMessageId: number;
			choiceMessageId?: number;
			processing?: boolean;
	  }
	| {
			readonly kind: "rename";
			readonly sessionId: SessionId;
			readonly promptMessageId: number;
			choiceMessageId?: number;
			processing?: boolean;
	  };
type ReplyRoute = { readonly sessionId: SessionId };
type ReplyChoice = {
	readonly chatId: number;
	readonly sender: number;
	readonly incomingMessageId: number;
	choiceMessageId?: number;
	readonly sourceSession: SessionId;
	readonly selectedSession: SessionId;
	readonly text?: string;
	readonly message?: NonNullable<UpdateContext["message"]>;
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
	readonly overflowNotices: Set<string>;
	readonly idleWaiters: (() => void)[];
};
type TurnBuffer = {
	readonly chunks: string[];
	readonly subagentStream: SubagentTextStream;
	subagentStatus?: string;
	readonly recipients: Set<number>;
	readonly statusRecipients: Set<number>;
	readonly pendingInputs: Set<InputId>;
	characters: number;
	settled: boolean;
	interrupted: boolean;
	overflow: boolean;
};
type InputAttribution = {
	readonly inputId: InputId;
	readonly sessionId: SessionId;
	chatId?: number;
	state: InputDeliveryState;
	terminal: boolean;
	pendingSeen: boolean;
	steered: boolean;
	waitingForRun: boolean;
	turn?: TurnBuffer;
};
type InFlightSubmission = { readonly chatId: number };
type FolderIntent = {
	readonly chatId: number;
	messageId: number;
	readonly generation: number;
	readonly parent: string;
	readonly target: string;
};
type ConfirmationIntent = {
	readonly chatId: number;
	messageId: number;
	readonly generation: number;
	readonly invalidationEpoch: number;
	readonly sessionId: SessionId;
	readonly action: "stop" | "delete";
	readonly expectedStatus: SessionSummary["status"];
};
type ResumeSelectIntent = {
	readonly chatId: number;
	readonly sender: number;
	readonly sessionId: SessionId;
	readonly invalidationEpoch: number;
	messageId?: number;
};
type SelectIntent = {
	readonly chatId: number;
	readonly sender: number;
	readonly sessionId: SessionId;
	messageId?: number;
};
type ActivityTool = {
	readonly id: string;
	readonly summary: string;
	status: "running" | "done" | "failed";
	history: ("running" | "done" | "failed")[];
};
type LiveActivity = {
	readonly chatId: number;
	readonly sessionId: SessionId;
	readonly sourceMessageId?: number;
	readonly queuedInputs: { readonly inputId: string; state: string }[];
	readonly overflowInputIds: Set<string>;
	readonly failedOverflowInputIds: Set<string>;
	untrackedInputOverflow: boolean;
	untrackedFailureOverflow: boolean;
	readonly tools: ActivityTool[];
	readonly notices: string[];
	status: string;
	subagentStatus?: string;
	submittedWhileRunning: boolean;
	thinking: boolean;
	messageId?: number;
	lastText?: string;
	unavailable: boolean;
	liveStatus?: HarnessSessionStatus["live"];
	renderQueue: Promise<void>;
	statsTimer?: NodeJS.Timeout;
	statsInFlight: boolean;
	pendingSubmissions: number;
	turnGeneration: number;
	finishTimer?: ReturnType<typeof setTimeout>;
	finishing: boolean;
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
function markdownToTelegramHtml(message: string, sessionId: SessionId): string {
	const footerStart = message.lastIndexOf("\n\n");
	const body = footerStart < 0 ? message : message.slice(0, footerStart);
	let text = "";
	for (let offset = 0; offset < body.length; ) {
		const remaining = body.slice(offset);
		const fence = remaining.match(/^```[^\n]*\n([\s\S]*?)```/);
		if (fence) {
			text += `<pre>${escapeHtml(fence[1] ?? "")}</pre>`;
			offset += fence[0].length;
			continue;
		}
		const inlineCode = remaining.match(/^`([^`\n]+)`/);
		if (inlineCode) {
			text += `<code>${escapeHtml(inlineCode[1] ?? "")}</code>`;
			offset += inlineCode[0].length;
			continue;
		}
		const link = remaining.match(/^\[([^\]\n]+)\]\(([^()\n]+)\)/);
		if (link) {
			const href = (link[2] ?? "").trim();
			let safe = false;
			try {
				const url = new URL(href);
				safe = ["http:", "https:", "mailto:"].includes(url.protocol);
			} catch {
				/* Malformed destinations remain readable, non-clickable text. */
			}
			text += safe
				? `<a href="${escapeHtml(href)}">${escapeHtml(link[1] ?? "")}</a>`
				: escapeHtml(link[1] ?? link[0]);
			offset += link[0].length;
			continue;
		}
		const emphasis = remaining.match(/^(\*\*|__|~~|\*|_)([^*_~\n]+?)\1/);
		if (emphasis) {
			const marker = emphasis[1];
			const tag = marker === "~~" ? "s" : marker.length === 2 ? "b" : "i";
			text += `<${tag}>${escapeHtml(emphasis[2] ?? "")}</${tag}>`;
			offset += emphasis[0].length;
			continue;
		}
		const point = String.fromCodePoint(body.codePointAt(offset) ?? 0);
		text += escapeHtml(point);
		offset += point.length;
	}
	if (footerStart < 0) return text;
	const escapedFooter = escapeHtml(message.slice(footerStart + 2));
	const escapedSessionId = escapeHtml(sessionId);
	const sessionOffset = escapedFooter.lastIndexOf(escapedSessionId);
	const footer =
		sessionOffset < 0
			? escapedFooter
			: `${escapedFooter.slice(0, sessionOffset)}<code>${escapedSessionId}</code>${escapedFooter.slice(sessionOffset + escapedSessionId.length)}`;
	return `${text}\n\n${footer}`;
}
function splitAssistantHtml(
	message: string,
	footer: string,
	sessionId: SessionId,
): string[] {
	const rendered = markdownToTelegramHtml(`${message}\n\n${footer}`, sessionId);
	const footerHtml = markdownToTelegramHtml(`\n\n${footer}`, sessionId);
	const body = rendered.slice(0, rendered.lastIndexOf("\n\n"));
	const footerVisible = footer.length + 2;
	let total = 1;
	for (let attempt = 0; attempt < 16; attempt++) {
		const markerBudget = total > 1 ? ` · ${total}/${total}`.length : 0;
		const result = splitHtmlBody(
			body,
			TELEGRAM_LIMIT - footerVisible - markerBudget,
		);
		if (result.length === total) {
			return result.map(
				(part, index) =>
					`${part}${footerHtml}${total > 1 ? ` · ${index + 1}/${total}` : ""}`,
			);
		}
		total = result.length;
	}
	throw new Error("Could not split rendered Telegram assistant output");
}
function splitHtmlBody(html: string, limit: number): string[] {
	const tokens =
		html.match(
			/<[^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/gi,
		) ?? [];
	const parts: string[] = [];
	let part = "";
	let visible = 0;
	const stack: { name: string; open: string }[] = [];
	const closeTags = () =>
		stack
			.slice()
			.reverse()
			.map(({ name }) => `</${name}>`)
			.join("");
	const startPart = () => stack.map(({ open }) => open).join("");
	for (const token of tokens) {
		const isTag = token.startsWith("<");
		const closing = isTag && /^<\//.test(token);
		const tagName = isTag
			? token.match(/^<\/?([a-z]+)/i)?.[1]?.toLowerCase()
			: undefined;
		const visibleCount = isTag ? 0 : token.startsWith("&") ? 1 : token.length;
		if (visibleCount && visible + visibleCount > limit && part) {
			parts.push(part + closeTags());
			part = startPart();
			visible = 0;
		}
		part += token;
		visible += visibleCount;
		if (tagName && ["b", "i", "s", "a", "code", "pre"].includes(tagName)) {
			if (closing) stack.pop();
			else if (!/\/>$/.test(token)) stack.push({ name: tagName, open: token });
		}
	}
	if (part || parts.length === 0) parts.push(part + closeTags());
	return parts;
}
function sessionLabel(session: Pick<SessionSummary, "id" | "name">): string {
	return `${session.name ? `${oneLine(session.name)} · ` : ""}#${session.id}`;
}
function shortSessionLabel(
	session: Pick<SessionSummary, "id" | "name">,
): string {
	return `${session.name ? `${buttonLabel(session.name, 25)} · ` : ""}#${session.id.slice(0, 8)}`;
}
function activitySessionLabel(sessionId: SessionId, name?: string): string {
	return `${name ? `${oneLine(name)} · ` : ""}${sessionId}`;
}
function formatSession(session: SessionSummary): string {
	const cwd = [...oneLine(session.cwd)];
	const displayCwd =
		cwd.length > 600 ? `${cwd.slice(0, 599).join("")}…` : cwd.join("");
	return `${escapeHtml(sessionLabel(session))} · ${escapeHtml(session.status)}\n${escapeHtml(displayCwd)}`;
}
function formatSessionList(session: SessionSummary, selected: boolean): string {
	return `${selected ? "✓ " : ""}${escapeHtml(shortSessionLabel(session))} · ${escapeHtml(session.status)} · ${escapeHtml(compactSessionPath(session.cwd))}`;
}
function isGeneratedSessionFooterName(value: string): boolean {
	if (!value || [...value].length > 64) return false;
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x2028 ||
			codePoint === 0x2029
		)
			return false;
	}
	return value === value.trim().replace(/\s+/gu, " ");
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
function activityKey(chatId: number, sessionId: SessionId): string {
	return JSON.stringify([chatId, sessionId]);
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
	return buttonLabel(value, 500);
}
function safePathPresentation(value: string): string {
	return [...value]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			if (character === "\\") return "\\\\";
			return code < 32 || code === 127
				? `\\u{${code.toString(16).toUpperCase().padStart(4, "0")}}`
				: character;
		})
		.join("");
}
function renamePromptIdentity(label: string, sessionId: SessionId): string {
	return `${label} (#${sessionId})`;
}
function hasRenamePromptIdentity(identity: string): boolean {
	const match = /^(.*) \(#([^()]*)\)$/.exec(identity);
	if (!match || !isSessionIdToken(match[2] ?? "")) return false;
	const [, label, sessionId] = match;
	return label === `#${sessionId}` || label.endsWith(` · #${sessionId}`);
}
function hasGeneratedNamePromptBody(body: string): boolean {
	const createSuffix = `. ${CREATE_NAME_INSTRUCTIONS}`;
	if (
		body.startsWith(CREATE_NAME_PREFIX) &&
		body.endsWith(createSuffix) &&
		body.length > CREATE_NAME_PREFIX.length + createSuffix.length
	)
		return true;
	if (
		body.startsWith(`${CREATE_NAME_FALLBACK} `) &&
		body.endsWith(createSuffix)
	)
		return true;

	const renameSuffix = `. ${RENAME_NAME_INSTRUCTIONS}`;
	if (!body.startsWith(RENAME_NAME_PREFIX) || !body.endsWith(renameSuffix))
		return false;
	const renameBody = body.slice(
		RENAME_NAME_PREFIX.length,
		-renameSuffix.length,
	);
	let boundary = renameBody.indexOf(RENAME_NAME_SEPARATOR);
	while (boundary !== -1) {
		const identity = renameBody.slice(0, boundary);
		const cwd = renameBody.slice(boundary + RENAME_NAME_SEPARATOR.length);
		if (cwd.length > 0 && hasRenamePromptIdentity(identity)) return true;
		boundary = renameBody.indexOf(RENAME_NAME_SEPARATOR, boundary + 1);
	}
	const fallbackSuffix = ` ${RENAME_NAME_FALLBACK}`;
	if (!renameBody.endsWith(fallbackSuffix)) return false;
	return hasRenamePromptIdentity(renameBody.slice(0, -fallbackSuffix.length));
}
function boundedPathPresentation(value: string, limit = 500): string {
	const path = [...safePathPresentation(value)];
	return path.length > limit
		? `${path.slice(0, limit - 1).join("")}…`
		: path.join("");
}
function boundedPanelText(lines: readonly string[]): string {
	const result: string[] = [];
	let length = 0;
	for (const line of lines) {
		const addition = (result.length ? 1 : 0) + line.length;
		if (length + addition > 3900) {
			result.push(
				"… Панель сокращена; откройте раздел повторно для обновления.",
			);
			break;
		}
		result.push(line);
		length += addition;
	}
	return result.join("\n");
}
function splitTelegramText(value: string, limit = 3000): string[] {
	const chunks: string[] = [];
	let chunk = "";
	for (const character of value) {
		if (chunk.length + character.length > limit) {
			chunks.push(chunk);
			chunk = "";
		}
		chunk += character;
	}
	if (chunk || chunks.length === 0) chunks.push(chunk);
	return chunks;
}
function compactSessionPath(value: string): string {
	const path = oneLine(value);
	const points = [...path];
	return points.length > 72 ? `…${points.slice(-71).join("")}` : path;
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
function truncateActivityText(value: string): string {
	return truncateDiagnostic(value, TELEGRAM_LIMIT - 100);
}
function hasContextUsage(
	usage: HarnessUsageStats | undefined,
): usage is HarnessUsageStats {
	return (
		usage?.contextTokens !== undefined ||
		usage?.contextWindow !== undefined ||
		usage?.contextPercent !== undefined
	);
}
function compactContextUsage(usage: HarnessUsageStats): string {
	const percent =
		usage.contextPercent === undefined || usage.contextPercent === null
			? "?"
			: `${usage.contextPercent.toFixed(1)}%`;
	const tokens =
		usage.contextTokens === null ? "?" : compactCount(usage.contextTokens);
	const window =
		usage.contextWindow === undefined
			? ""
			: `/${compactCount(usage.contextWindow)} (auto)`;
	return `${percent}/${tokens}${window}`;
}
function compactUsage(usage: HarnessUsageStats | undefined): string {
	return [
		`↑${compactCount(usage?.inputTokens)}`,
		`↓${compactCount(usage?.outputTokens)}`,
		`R${compactCount(usage?.cacheReadTokens)}`,
		`CH${cacheHitRate(usage)}`,
		compactCost(usage?.costUsd),
		...(hasContextUsage(usage) ? [compactContextUsage(usage)] : []),
	].join(" ");
}
function formatStatus(status: HarnessSessionStatus): string {
	const { session, live } = status;
	const lines = [
		`Session: ${activitySessionLabel(session.id, session.name)}`,
		`Folder: ${oneLine(session.cwd)}`,
		`Status: ${session.status}`,
		`Model: ${live?.model ? modelId(live.model) : "unavailable"}`,
		`Effort: ${live?.effort ? oneLine(live.effort) : "unavailable"}`,
	];
	const usage = live?.usage;
	lines.push(
		`Tokens: ${usage?.totalTokens !== undefined ? formatCount(usage.totalTokens) : "unavailable"}`,
		`Estimated cost: ${usage?.costUsd !== undefined ? `~$${usage.costUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}` : "unavailable"}`,
	);
	if (hasContextUsage(usage))
		lines.push(`Context: ${compactContextUsage(usage)}`);
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
function uncertainDeliveryNotice(inputId?: string): string {
	return `Pi may have accepted the input, but its acknowledgement was lost; no automatic resend occurred${inputId ? `; InputId ${inputId}` : ""}`;
}
function safeResultError(error: {
	readonly code: string;
	readonly message: string;
	readonly inputId?: string;
}): string {
	if (error.code === "UNCERTAIN_INPUT_DELIVERY")
		return `Input delivery is uncertain (${uncertainDeliveryNotice(error.inputId)})${error.message ? `\n${error.message}` : ""}`;
	return error.message;
}
const NO_SESSION_SELECTED_MESSAGE =
	"No session is selected. Use /sessions to find one and /use <sessionId>, or open /menu.";
const SELECTION_NOT_SAVED_WARNING =
	" The selection works now, but could not be saved for the next restart.";

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
	private readonly reportedErrors = new Map<SessionId, Set<string>>();
	private readonly liveActivities = new Map<string, LiveActivity>();
	private readonly runningSessions = new Set<SessionId>();
	private readonly previews = new Map<number, SessionId>();
	private readonly pendingNames = new Map<number, PendingNameFlow>();
	private readonly staleNamePrompts = new Map<number, Set<number>>();
	private readonly namePromptVersions = new Map<number, number>();
	private readonly replyRoutes = new Map<number, Map<number, ReplyRoute>>();
	private readonly replyChoices = new Map<string, ReplyChoice>();
	private readonly modelChoices = new Map<number, ModelChoices>();
	private readonly effortChoices = new Map<number, EffortChoices>();
	private readonly turnBuffers = new Map<SessionId, TurnBuffer>();
	private readonly inputAttributions = new Map<InputId, InputAttribution>();
	private readonly cancelingInputs = new Map<InputId, number>();
	private readonly inFlightSubmissions = new Map<
		SessionId,
		InFlightSubmission
	>();
	private readonly currentDirectories = new Map<number, string>();
	private readonly panelMessageIds = new Map<number, number>();
	private readonly panelStaleChats = new Set<number>();
	private readonly panelGenerations = new Map<number, number>();
	private readonly folderIntents = new Map<string, FolderIntent>();
	private readonly confirmationIntents = new Map<string, ConfirmationIntent>();
	private readonly resumeSelectIntents = new Map<string, ResumeSelectIntent>();
	private readonly selectIntents = new Map<string, SelectIntent>();
	private readonly confirmationEpochs = new Map<SessionId, number>();
	private readonly inFlightConfirmationRefs = new Map<SessionId, number>();
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
			await this.restoreSelectedSessions();
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
		beforeDelete?: () => boolean,
	): Promise<{
		readonly result: TransportResult;
		readonly cleanupPending: boolean;
		readonly invalidated?: boolean;
	}> {
		const inbox = this.inbox;
		if (!inbox) {
			if (beforeDelete && !beforeDelete())
				return {
					result: {
						requestId: randomUUID(),
						ok: false,
						error: {
							code: "confirmation_expired",
							message: "Confirmation expired.",
						},
					},
					cleanupPending: false,
					invalidated: true,
				};
			return {
				result: await this.request(sender, { kind: "delete", sessionId }),
				cleanupPending: false,
			};
		}
		return inbox.withSessionLock(sessionId, async () => {
			if (beforeDelete && !beforeDelete())
				return {
					result: {
						requestId: randomUUID(),
						ok: false,
						error: {
							code: "confirmation_expired",
							message: "Confirmation expired.",
						},
					},
					cleanupPending: false,
					invalidated: true,
				};
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
			queue.overflowNotices.clear();
			for (const resolve of queue.idleWaiters.splice(0)) resolve();
		}
		for (const activity of this.liveActivities.values()) {
			if (activity.statsTimer) clearInterval(activity.statsTimer);
			if (activity.finishTimer) clearTimeout(activity.finishTimer);
		}
		this.liveActivities.clear();
		this.turnBuffers.clear();
		this.inputAttributions.clear();
		this.cancelingInputs.clear();
		this.inFlightSubmissions.clear();
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

	private async restoreSelectedSessions(): Promise<void> {
		const store = this.panelStore;
		if (!store) return;
		for (const [chatId, sessionId] of store.selections())
			this.selected.set(chatId, sessionId as SessionId);
		if (!this.listSessions) return;
		try {
			const sessions = await this.listSessions();
			this.rememberSessions(sessions);
			const existing = new Set(sessions.map((session) => session.id));
			for (const [chatId, sessionId] of store.selections()) {
				if (!existing.has(sessionId as SessionId))
					await this.clearSelected(chatId);
			}
		} catch (error) {
			this.reportError(
				"Telegram saved session selections could not be checked",
				error,
			);
		}
	}

	private async setSelected(
		chatId: number,
		sessionId: SessionId,
	): Promise<boolean> {
		const previous = this.selected.get(chatId);
		this.selected.set(chatId, sessionId);
		if (previous && previous !== sessionId && this.typingTimers.has(previous))
			this.refreshTyping(previous);
		if (this.activeTypingSessions.has(sessionId)) this.startTyping(sessionId);
		try {
			await this.panelStore?.setSelected(chatId, sessionId);
			return true;
		} catch (error) {
			this.reportError("Telegram session selection could not be saved", error, [
				sessionId,
			]);
			return false;
		}
	}

	private async clearSelected(chatId: number): Promise<boolean> {
		const previous = this.selected.get(chatId);
		this.selected.delete(chatId);
		if (previous && this.typingTimers.has(previous))
			this.refreshTyping(previous);
		try {
			await this.panelStore?.clearSelected(chatId);
			return true;
		} catch (error) {
			this.reportError(
				"Telegram session selection could not be cleared",
				error,
				[previous ?? ""],
			);
			return false;
		}
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

	private async onText(
		ctx: UpdateContext,
		routedSessionId?: SessionId,
		confirmedCurrentSession?: SessionId,
	): Promise<void> {
		const chatId = ctx.chat?.id;
		const sender = ctx.from?.id;
		const text = ctx.message?.text;
		if (chatId === undefined || sender === undefined || text === undefined)
			return;
		let activity: LiveActivity | undefined;
		let submissionPending = false;
		try {
			const replyTo = ctx.message?.reply_to_message?.message_id;
			const pending =
				replyTo === undefined ? undefined : this.pendingNames.get(chatId);
			if (pending && pending.promptMessageId === replyTo) {
				await this.handleNameReply(chatId, sender, pending, text);
				return;
			}
			const knownReplyRoute =
				replyTo === undefined
					? undefined
					: this.replyRoutes.get(chatId)?.get(replyTo);
			const footerSession =
				knownReplyRoute === undefined
					? this.sessionFromReplyFooter(ctx.message?.reply_to_message)
					: undefined;
			const sourceSession = knownReplyRoute?.sessionId ?? footerSession;
			if (
				routedSessionId === undefined &&
				replyTo !== undefined &&
				!knownReplyRoute &&
				(this.isStaleNamePrompt(chatId, replyTo) ||
					this.isNamePromptEnvelope(ctx.message?.reply_to_message?.text))
			)
				return this.sendDirect(
					chatId,
					"This name prompt has expired. Start the naming action again.",
				);
			if (text.startsWith("/")) {
				await this.command(chatId, sender, text);
			} else {
				if (this.eventChannelDisabled(chatId))
					return this.sendDirect(
						chatId,
						"Канал событий отключён: новые сообщения не отправлены. Откройте /menu и включите канал для новых событий.",
					);
				const sessionId =
					routedSessionId ?? sourceSession ?? this.selected.get(chatId);
				if (!sessionId)
					return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
				if (replyTo !== undefined && !sourceSession && !routedSessionId)
					return this.offerReplyRoutes(
						chatId,
						sender,
						ctx.message?.message_id ?? 0,
						sessionId,
						sessionId,
						{ text },
					);
				activity = this.beginLiveActivity(
					chatId,
					sessionId,
					ctx.message?.message_id,
				);
				submissionPending = true;
				const result = await this.submitFromChat(
					chatId,
					sender,
					{ kind: "submit", sessionId, text },
					confirmedCurrentSession,
				);
				if (!result) {
					submissionPending = false;
					this.finishActivitySubmission(activity);
					return;
				}
				if (result.ok) {
					submissionPending = false;
					await this.confirmInputAccepted(
						chatId,
						ctx.message?.message_id,
						result.value as string,
						activity,
					);
				} else {
					submissionPending = false;
					this.finishActivitySubmission(activity);
					this.stopLiveActivityStats(activity);
					this.updateLiveActivity(activity, {
						status:
							result.error.code === "UNCERTAIN_INPUT_DELIVERY"
								? "Статус доставки неизвестен"
								: "Pi не принял сообщение",
						notice:
							result.error.code === "UNCERTAIN_INPUT_DELIVERY"
								? redactDiagnosticText(
										uncertainDeliveryNotice(result.error.inputId),
										[this.options.token],
									)
								: redactDiagnosticText(safeResultError(result.error), [
										this.options.token,
									]),
					});
					await this.presentSubmitFailure(
						chatId,
						sender,
						sessionId,
						result.error,
						text,
					);
				}
			}
		} catch (error) {
			if (activity && submissionPending) {
				submissionPending = false;
				this.finishActivitySubmission(activity);
			}
			const reference = this.reportError(
				"Telegram update handler failed",
				error,
				[text],
			);
			if (activity) {
				this.stopLiveActivityStats(activity);
				this.updateLiveActivity(activity, {
					status: "Ошибка запроса",
					notice: `Request failed (ref ${reference})`,
				});
			}
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

	private rememberStaleNamePrompt(chatId: number, messageId: number): void {
		let stale = this.staleNamePrompts.get(chatId);
		if (!stale) {
			stale = new Set();
			this.staleNamePrompts.set(chatId, stale);
		}
		stale.add(messageId);
		while (stale.size > 16) stale.delete(stale.values().next().value as number);
	}

	private isStaleNamePrompt(chatId: number, messageId: number): boolean {
		return this.staleNamePrompts.get(chatId)?.has(messageId) ?? false;
	}

	private isNamePromptReply(
		chatId: number,
		messageId: number,
		text?: string,
	): boolean {
		return (
			this.pendingNames.get(chatId)?.promptMessageId === messageId ||
			this.isStaleNamePrompt(chatId, messageId) ||
			this.isNamePromptEnvelope(text)
		);
	}

	private isNamePromptEnvelope(text?: string): boolean {
		if (!text?.startsWith(NAME_PROMPT_ENVELOPE_PREFIX)) return false;
		return hasGeneratedNamePromptBody(
			text.slice(NAME_PROMPT_ENVELOPE_PREFIX.length),
		);
	}

	private rememberReplyRoute(
		chatId: number,
		messageId: number,
		sessionId: SessionId,
	): void {
		let routes = this.replyRoutes.get(chatId);
		if (!routes) {
			routes = new Map();
			this.replyRoutes.set(chatId, routes);
		}
		routes.delete(messageId);
		routes.set(messageId, { sessionId });
		while (routes.size > MAX_CORRELATED_MESSAGES_PER_CHAT)
			routes.delete(routes.keys().next().value as number);
	}

	private sessionFromReplyFooter(
		reply: NonNullable<UpdateContext["message"]>["reply_to_message"],
	): SessionId | undefined {
		if (!reply) return undefined;
		const text = reply.text;
		const botId = (this.bot as TelegramBot & { botInfo?: { id: number } })
			.botInfo?.id;
		if (
			!text ||
			botId === undefined ||
			!reply.from?.is_bot ||
			reply.from.id !== botId
		)
			return undefined;
		const match =
			/\n\n(?:(.+) · )?([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?: · (\d+)\/(\d+))?$/.exec(
				text,
			);
		const id = match?.[2];
		if (!id || !this.knownSessions.has(id as SessionId)) return undefined;
		const footerName = match[1];
		if (footerName !== undefined && !isGeneratedSessionFooterName(footerName))
			return undefined;
		if (match[3] !== undefined) {
			const part = Number(match[3]);
			const total = Number(match[4]);
			if (
				!Number.isSafeInteger(part) ||
				!Number.isSafeInteger(total) ||
				part < 1 ||
				total < 2 ||
				part > total
			)
				return undefined;
		}
		const entities = reply.entities ?? [];
		const expectedOffset = text.lastIndexOf(id);
		const footerEntities = entities.filter(
			(entity) => entity.offset + entity.length > expectedOffset,
		);
		if (
			footerEntities.length !== 1 ||
			footerEntities[0]?.type !== "code" ||
			footerEntities[0]?.offset !== expectedOffset ||
			footerEntities[0]?.length !== id.length
		)
			return undefined;
		return id as SessionId;
	}

	private async offerReplyRoutes(
		chatId: number,
		sender: number,
		incomingMessageId: number,
		sourceSession: SessionId,
		selectedSession: SessionId,
		content:
			| { readonly text: string }
			| { readonly message: NonNullable<UpdateContext["message"]> },
	): Promise<void> {
		const token = randomUUID().replaceAll("-", "").slice(0, 12);
		const choice: ReplyChoice = {
			chatId,
			sender,
			incomingMessageId,
			sourceSession,
			selectedSession,
			...content,
		};
		this.replyChoices.set(token, choice);
		while (this.replyChoices.size > 128)
			this.replyChoices.delete(this.replyChoices.keys().next().value as string);
		const sent = await this.telegramCall((signal) =>
			this.bot.api.sendMessage(
				chatId,
				sourceSession === selectedSession
					? `Reply source is unknown. Send only to selected ${this.sessionFooter(selectedSession)} or cancel:`
					: `This message belongs to ${this.sessionFooter(sourceSession)}, but the selected session is ${this.sessionFooter(selectedSession)}. Choose where to send it:`,
				{
					reply_markup: keyboard([
						[
							...(sourceSession === selectedSession
								? [inlineButton("Send to selected", `reply:${token}:c`)]
								: [
										inlineButton("Send to source", `reply:${token}:s`),
										inlineButton("Send to selected", `reply:${token}:c`),
									]),
							inlineButton("Cancel", `reply:${token}:x`),
						],
					]),
				},
				signal,
			),
		);
		if (!sent.ok) this.replyChoices.delete(token);
		else choice.choiceMessageId = messageIdFrom(sent.value);
	}

	private async dispatchNameChoice(
		chatId: number,
		sender: number,
		data: string,
		messageId: number,
	): Promise<void> {
		const flow = this.pendingNames.get(chatId);
		if (
			!flow ||
			flow.choiceMessageId !== messageId ||
			sender !== this.authorizedChatPrincipals.get(chatId)
		) {
			await this.sendDirect(
				chatId,
				"This naming choice expired. Start the naming action again.",
			);
			return;
		}
		if (data === "name:cancel") {
			this.pendingNames.delete(chatId);
			return this.sendDirect(chatId, "Name operation cancelled.");
		}
		if (data === "name:unnamed" && flow.kind === "create")
			return this.handleNameReply(chatId, sender, flow, "/skip");
	}

	private async dispatchReplyChoice(
		chatId: number,
		sender: number,
		data: string,
		messageId: number,
	): Promise<void> {
		const match = /^reply:([a-f0-9]{12}):([scx])$/.exec(data);
		const choice = match
			? this.replyChoices.get(match[1] as string)
			: undefined;
		if (
			!choice ||
			choice.chatId !== chatId ||
			choice.sender !== sender ||
			choice.choiceMessageId !== messageId
		) {
			await this.sendDirect(
				chatId,
				"This reply choice expired. Send the message again if still needed.",
			);
			return;
		}
		this.replyChoices.delete(match?.[1] as string);
		if (match?.[2] === "x")
			return this.sendDirect(chatId, "Reply cancelled; nothing was sent.");
		if (
			match?.[2] === "c" &&
			this.selected.get(chatId) !== choice.selectedSession
		)
			return this.sendDirect(
				chatId,
				"The selected session changed before confirmation. Nothing was sent; reply again to choose a current destination.",
			);
		const target =
			match?.[2] === "s" ? choice.sourceSession : choice.selectedSession;
		if (choice.text !== undefined)
			return this.onText(
				{
					chat: { id: chatId, type: "private" },
					from: { id: sender },
					message: { text: choice.text, message_id: choice.incomingMessageId },
				},
				target,
				match?.[2] === "c" ? choice.selectedSession : undefined,
			);
		if (choice.message)
			return this.onMedia(
				{
					chat: { id: chatId, type: "private" },
					from: { id: sender },
					message: choice.message,
				},
				target,
				match?.[2] === "c" ? choice.selectedSession : undefined,
			);
	}

	private async onUnsupportedMedia(ctx: UpdateContext): Promise<void> {
		const chatId = ctx.chat?.id;
		if (chatId !== undefined)
			await this.sendDirect(
				chatId,
				"Unsupported attachment type. Send a Telegram document or photo instead.",
			);
	}

	private async onMedia(
		ctx: UpdateContext,
		routedSessionId?: SessionId,
		confirmedCurrentSession?: SessionId,
	): Promise<void> {
		const chatId = ctx.chat?.id;
		const sender = ctx.from?.id;
		const message = ctx.message;
		if (chatId === undefined || sender === undefined || !message) return;
		if (this.eventChannelDisabled(chatId))
			return this.sendDirect(
				chatId,
				"Канал событий отключён: вложение не отправлено. Откройте /menu и включите канал для новых событий.",
			);
		const replyTo = message.reply_to_message?.message_id;
		const knownReplyRoute =
			routedSessionId === undefined && replyTo !== undefined
				? this.replyRoutes.get(chatId)?.get(replyTo)
				: undefined;
		const footerSession =
			knownReplyRoute === undefined
				? this.sessionFromReplyFooter(message.reply_to_message)
				: undefined;
		if (
			routedSessionId === undefined &&
			replyTo !== undefined &&
			!knownReplyRoute &&
			this.isNamePromptReply(chatId, replyTo, message.reply_to_message?.text)
		)
			return this.sendDirect(
				chatId,
				"This name prompt has expired or requires text; the attachment was not submitted.",
			);
		const sessionId =
			routedSessionId ??
			knownReplyRoute?.sessionId ??
			footerSession ??
			this.selected.get(chatId);
		if (!sessionId) return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
		if (
			replyTo !== undefined &&
			!knownReplyRoute &&
			!footerSession &&
			!routedSessionId
		)
			return this.offerReplyRoutes(
				chatId,
				sender,
				message.message_id ?? 0,
				sessionId,
				sessionId,
				{ message },
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
		const explicitlyRouted = Boolean(
			knownReplyRoute ||
				footerSession ||
				(routedSessionId && !confirmedCurrentSession),
		);
		const selectedAtDownload =
			confirmedCurrentSession ?? this.selected.get(chatId);
		await this.sendDirect(chatId, "Получаю вложение…");
		let downloaded: Buffer;
		try {
			const controller = new AbortController();
			downloaded = await withDeadline(
				(async () => {
					const file = await this.bot.api.getFile(fileId, controller.signal);
					if ((file.file_size ?? 0) > MAX_TELEGRAM_DOWNLOAD_BYTES)
						throw new TelegramAttachmentTooLargeError();
					if (!file.file_path) throw new Error("file unavailable");
					const response = await fetch(
						telegramFileDownloadUrl(this.options.token, file.file_path),
						{ signal: controller.signal },
					);
					if (!response.ok) throw new Error("download failed");
					const data = await readBoundedResponse(
						response,
						MAX_TELEGRAM_DOWNLOAD_BYTES,
					);
					if (!data.length || data.length > MAX_TELEGRAM_DOWNLOAD_BYTES)
						throw new Error("file size invalid");
					return data;
				})(),
				60_000,
			).catch((error: unknown) => {
				controller.abort();
				throw error;
			});
		} catch (error) {
			if (error instanceof TelegramAttachmentTooLargeError)
				return this.sendDirect(
					chatId,
					"Attachment exceeds Telegram's 20 MB download limit.",
				);
			return this.sendDirect(
				chatId,
				error instanceof Error &&
					(error.message.includes("timed out") || error.message === "deadline")
					? "Attachment download timed out after 60 seconds; it was not submitted. Send it again if still needed."
					: "Could not safely download or save this attachment. It was not submitted.",
			);
		}
		await inbox.withSessionLock(sessionId, async () => {
			if (
				(!explicitlyRouted || confirmedCurrentSession !== undefined) &&
				this.selected.get(chatId) !== selectedAtDownload
			) {
				await this.sendDirect(
					chatId,
					"The selected session changed while receiving the attachment; it was not submitted.",
				);
				return;
			}
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
			const selectionChanged =
				(!explicitlyRouted || confirmedCurrentSession !== undefined) &&
				this.selected.get(chatId) !== selectedAtDownload;
			if (selectionChanged) {
				await this.sendDirect(
					chatId,
					"The selected session changed while receiving the attachment; it was not submitted.",
				);
				return;
			}
			let activity: LiveActivity | undefined;
			let submissionPending = false;
			try {
				const data = downloaded;
				const saved = await inbox.saveUnderLock(
					session.id,
					document?.file_name ?? (photo ? "photo.jpg" : "attachment"),
					data,
					session.status === "stopped" || session.status === "failed",
					session.cwd,
				);
				if (
					(!explicitlyRouted || confirmedCurrentSession !== undefined) &&
					this.selected.get(chatId) !== selectedAtDownload
				) {
					await inbox.removeSavedAttachmentUnderLock(sessionId, saved.path);
					await this.sendDirect(
						chatId,
						"The selected session changed while receiving the attachment; it was not submitted.",
					);
					return;
				}
				const caption = message.caption?.trim();
				const text = `The user sent an attachment saved in the harnessd inbox at ${saved.path}.${caption ? ` Caption (untrusted user text): ${caption}` : ""}`;
				const image = photo
					? [{ mimeType: "image/jpeg", data: data.toString("base64") }]
					: undefined;
				activity = this.beginLiveActivity(
					chatId,
					sessionId,
					message.message_id,
				);
				submissionPending = true;
				if (
					(!explicitlyRouted || confirmedCurrentSession !== undefined) &&
					this.selected.get(chatId) !== selectedAtDownload
				) {
					submissionPending = false;
					this.finishActivitySubmission(activity);
					await inbox.removeSavedAttachmentUnderLock(sessionId, saved.path);
					await this.sendDirect(
						chatId,
						"The selected session changed while receiving the attachment; it was not submitted.",
					);
					return;
				}
				if (this.eventChannelDisabled(chatId)) {
					submissionPending = false;
					this.finishActivitySubmission(activity);
					await this.sendDirect(
						chatId,
						"Канал событий отключён: вложение не отправлено. Откройте /menu и включите канал для новых событий.",
					);
					return;
				}
				const submitted = await this.dispatchSubmission(chatId, sender, {
					kind: "submit",
					sessionId,
					text,
					...(image ? { images: image } : {}),
				});
				if (!submitted.ok) {
					submissionPending = false;
					this.finishActivitySubmission(activity);
					this.stopLiveActivityStats(activity);
					this.updateLiveActivity(activity, {
						status:
							submitted.error.code === "UNCERTAIN_INPUT_DELIVERY"
								? "Статус доставки неизвестен"
								: "Pi не принял вложение",
						notice:
							submitted.error.code === "UNCERTAIN_INPUT_DELIVERY"
								? redactDiagnosticText(
										uncertainDeliveryNotice(submitted.error.inputId),
										[this.options.token],
									)
								: redactDiagnosticText(safeResultError(submitted.error), [
										this.options.token,
									]),
					});
					return this.presentSubmitFailure(
						chatId,
						sender,
						sessionId,
						submitted.error,
						caption ?? document?.file_name ?? "photo",
					);
				}
				submissionPending = false;
				return this.confirmInputAccepted(
					chatId,
					message.message_id,
					submitted.value as string,
					activity,
					`Attachment saved and submitted: ${saved.path}`,
				);
			} catch (error) {
				if (activity && submissionPending) {
					submissionPending = false;
					this.finishActivitySubmission(activity);
					this.stopLiveActivityStats(activity);
					this.updateLiveActivity(activity, {
						status: "Вложение не удалось отправить",
						notice: "Pi не получил вложение.",
					});
				}
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
			const selectionSaved = await this.setSelected(chatId, session.id);
			this.previews.delete(chatId);
			await this.refreshExistingPanel(chatId, sender);
			return this.sendDirect(
				chatId,
				`Created and selected ${sessionLabel(session)}.${selectionSaved ? "" : SELECTION_NOT_SAVED_WARNING}`,
			);
		}
		const sendCommand = /^\/send(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(raw);
		if (sendCommand) {
			const parsedPath = parsePathArgument(sendCommand[1]);
			if (!parsedPath.ok || !parsedPath.path)
				return this.sendDirect(chatId, "Usage: /send <path>");
			const sessionId = this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
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
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
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
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			if (
				!(await this.requireRunningSession(chatId, sender, sessionId, "model"))
			)
				return;
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
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			if (
				!(await this.requireRunningSession(chatId, sender, sessionId, "model"))
			)
				return;
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
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			if (
				!(await this.requireRunningSession(chatId, sender, sessionId, "effort"))
			)
				return;
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
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			if (
				!(await this.requireRunningSession(chatId, sender, sessionId, "effort"))
			)
				return;
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
							.map((session) =>
								formatSessionList(
									session,
									this.selected.get(chatId) === session.id,
								),
							)
							.join("\n") || "No sessions."
					: escapeHtml(result.error.message),
			);
		}
		if (name === "/use") {
			if (args.length > 1)
				return this.sendDirect(chatId, "Usage: /use [sessionId]");
			const sessionId =
				(args[0] as SessionId | undefined) ?? this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const result = await this.request(sender, { kind: "inspect", sessionId });
			if (!result.ok) {
				if (args.length === 0 && result.error.code === "SESSION_NOT_FOUND")
					await this.clearSelected(chatId);
				return this.sendDirect(
					chatId,
					`${result.error.message} Choose another session with /sessions or /menu.`,
				);
			}
			const session = result.value as SessionSummary;
			this.rememberSession(session);
			const selectionSaved = await this.setSelected(chatId, session.id);
			this.previews.delete(chatId);
			await this.refreshExistingPanel(chatId, sender);
			return this.sendDirect(
				chatId,
				`Selected ${sessionLabel(session)}.${args.length === 0 && session.status === "stopped" ? " A new message will resume it." : ""}${selectionSaved ? "" : SELECTION_NOT_SAVED_WARNING}`,
			);
		}
		if (name === "/resume") {
			if (args.length > 1)
				return this.sendDirect(chatId, "Usage: /resume [sessionId]");
			const sessionId =
				(args[0] as SessionId | undefined) ?? this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const result = await this.request(sender, { kind: "resume", sessionId });
			if (result.ok) {
				this.invalidateSessionConfirmations(sessionId);
				this.rememberSession(result.value as SessionSummary);
				await this.refreshExistingPanel(chatId, sender);
			}
			if (result.ok) {
				const target = this.selected.get(chatId);
				const sameTarget = target === sessionId;
				const text = sameTarget
					? `Session ${this.sessionFooter(sessionId)} resumed. Selection is unchanged; ordinary messages still target this session.`
					: `Session ${this.sessionFooter(sessionId)} is running, not selected. Selection is unchanged; ordinary messages still target ${target ? this.sessionFooter(target) : "no session"}.`;
				const selectToken = sameTarget
					? undefined
					: this.createSelectIntent(chatId, sender, sessionId);
				await this.sendWithDeadline(
					chatId,
					text,
					selectToken
						? {
								reply_markup: keyboard([
									[inlineButton("Выбрать", `action:select:${selectToken}`)],
								]),
							}
						: undefined,
					undefined,
					(messageId) => {
						if (selectToken) this.bindSelectMessage(selectToken, messageId);
					},
				);
				return;
			}
			return this.sendDirect(
				chatId,
				`${result.error.message} Selection is unchanged${this.selected.has(chatId) ? `; messages still target ${this.sessionFooter(this.selected.get(chatId) as SessionId)}` : "; no session is selected"}. Next: inspect with /sessions or /menu.`,
			);
		}
		if (name === "/inspect" && args.length <= 1) {
			const sessionId =
				(args[0] as SessionId | undefined) ?? this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
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
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const wasSelected = this.selected.get(chatId) === sessionId;
			const result = await this.request(sender, { kind: "stop", sessionId });
			if (result.ok) this.invalidateSessionConfirmations(sessionId);
			let selectionCleared = true;
			if (result.ok && this.selected.get(chatId) === sessionId) {
				selectionCleared = await this.clearSelected(chatId);
				this.previews.delete(chatId);
			}
			if (result.ok) await this.refreshExistingPanel(chatId, sender);
			const selectedAfterStop = this.selected.get(chatId);
			const message = result.ok
				? `Session ${this.sessionFooter(sessionId)} stopped. ${selectedAfterStop === sessionId ? "Selection remains (saved selection could not be cleared; it may return after restart)." : wasSelected ? (selectionCleared ? "Selection cleared; messages have no target." : "Selection was cleared in memory but saving the change failed; it may return after restart.") : selectedAfterStop ? `Selection unchanged; messages target ${this.sessionFooter(selectedAfterStop)}.` : "No session was selected; messages have no target."} Resume and select it below, or resume without selecting with /resume ${sessionId}.`
				: `${result.error.message} Selection is unchanged${selectedAfterStop ? `; messages target ${this.sessionFooter(selectedAfterStop)}` : "; messages have no target"}. Next: inspect in /menu.`;
			if (result.ok) {
				const token = this.createResumeSelectIntent(chatId, sender, sessionId);
				await this.sendWithDeadline(
					chatId,
					message,
					{
						reply_markup: keyboard([
							[
								inlineButton(
									"Возобновить и выбрать",
									`action:resume-select:${token}`,
								),
							],
						]),
					},
					undefined,
					(messageId) => this.bindResumeSelectMessage(token, messageId),
				);
				return;
			}
			return this.sendDirect(chatId, message);
		}
		if (name === "/delete") {
			if (args.length !== 1)
				return this.sendDirect(chatId, "Usage: /delete <sessionId>");
			const sessionId = args[0] as SessionId;
			const inspected = await this.request(sender, {
				kind: "inspect",
				sessionId,
			});
			if (!inspected.ok)
				return this.sendDirect(
					chatId,
					`${inspected.error.message} Selection is unchanged; next: inspect /menu.`,
				);
			const existing = inspected.value as SessionSummary;
			this.rememberSession(existing);
			if (existing.status !== "stopped")
				return this.sendDirect(
					chatId,
					`${sessionLabel(existing)} exists and Pi is ${existing.status}; deletion is only available when stopped. Next: /stop ${sessionId}, then /delete ${sessionId}.`,
				);
			const { result, cleanupPending } = await this.deleteSessionAndInbox(
				sender,
				sessionId,
			);
			let selectionsCleared = true;
			if (result.ok) {
				this.invalidateSession(sessionId);
				for (const [selectedChat, selectedId] of this.selected) {
					if (selectedId === sessionId) {
						selectionsCleared =
							(await this.clearSelected(selectedChat)) && selectionsCleared;
						this.previews.delete(selectedChat);
					}
				}
				await this.refreshExistingPanel(chatId, sender);
			}
			const remainingTarget = this.selected.get(chatId);
			return this.sendDirect(
				chatId,
				result.ok
					? `Deleted stopped session ${this.sessionFooter(sessionId)} from harnessd. ${remainingTarget ? `Messages target ${this.sessionFooter(remainingTarget)}.` : "This chat has no selected message target."} Next: choose a session in /menu.${cleanupPending ? " Inbox cleanup is pending." : ""}${selectionsCleared ? "" : " Saved chat selection cleanup may be retried after restart."}`
					: `${result.error.message} Selection is unchanged${remainingTarget ? `; messages target ${this.sessionFooter(remainingTarget)}` : "; no session is selected"}. Next: inspect /menu.`,
			);
		}
		if (name === "/cancel" && args.length === 1) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const inputId = args[0] as InputId;
			this.cancelingInputs.set(
				inputId,
				(this.cancelingInputs.get(inputId) ?? 0) + 1,
			);
			let result: TransportResult;
			try {
				result = await this.request(sender, {
					kind: "cancel",
					sessionId,
					inputId,
				});
			} finally {
				const pendingCancels = this.cancelingInputs.get(inputId) ?? 0;
				if (pendingCancels <= 1) this.cancelingInputs.delete(inputId);
				else this.cancelingInputs.set(inputId, pendingCancels - 1);
			}
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

	private async reissueNameFlow(
		chatId: number,
		sender: number,
		flow: PendingNameFlow,
	): Promise<void> {
		if (flow.kind === "create") return this.promptForCreation(chatId, flow.cwd);
		const inspected = await this.request(sender, {
			kind: "inspect",
			sessionId: flow.sessionId,
		});
		const session = inspected.ok
			? (inspected.value as SessionSummary)
			: undefined;
		if (session) this.rememberSession(session);
		const sessionLabelText = session
			? sessionLabel(session)
			: this.sessionFooter(flow.sessionId);
		const targetIdentity = renamePromptIdentity(
			sessionLabelText,
			flow.sessionId,
		);
		return this.promptForPathName(
			chatId,
			{ kind: "rename", sessionId: flow.sessionId },
			session?.cwd ?? this.sessionCwds.get(flow.sessionId) ?? "unknown cwd",
			`${RENAME_NAME_PREFIX}${targetIdentity}${RENAME_NAME_SEPARATOR}`,
			RENAME_NAME_INSTRUCTIONS,
			undefined,
			`${RENAME_NAME_PREFIX}${targetIdentity}`,
		);
	}

	private async promptForCreation(chatId: number, cwd: string): Promise<void> {
		const instructions = CREATE_NAME_INSTRUCTIONS;
		return this.promptForPathName(
			chatId,
			{ kind: "create", cwd },
			cwd,
			"New session will be created in ",
			instructions,
			"Exact session creation folder (control characters escaped):",
		);
	}

	private async promptForPathName(
		chatId: number,
		flow: PendingNameRequest,
		cwd: string,
		prefix: string,
		instructions: string,
		pathHeader = "Exact session folder (control characters escaped):",
		fallbackIdentity?: string,
	): Promise<void> {
		const path = safePathPresentation(cwd);
		if (`${prefix}${path}. ${instructions}`.length <= 3800)
			return this.promptForName(
				chatId,
				flow,
				`${prefix}${path}. ${instructions}`,
			);
		await this.sendDirect(chatId, pathHeader);
		for (const chunk of splitTelegramText(path))
			await this.sendWithDeadline(chatId, chunk);
		const identity = fallbackIdentity
			? `${fallbackIdentity} ${RENAME_NAME_FALLBACK}.`
			: CREATE_NAME_FALLBACK;
		return this.promptForName(chatId, flow, `${identity} ${instructions}`);
	}

	private async promptForName(
		chatId: number,
		flow: PendingNameRequest,
		text: string,
	): Promise<void> {
		const version = (this.namePromptVersions.get(chatId) ?? 0) + 1;
		this.namePromptVersions.set(chatId, version);
		const previous = this.pendingNames.get(chatId);
		if (previous) {
			this.pendingNames.delete(chatId);
			this.rememberStaleNamePrompt(chatId, previous.promptMessageId);
			await this.sendDirect(
				chatId,
				"The previous name prompt was superseded by a new naming action.",
			);
		}
		const choices = await this.telegramCall((signal) =>
			this.bot.api.sendMessage(
				chatId,
				flow.kind === "create"
					? "Create unnamed session or cancel."
					: "Cancel this rename prompt.",
				{
					reply_markup: keyboard(
						flow.kind === "create"
							? [
									[
										inlineButton("Create unnamed", "name:unnamed"),
										inlineButton("Cancel", "name:cancel"),
									],
								]
							: [[inlineButton("Cancel", "name:cancel")]],
					),
				},
				signal,
			),
		);
		const sent = await this.telegramCall((signal) =>
			this.bot.api.sendMessage(
				chatId,
				`${NAME_PROMPT_ENVELOPE_PREFIX}${text}`,
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
		if (this.namePromptVersions.get(chatId) !== version) {
			this.rememberStaleNamePrompt(chatId, messageId);
			await this.sendDirect(
				chatId,
				"This name prompt was superseded by a newer naming action.",
			);
			return;
		}
		const pendingFlow: PendingNameFlow = {
			...flow,
			promptMessageId: messageId,
			...(choices.ok ? { choiceMessageId: messageIdFrom(choices.value) } : {}),
		};
		this.pendingNames.set(chatId, pendingFlow);
	}

	private async handleNameReply(
		chatId: number,
		sender: number,
		flow: PendingNameFlow,
		text: string,
	): Promise<void> {
		const pending = this.pendingNames.get(chatId);
		if (pending !== flow || flow.processing) return;
		flow.processing = true;
		const reply = text.trim();
		if (reply === "/cancel") {
			this.pendingNames.delete(chatId);
			return this.sendDirect(chatId, "Name operation cancelled.");
		}
		if (!reply || (flow.kind === "rename" && reply === "/skip")) {
			await this.sendDirect(
				chatId,
				"Name cannot be empty. The same naming target is still active.",
			);
			return this.reissueNameFlow(chatId, sender, flow);
		}
		if (flow.kind === "create") {
			const name = reply === "/skip" ? undefined : text;
			const result = await this.request(sender, {
				kind: "create",
				harnessId: "pi-rpc" as AdapterId,
				cwd: flow.cwd,
				...(name !== undefined ? { name } : {}),
			});
			if (!result.ok) {
				await this.sendDirect(chatId, result.error.message);
				return this.reissueNameFlow(chatId, sender, flow);
			}
			this.pendingNames.delete(chatId);
			const session = result.value as SessionSummary;
			this.rememberSession(session);
			const selectionSaved = await this.setSelected(chatId, session.id);
			this.previews.delete(chatId);
			await this.refreshExistingPanel(chatId, sender);
			return this.sendDirect(
				chatId,
				`Created and selected ${sessionLabel(session)}.${selectionSaved ? "" : SELECTION_NOT_SAVED_WARNING}`,
			);
		}
		const result = await this.request(sender, {
			kind: "rename",
			sessionId: flow.sessionId,
			name: text,
		});
		if (!result.ok) {
			await this.sendDirect(chatId, result.error.message);
			return this.reissueNameFlow(chatId, sender, flow);
		}
		this.pendingNames.delete(chatId);
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		await this.refreshExistingPanel(chatId, sender);
		await this.sendDirect(
			chatId,
			`Session name updated: ${sessionLabel(session)}.`,
		);
	}

	private async presentSubmitFailure(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		error: {
			readonly code: string;
			readonly message: string;
			readonly inputId?: string;
		},
		inputText?: string,
	): Promise<void> {
		const withInput = (message: string) =>
			inputText
				? `${message}\n\nСообщение:\n${truncateDiagnostic(inputText, 1200)}`
				: message;
		if (error.code === "SESSION_NOT_RESUMABLE")
			return this.sendDirect(
				chatId,
				withInput(
					`${error.message}. This message was not submitted, and harnessd did not create a replacement. Choose another with /sessions or /menu.`,
				),
			);
		if (error.code === "SESSION_NOT_FOUND") {
			const inspected = await this.request(sender, {
				kind: "inspect",
				sessionId,
			});
			if (inspected.ok) {
				const session = inspected.value as SessionSummary;
				const detail =
					session.status === "running"
						? "Its saved status is running, but no live Pi process is attached; this can happen after an unclean shutdown."
						: "The session is not currently available to Pi.";
				return this.sendDirect(
					chatId,
					withInput(
						`${detail} This message was not sent. Choose a session with /sessions or /menu; harnessd did not create a replacement.`,
					),
				);
			}
			if (inspected.error.code === "SESSION_NOT_FOUND") {
				const selectionCleared =
					this.selected.get(chatId) !== sessionId ||
					(await this.clearSelected(chatId));
				return this.sendDirect(
					chatId,
					withInput(
						`The remembered session no longer exists. This message was not sent. Choose another with /sessions or /menu.${selectionCleared ? "" : " The stale selection could not be cleared from saved state."}`,
					),
				);
			}
		}
		return this.sendDirect(chatId, withInput(safeResultError(error)));
	}

	private async requireRunningSession(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		control: "model" | "effort",
	): Promise<boolean> {
		const result = await this.request(sender, { kind: "inspect", sessionId });
		if (!result.ok) {
			await this.sendDirect(
				chatId,
				`${result.error.message} Selection is unchanged; next: inspect /menu.`,
			);
			return false;
		}
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		if (session.status === "running") return true;
		await this.sendDirect(
			chatId,
			session.status === "stopped"
				? `${sessionLabel(session)} exists, but Pi is stopped. ${control} requires a running Pi. Next: /resume ${sessionId} (does not select it), then /use ${sessionId}.`
				: `${sessionLabel(session)} exists with Pi status ${session.status}; ${control} requires a running Pi. No reattach or replacement is available. Next: inspect /menu or try /stop ${sessionId} to terminalize a stale instance.`,
		);
		return false;
	}

	private withSessionRequestLock<T>(
		sessionId: SessionId,
		operation: () => Promise<T>,
	): Promise<T> {
		return this.inbox
			? this.inbox.withSessionLock(sessionId, operation)
			: operation();
	}

	private submitFromChat(
		chatId: number,
		sender: number,
		request: Extract<TelegramRequest, { kind: "submit" }>,
		expectedSelection?: SessionId,
	): Promise<TransportResult | undefined> {
		return this.withSessionRequestLock(request.sessionId, async () => {
			if (
				expectedSelection !== undefined &&
				this.selected.get(chatId) !== expectedSelection
			) {
				await this.sendDirect(
					chatId,
					"The selected session changed before dispatch; nothing was sent.",
				);
				return undefined;
			}
			if (this.eventChannelDisabled(chatId)) {
				await this.sendDirect(
					chatId,
					"Канал событий отключён: новое сообщение не отправлено. Откройте /menu и включите канал для новых событий.",
				);
				return undefined;
			}
			return this.dispatchSubmission(chatId, sender, request);
		});
	}

	private async dispatchSubmission(
		chatId: number,
		sender: number,
		request: Extract<TelegramRequest, { kind: "submit" }>,
	): Promise<TransportResult> {
		const pending: InFlightSubmission = { chatId };
		this.inFlightSubmissions.set(request.sessionId, pending);
		try {
			const result = await this.dispatchRequest(sender, request);
			if (result.ok)
				this.recordInputOutcome(
					request.sessionId,
					result.value as InputId,
					chatId,
					"accepted",
				);
			else if (result.error.inputId)
				this.recordInputOutcome(
					request.sessionId,
					result.error.inputId as InputId,
					chatId,
					result.error.code === "UNCERTAIN_INPUT_DELIVERY"
						? "uncertain"
						: "failed",
				);
			return result;
		} finally {
			if (this.inFlightSubmissions.get(request.sessionId) === pending)
				this.inFlightSubmissions.delete(request.sessionId);
		}
	}

	private request(
		sender: number,
		request: TelegramRequest,
	): Promise<TransportResult> {
		const operation = () => this.dispatchRequest(sender, request);
		if (request.kind === "resume" || request.kind === "submit")
			return this.withSessionRequestLock(request.sessionId, operation);
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
		hideStaleAction = false,
	): Promise<void> {
		const listed = await this.request(sender, { kind: "list" });
		const sessions = listed.ok
			? (listed.value as readonly SessionSummary[])
			: [];
		if (listed.ok) this.rememberSessions(sessions);
		let selectedId = this.selected.get(chatId);
		let selectionClearFailed = false;
		if (
			listed.ok &&
			selectedId &&
			!sessions.some((session) => session.id === selectedId)
		) {
			selectionClearFailed = !(await this.clearSelected(chatId));
			selectedId = this.selected.get(chatId);
			this.previews.delete(chatId);
		}
		let previewId = this.previews.get(chatId);
		if (
			listed.ok &&
			previewId &&
			!sessions.some((session) => session.id === previewId)
		) {
			this.previews.delete(chatId);
			previewId = undefined;
		}
		if (!previewId) {
			previewId = this.selected.get(chatId) ?? sessions[0]?.id;
			if (previewId && previewId !== this.selected.get(chatId))
				this.previews.set(chatId, previewId);
		}
		const selected = sessions.find(
			(session) => session.id === this.selected.get(chatId),
		);
		const previewFromList = sessions.find(
			(session) => session.id === previewId,
		);
		let status: HarnessSessionStatus | undefined;
		if (previewId) {
			const result = await this.request(sender, {
				kind: "session_status",
				sessionId: previewId,
			});
			if (result.ok) {
				status = result.value as HarnessSessionStatus;
				this.rememberSession(status.session);
			}
		}
		const preview = status?.session ?? previewFromList;
		const selectedLabel = selected
			? sessionLabel(selected)
			: selectedId
				? sessionLabel({
						id: selectedId,
						name: this.sessionNames.get(selectedId),
					})
				: "не выбрана";
		const lines = [
			"📌 Панель сессий",
			`Выбрана (обычные сообщения →): ${selectedLabel}`,
			`Просмотр: ${preview ? sessionLabel(preview) : previewId ? activitySessionLabel(previewId, this.sessionNames.get(previewId)) : "нет"}`,
			`Новая сессия · папка создания: ${boundedPathPresentation(this.currentDirectories.get(chatId) ?? this.options.initialCwd)}`,
		];
		if (selectionClearFailed)
			lines.push(
				"Не удалось сохранить очистку выбора; он может вернуться после перезапуска.",
			);
		if (!listed.ok)
			lines.push(`Не удалось обновить список сессий: ${listed.error.message}`);
		if (this.panelStaleChats.has(chatId))
			lines.push(
				"Операция завершена отдельно от панели; её обновление не удалось. Используйте «Обновить панель».",
			);
		if (preview) {
			lines.push(
				`Существует: да · Выбрана для сообщений: ${this.selected.get(chatId) === preview.id ? "да" : "нет"}`,
				`Папка просмотра: ${panelPath(preview.cwd)}`,
				`Статус Pi: ${preview.status === "running" ? "записан как работающий (после аварийного перезапуска может быть устаревшим)" : preview.status === "stopped" ? "остановлен" : preview.status === "starting" ? "запускается или восстанавливается" : "ошибка/устаревший статус"} (${preview.status})`,
			);
			if (status) lines.push(compactUsage(status.live?.usage));
			if (status?.live?.model)
				lines.push(
					`Модель: ${modelId(status.live.model)}${status.live.effort ? ` · ${oneLine(status.live.effort)}` : ""}`,
				);
		}
		const rows: InlineButton[][] = [];
		if (previewId && listed.ok)
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
		if (this.panelStaleChats.has(chatId) && !hideStaleAction)
			rows.push([inlineButton("Обновить панель", "panel:refresh")]);
		if (this.eventChannelDisabled(chatId))
			rows.push([
				inlineButton("Включить канал для новых событий", "events:enable"),
			]);
		if (previewId && preview) {
			if (preview.status === "running" || preview.status === "stopped")
				rows.push([
					inlineButton("Модель просмотра", "menu:models"),
					inlineButton("Усилие просмотра", "menu:efforts"),
				]);
			if (preview.status === "running") {
				rows.push([
					inlineButton("Остановить просмотр", `session:stop:${previewId}`),
				]);
			} else if (preview.status === "stopped") {
				rows.push([
					inlineButton(
						"Возобновить и выбрать",
						`session:resume-select:${previewId}`,
					),
				]);
				rows.push([
					inlineButton("Удалить просмотр…", `session:delete:${previewId}`),
				]);
			} else {
				rows.push([
					inlineButton(
						"Остановить для восстановления…",
						`session:stop:${previewId}`,
					),
				]);
			}
		}
		await this.updatePanel(
			chatId,
			boundedPanelText(lines),
			keyboard(rows),
			messageId,
		);
	}

	private async refreshExistingPanel(
		chatId: number,
		sender: number,
		hideStaleAction = false,
	): Promise<void> {
		const messageId =
			this.panelMessageIds.get(chatId) ?? this.panelStore?.get(chatId);
		if (messageId !== undefined)
			await this.renderPanel(chatId, sender, messageId, hideStaleAction);
	}

	private async notifyPanelStale(chatId: number): Promise<void> {
		await this.telegramCall((signal) =>
			this.bot.api.sendMessage(
				chatId,
				"Не удалось обновить панель. Это не отменяет и не повторяет операцию; не нажимайте её повторно. Проверьте результат в панели после обновления или через /status.",
				{
					reply_markup: keyboard([
						[inlineButton("Обновить панель", "panel:refresh")],
					]),
				},
				signal,
			),
		);
	}

	private async updatePanel(
		chatId: number,
		text: string,
		replyMarkup: unknown,
		messageId?: number,
	): Promise<boolean> {
		const generation = this.nextPanelGeneration(chatId);
		this.panelGenerations.set(chatId, generation);
		for (const [token, intent] of this.folderIntents)
			if (intent.chatId === chatId && intent.generation !== generation)
				this.folderIntents.delete(token);
		const retiredSessions = new Set<SessionId>();
		for (const [token, intent] of this.confirmationIntents) {
			if (intent.chatId === chatId && intent.generation !== generation) {
				retiredSessions.add(intent.sessionId);
				this.confirmationIntents.delete(token);
			}
		}
		for (const sessionId of retiredSessions)
			this.retireConfirmationEpochIfUnused(sessionId);
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
				this.panelStaleChats.delete(chatId);
				return true;
			}
			if (!isMessageNotFound(edited.error)) {
				this.dropPanelGenerationIntents(chatId, generation);
				this.panelStaleChats.add(chatId);
				await this.notifyPanelStale(chatId);
				return false;
			}
		}
		const intentGeneration = this.panelGenerations.get(chatId);
		const hasBoundIntents =
			[...this.folderIntents.values()].some(
				(intent) =>
					intent.chatId === chatId && intent.generation === intentGeneration,
			) ||
			[...this.confirmationIntents.values()].some(
				(intent) =>
					intent.chatId === chatId && intent.generation === intentGeneration,
			);
		const sent = await this.telegramCall((signal) =>
			this.bot.api.sendMessage(
				chatId,
				text,
				hasBoundIntents ? {} : { reply_markup: replyMarkup },
				signal,
			),
		);
		if (!sent.ok) {
			this.dropPanelGenerationIntents(chatId, intentGeneration);
			this.panelStaleChats.add(chatId);
			await this.notifyPanelStale(chatId);
			return false;
		}
		const createdMessageId = messageIdFrom(sent.value);
		if (createdMessageId === undefined) {
			this.dropPanelGenerationIntents(chatId, intentGeneration);
			return false;
		}
		await this.savePanelReference(chatId, createdMessageId);
		this.panelStaleChats.delete(chatId);
		if (hasBoundIntents) {
			for (const intent of this.folderIntents.values())
				if (intent.chatId === chatId && intent.generation === intentGeneration)
					intent.messageId = createdMessageId;
			for (const intent of this.confirmationIntents.values())
				if (intent.chatId === chatId && intent.generation === intentGeneration)
					intent.messageId = createdMessageId;
			const published = await this.telegramCall((signal) =>
				this.bot.api.editMessageText(
					chatId,
					createdMessageId,
					text,
					{ reply_markup: replyMarkup },
					signal,
				),
			);
			if (!published.ok && !isMessageNotModified(published.error)) {
				this.dropPanelGenerationIntents(chatId, intentGeneration);
				return false;
			}
		}
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

	private dropPanelGenerationIntents(
		chatId: number,
		generation: number | undefined,
	): void {
		if (generation === undefined) return;
		for (const [token, intent] of this.folderIntents)
			if (intent.chatId === chatId && intent.generation === generation)
				this.folderIntents.delete(token);
		const affected = new Set<SessionId>();
		for (const [token, intent] of this.confirmationIntents) {
			if (intent.chatId === chatId && intent.generation === generation) {
				affected.add(intent.sessionId);
				this.confirmationIntents.delete(token);
			}
		}
		for (const sessionId of affected)
			this.retireConfirmationEpochIfUnused(sessionId);
	}

	private nextPanelGeneration(chatId: number): number {
		return (this.panelGenerations.get(chatId) ?? 0) + 1;
	}

	private makeIntentToken(): string {
		return randomUUID().replaceAll("-", "");
	}

	private invalidateChatConfirmations(chatId: number): void {
		const affected = new Set<SessionId>();
		for (const [token, intent] of this.confirmationIntents) {
			if (intent.chatId === chatId) {
				affected.add(intent.sessionId);
				this.confirmationIntents.delete(token);
			}
		}
		for (const sessionId of affected)
			this.retireConfirmationEpochIfUnused(sessionId);
	}

	private invalidateSessionConfirmations(sessionId: SessionId): void {
		this.confirmationEpochs.set(
			sessionId,
			(this.confirmationEpochs.get(sessionId) ?? 0) + 1,
		);
		for (const [token, intent] of this.confirmationIntents)
			if (intent.sessionId === sessionId)
				this.confirmationIntents.delete(token);
		for (const [token, intent] of this.resumeSelectIntents)
			if (intent.sessionId === sessionId)
				this.resumeSelectIntents.delete(token);
		this.retireConfirmationEpochIfUnused(sessionId);
	}

	private retireConfirmationEpochIfUnused(sessionId: SessionId): void {
		if (this.inFlightConfirmationRefs.has(sessionId)) return;
		for (const intent of this.confirmationIntents.values())
			if (intent.sessionId === sessionId) return;
		for (const intent of this.resumeSelectIntents.values())
			if (intent.sessionId === sessionId) return;
		this.confirmationEpochs.delete(sessionId);
	}

	private releaseInFlightConfirmation(sessionId: SessionId): void {
		const remaining = (this.inFlightConfirmationRefs.get(sessionId) ?? 1) - 1;
		if (remaining > 0) this.inFlightConfirmationRefs.set(sessionId, remaining);
		else this.inFlightConfirmationRefs.delete(sessionId);
		this.retireConfirmationEpochIfUnused(sessionId);
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
		if (!callback.data || callback.data.length > 64) return;
		if (callback.data.startsWith("reply:")) {
			await this.dispatchReplyChoice(chatId, sender, callback.data, messageId);
			return;
		}
		if (callback.data.startsWith("name:")) {
			await this.dispatchNameChoice(chatId, sender, callback.data, messageId);
			return;
		}
		const directAction =
			callback.data.startsWith("action:resume-select:") ||
			callback.data.startsWith("action:select:") ||
			callback.data === "panel:refresh";
		if (!directAction) await this.savePanelReference(chatId, messageId);
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
		if (data === "panel:refresh")
			return this.refreshExistingPanel(chatId, sender, true);
		if (data === "events:enable") {
			const queue = this.queues.get(chatId);
			if (queue) {
				queue.failed = false;
				queue.messages.length = 0;
				queue.pendingCharacters = 0;
				queue.overflowNotices.clear();
			}
			await this.sendDirect(
				chatId,
				"Канал включён только для новых событий; старые события не отправляются.",
			);
			return this.renderPanel(chatId, sender, messageId);
		}
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
		if (data === "menu:new") {
			const cwd =
				this.currentDirectories.get(chatId) ?? this.options.initialCwd;
			return this.promptForCreation(chatId, cwd);
		}
		if (data === "folder:parent")
			return this.changeFolder(chatId, sender, "parent", messageId);
		if (data === "folder:new") {
			const cwd =
				this.currentDirectories.get(chatId) ?? this.options.initialCwd;
			return this.promptForCreation(chatId, cwd);
		}
		if (data.startsWith("folder:page:"))
			return this.setPageAndRender(
				chatId,
				sender,
				"folder",
				data.slice(12),
				messageId,
			);
		if (data.startsWith("folder:") && data.length === 39)
			return this.openFolder(chatId, sender, data.slice(7), messageId);
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
		if (data.startsWith("session:resume-select:")) {
			const id = this.sessionCallbackId(data.slice(22));
			return id
				? this.resumeAndSelectFromPanel(chatId, sender, id, messageId)
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
		if (data.startsWith("action:resume-select:"))
			return this.performResumeSelectIntent(
				chatId,
				sender,
				data.slice(21),
				messageId,
			);
		if (data.startsWith("action:select:"))
			return this.performSelectIntent(
				chatId,
				sender,
				data.slice(14),
				messageId,
			);
		if (data.startsWith("action:confirm:"))
			return this.performSessionAction(
				chatId,
				sender,
				data.slice(15),
				messageId,
			);
		if (data === "action:cancel") {
			this.invalidateChatConfirmations(chatId);
			return this.renderSessions(chatId, sender, messageId);
		}
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
			"Это действие устарело и не выполнено. Обновите панель и выберите действие ещё раз.",
			keyboard([[inlineButton("Обновить панель", "menu:home")]]),
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

	private beginLiveActivity(
		chatId: number,
		sessionId: SessionId,
		sourceMessageId: number | undefined,
	): LiveActivity {
		let activity = this.liveActivities.get(activityKey(chatId, sessionId));
		if (activity && activity.sessionId === sessionId) {
			const current = activity;
			const startsIndependentTurn =
				!this.runningSessions.has(sessionId) &&
				current.pendingSubmissions === 0;
			current.turnGeneration++;
			current.pendingSubmissions++;
			if (current.finishTimer) clearTimeout(current.finishTimer);
			current.finishTimer = undefined;
			current.submittedWhileRunning = this.runningSessions.has(sessionId);
			if (startsIndependentTurn) {
				current.subagentStatus = undefined;
				current.queuedInputs.splice(0, current.queuedInputs.length);
				current.overflowInputIds.clear();
				current.failedOverflowInputIds.clear();
				current.untrackedInputOverflow = false;
				current.untrackedFailureOverflow = false;
			}
			if (!current.statsTimer) {
				current.statsTimer = setInterval(
					() => void this.refreshLiveActivityStats(current),
					2500,
				);
				current.statsTimer.unref();
			}
			current.status = current.submittedWhileRunning
				? "В очереди Pi"
				: "Отправляю в Pi";
			current.notices.push("Новое сообщение добавлено в очередь");
			this.renderLiveActivity(current);
			return current;
		}
		activity = {
			chatId,
			sessionId,
			...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
			queuedInputs: [],
			overflowInputIds: new Set(),
			failedOverflowInputIds: new Set(),
			untrackedInputOverflow: false,
			untrackedFailureOverflow: false,
			tools: [],
			notices: [],
			status: this.runningSessions.has(sessionId)
				? "В очереди Pi"
				: "Отправляю в Pi",
			submittedWhileRunning: this.runningSessions.has(sessionId),
			thinking: false,
			unavailable: false,
			renderQueue: Promise.resolve(),
			statsInFlight: false,
			pendingSubmissions: 1,
			turnGeneration: 1,
			finishing: false,
		};
		this.liveActivities.set(activityKey(chatId, sessionId), activity);
		this.renderLiveActivity(activity);
		activity.statsTimer = setInterval(
			() => void this.refreshLiveActivityStats(activity),
			2500,
		);
		activity.statsTimer.unref();
		return activity;
	}

	private liveActivityText(activity: LiveActivity): string {
		const name = this.sessionNames.get(activity.sessionId);
		const lines = [
			`🔧 Pi activity · ${activitySessionLabel(activity.sessionId, name)}`,
		];
		if (activity.thinking) lines.push("• Думаю…");
		for (const notice of activity.notices.slice(-4))
			lines.push(`• ${truncateDiagnostic(notice, 180)}`);
		for (const tool of activity.tools.slice(-10))
			for (const state of tool.history)
				lines.push(
					`• ${truncateDiagnostic(tool.summary, 120)} ${state === "running" ? "…" : state === "failed" ? "❌" : "✓"}`,
				);
		const visibleInputs = activity.queuedInputs.slice(-5);
		const olderUnresolved = activity.queuedInputs
			.slice(0, -visibleInputs.length)
			.filter((input) => input.state !== "completed").length;
		const overflowUnresolved =
			activity.overflowInputIds.size + activity.failedOverflowInputIds.size;
		if (olderUnresolved || overflowUnresolved)
			lines.push(
				`• ${olderUnresolved + overflowUnresolved} earlier input(s) remain unresolved`,
			);
		if (activity.untrackedInputOverflow)
			lines.push("• Additional input status is unresolved.");
		if (activity.untrackedFailureOverflow)
			lines.push("• Additional failed/uncertain input status is retained.");
		for (const input of visibleInputs)
			lines.push(`• Input ${input.inputId}: ${input.state}`);
		const live = activity.liveStatus;
		const model = live?.model
			? truncateDiagnostic(modelId(live.model), 120)
			: "model unavailable";
		const effort = live?.effort
			? truncateDiagnostic(oneLine(live.effort), 60)
			: "effort unavailable";
		lines.push(
			`⏳ ${activity.subagentStatus ?? activity.status} · ${compactUsage(live?.usage)} · ${model} · ${effort}`,
		);
		return truncateActivityText(lines.join("\n"));
	}

	private renderLiveActivity(activity: LiveActivity): void {
		activity.renderQueue = activity.renderQueue
			.then(async () => {
				if (
					this.stopping ||
					activity.unavailable ||
					this.liveActivities.get(
						activityKey(activity.chatId, activity.sessionId),
					) !== activity
				)
					return;
				const text = this.liveActivityText(activity);
				if (activity.messageId === undefined) {
					const sent = await this.telegramCall((signal) =>
						this.bot.api.sendMessage(
							activity.chatId,
							text,
							activity.sourceMessageId === undefined
								? {}
								: {
										reply_parameters: { message_id: activity.sourceMessageId },
									},
							signal,
						),
					);
					if (!sent.ok) {
						activity.unavailable = true;
						this.reportError(
							"Telegram activity bubble could not be sent",
							sent.error,
						);
						return;
					}
					activity.messageId = messageIdFrom(sent.value);
					if (activity.messageId !== undefined)
						this.rememberReplyRoute(
							activity.chatId,
							activity.messageId,
							activity.sessionId,
						);
					activity.lastText = text;
					return;
				}
				if (activity.lastText === text) return;
				const edited = await this.telegramCall((signal) =>
					this.bot.api.editMessageText(
						activity.chatId,
						activity.messageId as number,
						text,
						{},
						signal,
					),
				);
				if (!edited.ok) {
					if (isMessageNotFound(edited.error)) {
						activity.messageId = undefined;
						activity.lastText = undefined;
						this.renderLiveActivity(activity);
					} else {
						activity.unavailable = true;
						this.reportError(
							"Telegram activity bubble could not be updated",
							edited.error,
						);
					}
					return;
				}
				activity.lastText = text;
			})
			.catch((error) => {
				this.reportError("Telegram activity update failed", error);
			});
	}

	private async refreshLiveActivityStats(
		activity: LiveActivity,
	): Promise<void> {
		if (activity.statsInFlight || this.stopping) return;
		const sender = this.authorizedChatPrincipals.get(activity.chatId);
		if (sender === undefined) return;
		activity.statsInFlight = true;
		try {
			const result = await this.request(sender, {
				kind: "session_status",
				sessionId: activity.sessionId,
			});
			if (
				result.ok &&
				this.liveActivities.get(
					activityKey(activity.chatId, activity.sessionId),
				) === activity
			) {
				activity.liveStatus = (result.value as HarnessSessionStatus).live;
				this.renderLiveActivity(activity);
			}
		} catch {
			// Activity reporting is best-effort and must not affect input delivery.
		} finally {
			activity.statsInFlight = false;
		}
	}

	private finishActivitySubmission(activity: LiveActivity): void {
		if (activity.pendingSubmissions > 0) activity.pendingSubmissions--;
	}

	private updateLiveActivity(
		activity: LiveActivity,
		update: { readonly status?: string; readonly notice?: string },
	): void {
		if (update.status !== undefined) activity.status = update.status;
		if (update.notice) activity.notices.push(update.notice);
		if (activity.notices.length > 12) activity.notices.shift();
		this.renderLiveActivity(activity);
	}

	private updateActivityInput(
		activity: LiveActivity,
		inputId: string,
		state: string,
		detail?: string,
	): void {
		const existing = activity.queuedInputs.find(
			(input) => input.inputId === inputId,
		);
		const previousState = existing?.state;
		const terminalStates = new Set(["completed", "failed", "uncertain"]);
		if (
			existing &&
			terminalStates.has(existing.state) &&
			!terminalStates.has(state)
		)
			return;
		if (existing) existing.state = state;
		else {
			const completed = activity.queuedInputs.findIndex(
				(input) => input.state === "completed",
			);
			if (completed >= 0) activity.queuedInputs.splice(completed, 1);
			if (activity.queuedInputs.length < ACTIVITY_INPUT_HISTORY_LIMIT)
				activity.queuedInputs.push({ inputId, state });
			else if (state !== "completed") {
				if (activity.overflowInputIds.size < ACTIVITY_OVERFLOW_INPUT_LIMIT)
					activity.overflowInputIds.add(inputId);
				else activity.untrackedInputOverflow = true;
			}
		}
		if (state === "completed") {
			activity.overflowInputIds.delete(inputId);
			activity.failedOverflowInputIds.delete(inputId);
		} else if (state === "failed" || state === "uncertain") {
			if (activity.overflowInputIds.delete(inputId)) {
				if (
					activity.failedOverflowInputIds.size < ACTIVITY_OVERFLOW_INPUT_LIMIT
				)
					activity.failedOverflowInputIds.add(inputId);
				else {
					activity.overflowInputIds.add(inputId);
					activity.untrackedFailureOverflow = true;
				}
			} else if (
				!activity.queuedInputs.some((input) => input.inputId === inputId) &&
				activity.untrackedInputOverflow
			)
				activity.untrackedFailureOverflow = true;
		}
		const canceledByUser =
			state === "failed" && detail?.toLowerCase() === "input canceled";
		if (
			(state === "failed" || state === "uncertain") &&
			previousState !== state
		)
			activity.notices.push(
				canceledByUser
					? `Input ${inputId}: canceled by user`
					: `Input ${inputId}: ${state}${state === "uncertain" ? " (not resent)" : ""}`,
			);
		if (activity.notices.length > 12) activity.notices.shift();
		if (state === "pending")
			activity.status = activity.submittedWhileRunning
				? "В очереди Pi"
				: "Отправляю в Pi";
		if (state === "uncertain" || state === "failed") {
			this.stopLiveActivityStats(activity);
			activity.status =
				state === "uncertain"
					? "Статус доставки неизвестен"
					: canceledByUser
						? "Отменено пользователем"
						: "Ошибка отправки";
		}
		this.renderLiveActivity(activity);
	}

	private stopLiveActivityStats(activity: LiveActivity): void {
		if (activity.statsTimer) clearInterval(activity.statsTimer);
		activity.statsTimer = undefined;
	}

	private async waitForEventQueue(chatId: number): Promise<boolean> {
		const queue = this.queues.get(chatId);
		if (!queue) return true;
		if (!queue.messages.length && !queue.draining && !queue.drainTimer)
			return !queue.failed;
		await new Promise<void>((resolve) => queue.idleWaiters.push(resolve));
		return !queue.failed;
	}

	private hasUnsettledActivityInputs(activity: LiveActivity): boolean {
		return (
			activity.untrackedInputOverflow ||
			activity.untrackedFailureOverflow ||
			activity.overflowInputIds.size > 0 ||
			activity.failedOverflowInputIds.size > 0 ||
			activity.queuedInputs.some((input) => input.state !== "completed")
		);
	}

	private reconcileOverflowAtRunSettlement(sessionId: SessionId): void {
		for (const activity of this.activitiesForSession(sessionId)) {
			activity.overflowInputIds.clear();
			if (!activity.untrackedFailureOverflow)
				activity.untrackedInputOverflow = false;
			this.renderLiveActivity(activity);
		}
	}

	private scheduleLiveActivityFinish(
		sessionId: SessionId,
		settledByRun = false,
	): void {
		for (const activity of this.activitiesForSession(sessionId)) {
			if (
				!settledByRun &&
				!activity.queuedInputs.some((input) => input.state === "completed") &&
				activity.overflowInputIds.size === 0
			)
				continue;
			if (this.hasUnsettledActivityInputs(activity)) continue;
			if (activity.finishTimer) continue;
			activity.finishTimer = setTimeout(() => {
				activity.finishTimer = undefined;
				if (
					activity.pendingSubmissions === 0 &&
					!this.runningSessions.has(sessionId)
				)
					void this.finishLiveActivities(sessionId);
			}, 0);
		}
	}

	private async finishLiveActivities(sessionId: SessionId): Promise<void> {
		const activities = [...this.liveActivities.values()].filter(
			(activity) => activity.sessionId === sessionId,
		);
		for (const activity of activities) {
			if (activity.pendingSubmissions > 0 || activity.finishing) continue;
			if (this.hasUnsettledActivityInputs(activity)) {
				const hasFailedInput =
					activity.untrackedFailureOverflow ||
					activity.failedOverflowInputIds.size > 0 ||
					activity.queuedInputs.some((input) =>
						["failed", "uncertain"].includes(input.state),
					);
				if (!hasFailedInput) activity.status = "Ожидаю подтверждения Pi";
				this.renderLiveActivity(activity);
				continue;
			}
			activity.finishing = true;
			const generation = activity.turnGeneration;
			activity.status = "Готово";
			activity.thinking = false;
			this.renderLiveActivity(activity);
			const delivered = await this.waitForEventQueue(activity.chatId);
			await activity.renderQueue;
			if (
				activity.turnGeneration !== generation ||
				activity.pendingSubmissions > 0 ||
				this.hasUnsettledActivityInputs(activity)
			) {
				activity.finishing = false;
				continue;
			}
			if (!delivered) {
				activity.finishing = false;
				activity.status = "Ответ не удалось доставить";
				activity.notices.push("Telegram не подтвердил доставку ответа.");
				this.renderLiveActivity(activity);
				continue;
			}
			await this.deleteLiveActivity(activity);
		}
	}

	private async deleteLiveActivity(activity: LiveActivity): Promise<void> {
		await activity.renderQueue;
		if (activity.statsTimer) clearInterval(activity.statsTimer);
		activity.statsTimer = undefined;
		if (activity.finishTimer) clearTimeout(activity.finishTimer);
		activity.finishTimer = undefined;
		const key = activityKey(activity.chatId, activity.sessionId);
		if (this.liveActivities.get(key) === activity)
			this.liveActivities.delete(key);
		if (activity.messageId !== undefined) {
			const deleted = await this.telegramCall((signal) =>
				this.bot.api.deleteMessage(
					activity.chatId,
					activity.messageId as number,
					signal,
				),
			);
			if (!deleted.ok)
				this.reportError(
					"Telegram activity bubble could not be deleted",
					deleted.error,
				);
		}
	}

	private async confirmInputAccepted(
		chatId: number,
		messageId: number | undefined,
		inputId: string,
		activity: LiveActivity,
		acknowledgement?: string,
	): Promise<void> {
		this.finishActivitySubmission(activity);
		if (messageId !== undefined)
			void this.reactToAcceptedInput(chatId, messageId, inputId);
		this.updateActivityInput(
			activity,
			inputId,
			activity.submittedWhileRunning ? "queued" : "accepted",
		);
		if (acknowledgement && !acknowledgement.startsWith("Input accepted:"))
			activity.notices.push(acknowledgement);
		this.renderLiveActivity(activity);
		this.scheduleLiveActivityFinish(activity.sessionId);
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
		const selectionSaved = await this.setSelected(chatId, session.id);
		this.previews.delete(chatId);
		await this.sendDirect(
			chatId,
			`Selected ${sessionLabel(session)}. Ordinary messages now target this session.${selectionSaved ? "" : SELECTION_NOT_SAVED_WARNING}`,
		);
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
		const selectionSaved = await this.setSelected(chatId, session.id);
		this.previews.delete(chatId);
		await this.sendDirect(
			chatId,
			`Selected ${sessionLabel(session)}. Ordinary messages now target this session.${selectionSaved ? "" : SELECTION_NOT_SAVED_WARNING}`,
		);
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
					`${this.selected.get(chatId) === session.id ? "✓ " : ""}${shortSessionLabel(session)}`,
					`session:select:${session.id}`,
				),
				inlineButton("Подробнее", `session:details:${session.id}`),
			],
		]);
		const summaries = visible.map(
			(session) =>
				`${this.selected.get(chatId) === session.id ? "✓ " : ""}${shortSessionLabel(session)} · ${session.status} · ${compactSessionPath(session.cwd)}`,
		);
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
				? `Сессии · ${sessions.length}\nВыберите сессию или откройте подробности.\n${summaries.join("\n")}`
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
			rows.push([
				inlineButton("Возобновить", `session:resume:${session.id}`),
				inlineButton(
					"Возобновить и выбрать",
					`session:resume-select:${session.id}`,
				),
			]);
		else if (session.status === "starting" || session.status === "failed")
			rows.push([
				inlineButton("Остановить/восстановить…", `session:stop:${session.id}`),
			]);
		if (session.status === "stopped")
			rows.push([inlineButton("Удалить…", `session:delete:${session.id}`)]);
		rows.push([inlineButton("К списку", "menu:sessions")]);
		await this.updatePanel(
			chatId,
			`${sessionLabel(session)}\nСуществует: да · Выбрана для сообщений: ${this.selected.get(chatId) === session.id ? "да" : "нет"}\nСтатус Pi: ${session.status === "running" ? "записан как работающий (после аварийного перезапуска может быть устаревшим)" : session.status === "stopped" ? "остановлен" : session.status === "starting" ? "запускается или восстанавливается" : "ошибка/устаревший статус"} (${session.status})${session.status === "failed" ? "\nАвтоматическое переподключение и создание замены недоступны. Доступное действие: остановить сохранённую запись и затем выбрать другую сессию." : ""}\nПапка: ${panelPath(session.cwd)}`,
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
			const generation = this.nextPanelGeneration(chatId);
			const rows: InlineButton[][] = visible.map(({ entry }) => {
				const token = this.makeIntentToken();
				this.folderIntents.set(token, {
					chatId,
					messageId,
					generation,
					parent: listing.cwd,
					target: path.join(listing.cwd, entry.name),
				});
				return [
					inlineButton(`📁 ${buttonLabel(entry.name, 48)}/`, `folder:${token}`),
				];
			});
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
		token: string,
		messageId: number,
	): Promise<void> {
		const intent = this.folderIntents.get(token);
		if (
			!intent ||
			intent.chatId !== chatId ||
			intent.messageId !== messageId ||
			intent.generation !== this.panelGenerations.get(chatId) ||
			intent.parent !==
				(this.currentDirectories.get(chatId) ?? this.options.initialCwd)
		)
			return this.showStaleCallback(chatId, messageId);
		this.folderIntents.delete(token);
		try {
			this.currentDirectories.set(
				chatId,
				await resolveExistingDirectory(intent.target),
			);
			this.folderPages.set(chatId, 0);
		} catch {
			return this.showStaleCallback(chatId, messageId);
		}
		await this.renderFolders(chatId, sender, messageId);
	}

	private async renderModels(
		chatId: number,
		sender: number,
		messageId: number,
	): Promise<void> {
		const sessionId = this.previews.get(chatId) ?? this.selected.get(chatId);
		if (sessionId && !this.knownSessions.has(sessionId))
			return this.showStaleCallback(chatId, messageId);
		if (!sessionId)
			return this.updatePanel(
				chatId,
				"Сначала выберите сессию.",
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
			).then(() => {});
		const inspected = await this.request(sender, {
			kind: "inspect",
			sessionId,
		});
		if (!inspected.ok)
			return this.updatePanel(
				chatId,
				inspected.error.message,
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
			).then(() => {});
		const session = inspected.value as SessionSummary;
		this.rememberSession(session);
		if (session.status !== "running")
			return this.updatePanel(
				chatId,
				session.status === "stopped"
					? `${sessionLabel(session)} exists but Pi is stopped. Model controls require a running Pi. Resume it first.`
					: `${sessionLabel(session)} exists with Pi status ${session.status}; model controls require a running Pi. No reattach or replacement is available.`,
				keyboard([
					...(session.status === "stopped"
						? [
								[
									inlineButton(
										"Возобновить и выбрать",
										`session:resume-select:${session.id}`,
									),
								],
							]
						: []),
					[inlineButton("Назад", "menu:home")],
				]),
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
			`Модель просмотра · ${activitySessionLabel(sessionId, this.sessionNames.get(sessionId))}`,
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
		if (!choices || !this.knownSessions.has(choices.sessionId))
			return this.showStaleCallback(chatId, messageId);
		const index = Number(rawIndex);
		const model = choices.models[index];
		if (
			!Number.isSafeInteger(index) ||
			!model ||
			(this.previews.get(chatId) ?? this.selected.get(chatId)) !==
				choices.sessionId
		)
			return this.renderModels(chatId, sender, messageId);
		if (
			!(await this.requireRunningSession(
				chatId,
				sender,
				choices.sessionId,
				"model",
			))
		)
			return this.renderPanel(chatId, sender, messageId);
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
		await this.sendDirect(
			chatId,
			change.effortConfirmed === false
				? "Модель выбрана, но усилие не подтверждено. Проверьте /status перед повтором."
				: `Модель ${model.provider}/${model.id} выбрана.`,
		);
		await this.renderPanel(chatId, sender, messageId);
	}

	private async renderEfforts(
		chatId: number,
		sender: number,
		messageId: number,
	): Promise<void> {
		const sessionId = this.previews.get(chatId) ?? this.selected.get(chatId);
		if (sessionId && !this.knownSessions.has(sessionId))
			return this.showStaleCallback(chatId, messageId);
		if (!sessionId)
			return this.updatePanel(
				chatId,
				"Сначала выберите сессию.",
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
			).then(() => {});
		const inspected = await this.request(sender, {
			kind: "inspect",
			sessionId,
		});
		if (!inspected.ok)
			return this.updatePanel(
				chatId,
				inspected.error.message,
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
			).then(() => {});
		const session = inspected.value as SessionSummary;
		this.rememberSession(session);
		if (session.status !== "running")
			return this.updatePanel(
				chatId,
				session.status === "stopped"
					? `${sessionLabel(session)} exists but Pi is stopped. Effort controls require a running Pi. Resume it first.`
					: `${sessionLabel(session)} exists with Pi status ${session.status}; effort controls require a running Pi. No reattach or replacement is available.`,
				keyboard([
					...(session.status === "stopped"
						? [
								[
									inlineButton(
										"Возобновить и выбрать",
										`session:resume-select:${session.id}`,
									),
								],
							]
						: []),
					[inlineButton("Назад", "menu:home")],
				]),
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
			`Усилие просмотра · ${activitySessionLabel(sessionId, this.sessionNames.get(sessionId))} · ${catalog.current ? oneLine(catalog.current) : "не задано"}`,
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
		if (!choices || !this.knownSessions.has(choices.sessionId))
			return this.showStaleCallback(chatId, messageId);
		const index = Number(rawIndex);
		const effort = choices.levels[index];
		if (
			!Number.isSafeInteger(index) ||
			effort === undefined ||
			(this.previews.get(chatId) ?? this.selected.get(chatId)) !==
				choices.sessionId
		)
			return this.renderEfforts(chatId, sender, messageId);
		if (
			!(await this.requireRunningSession(
				chatId,
				sender,
				choices.sessionId,
				"effort",
			))
		)
			return this.renderPanel(chatId, sender, messageId);
		const result = await this.request(sender, {
			kind: "effort_set",
			sessionId: choices.sessionId,
			effort,
		});
		if (!result.ok) await this.sendDirect(chatId, result.error.message);
		else await this.sendDirect(chatId, `Усилие установлено: ${effort}.`);
		await this.renderPanel(chatId, sender, messageId);
	}

	private createSelectIntent(
		chatId: number,
		sender: number,
		sessionId: SessionId,
	): string {
		const token = this.makeIntentToken();
		this.selectIntents.set(token, { chatId, sender, sessionId });
		while (this.selectIntents.size > 128)
			this.selectIntents.delete(
				this.selectIntents.keys().next().value as string,
			);
		return token;
	}

	private bindSelectMessage(
		token: string,
		messageId: number | undefined,
	): void {
		const intent = this.selectIntents.get(token);
		if (intent && messageId !== undefined) intent.messageId = messageId;
	}

	private async performSelectIntent(
		chatId: number,
		sender: number,
		token: string,
		messageId: number,
	): Promise<void> {
		const intent = this.selectIntents.get(token);
		if (
			!intent ||
			intent.chatId !== chatId ||
			intent.sender !== sender ||
			intent.messageId !== messageId
		) {
			await this.sendDirect(
				chatId,
				"This action is stale or belongs to another chat.",
			);
			return;
		}
		this.selectIntents.delete(token);
		const inspected = await this.request(sender, {
			kind: "inspect",
			sessionId: intent.sessionId,
		});
		if (!inspected.ok) {
			await this.sendDirect(chatId, inspected.error.message);
			return;
		}
		this.rememberSession(inspected.value as SessionSummary);
		const saved = await this.setSelected(chatId, intent.sessionId);
		this.previews.delete(chatId);
		await this.sendDirect(
			chatId,
			`Selected ${sessionLabel(inspected.value as SessionSummary)}.${saved ? "" : SELECTION_NOT_SAVED_WARNING}`,
		);
		await this.refreshExistingPanel(chatId, sender);
	}

	private createResumeSelectIntent(
		chatId: number,
		sender: number,
		sessionId: SessionId,
	): string {
		const token = this.makeIntentToken();
		this.resumeSelectIntents.set(token, {
			chatId,
			sender,
			sessionId,
			invalidationEpoch: this.confirmationEpochs.get(sessionId) ?? 0,
		});
		return token;
	}

	private bindResumeSelectMessage(
		token: string,
		messageId: number | undefined,
	): void {
		const intent = this.resumeSelectIntents.get(token);
		if (intent && messageId !== undefined) intent.messageId = messageId;
	}

	private async performResumeSelectIntent(
		chatId: number,
		sender: number,
		token: string,
		messageId: number,
	): Promise<void> {
		const intent = this.resumeSelectIntents.get(token);
		if (
			!intent ||
			intent.chatId !== chatId ||
			intent.sender !== sender ||
			intent.messageId !== messageId
		) {
			await this.sendDirect(
				chatId,
				"This action is stale or belongs to another chat.",
			);
			return;
		}
		this.resumeSelectIntents.delete(token);
		this.inFlightConfirmationRefs.set(
			intent.sessionId,
			(this.inFlightConfirmationRefs.get(intent.sessionId) ?? 0) + 1,
		);
		try {
			const isCurrent = () =>
				(this.confirmationEpochs.get(intent.sessionId) ?? 0) ===
				intent.invalidationEpoch;
			if (!isCurrent()) {
				await this.sendDirect(
					chatId,
					"This action is stale; inspect the current session in /menu.",
				);
				return;
			}
			const inspected = await this.request(sender, {
				kind: "inspect",
				sessionId: intent.sessionId,
			});
			if (!isCurrent()) {
				await this.sendDirect(
					chatId,
					"This action is stale; inspect the current session in /menu.",
				);
				return;
			}
			if (
				!inspected.ok ||
				(inspected.value as SessionSummary).status !== "stopped"
			) {
				await this.sendDirect(
					chatId,
					"This session is no longer stopped. No action was taken; inspect /menu.",
				);
				return;
			}
			const resumed = await this.withSessionRequestLock(
				intent.sessionId,
				async () => {
					if (!isCurrent()) return undefined;
					const current = await this.dispatchRequest(sender, {
						kind: "inspect",
						sessionId: intent.sessionId,
					});
					if (
						!isCurrent() ||
						!current.ok ||
						(current.value as SessionSummary).status !== "stopped"
					)
						return undefined;
					if (!isCurrent()) return undefined;
					return this.dispatchRequest(sender, {
						kind: "resume",
						sessionId: intent.sessionId,
					});
				},
			);
			if (!resumed) {
				await this.sendDirect(
					chatId,
					isCurrent()
						? "This session is no longer stopped. No action was taken; inspect /menu."
						: "This action is stale; inspect the current session in /menu.",
				);
				return;
			}
			if (!resumed.ok) {
				await this.sendDirect(
					chatId,
					`${resumed.error.message} Selection is unchanged; ordinary messages still target ${this.selected.get(chatId) ? this.sessionFooter(this.selected.get(chatId) as SessionId) : "no session"}.`,
				);
				return;
			}
			this.rememberSession(resumed.value as SessionSummary);
			if (!isCurrent()) {
				await this.sendDirect(
					chatId,
					`Session ${this.sessionFooter(intent.sessionId)} resumed, but this action became stale; selection is unchanged. Inspect /menu.`,
				);
				return;
			}
			const saved = await this.setSelected(chatId, intent.sessionId);
			this.invalidateSessionConfirmations(intent.sessionId);
			this.previews.delete(chatId);
			await this.sendDirect(
				chatId,
				`Session ${this.sessionFooter(intent.sessionId)} resumed and selected. Ordinary messages now target ${this.sessionFooter(intent.sessionId)}.${saved ? "" : SELECTION_NOT_SAVED_WARNING}`,
			);
		} finally {
			this.releaseInFlightConfirmation(intent.sessionId);
			await this.refreshExistingPanel(chatId, sender);
		}
	}

	private async resumeSessionFromPanel(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		messageId: number,
	): Promise<void> {
		const inspected = await this.request(sender, {
			kind: "inspect",
			sessionId,
		});
		if (
			!inspected.ok ||
			(inspected.value as SessionSummary).status !== "stopped"
		) {
			await this.showStaleCallback(chatId, messageId);
			return;
		}
		const result = await this.request(sender, { kind: "resume", sessionId });
		if (!result.ok)
			await this.sendDirect(
				chatId,
				`${result.error.message} Selection is unchanged; use /menu to inspect the current session state.`,
			);
		else {
			this.invalidateSessionConfirmations(sessionId);
			this.rememberSession(result.value as SessionSummary);
			const target = this.selected.get(chatId);
			await this.sendDirect(
				chatId,
				target === sessionId
					? `Session ${this.sessionFooter(sessionId)} resumed. Selection is unchanged; ordinary messages still target this session.`
					: `Session ${this.sessionFooter(sessionId)} is running, not selected. Selection is unchanged; ordinary messages still target ${target ? this.sessionFooter(target) : "no session"}. Select it with /use ${sessionId} or the Select button.`,
			);
		}
		await this.renderPanel(chatId, sender, messageId);
	}

	private async resumeAndSelectFromPanel(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		messageId: number,
	): Promise<void> {
		const inspected = await this.request(sender, {
			kind: "inspect",
			sessionId,
		});
		if (
			!inspected.ok ||
			(inspected.value as SessionSummary).status !== "stopped"
		) {
			await this.showStaleCallback(chatId, messageId);
			return;
		}
		const result = await this.request(sender, { kind: "resume", sessionId });
		if (!result.ok) {
			await this.sendDirect(
				chatId,
				`${result.error.message} Selection is unchanged; messages still target ${this.selected.get(chatId) ?? "no selected session"}.`,
			);
			return this.renderPanel(chatId, sender, messageId);
		}
		this.invalidateSessionConfirmations(sessionId);
		this.rememberSession(result.value as SessionSummary);
		const saved = await this.setSelected(chatId, sessionId);
		this.previews.delete(chatId);
		await this.sendDirect(
			chatId,
			`Session ${this.sessionFooter(sessionId)} resumed and selected. Messages now target ${this.sessionFooter(sessionId)}.${saved ? "" : SELECTION_NOT_SAVED_WARNING}`,
		);
		await this.renderPanel(chatId, sender, messageId);
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
		const targetIdentity = renamePromptIdentity(
			sessionLabel(session),
			sessionId,
		);
		await this.promptForPathName(
			chatId,
			{ kind: "rename", sessionId },
			session.cwd,
			`${RENAME_NAME_PREFIX}${targetIdentity}${RENAME_NAME_SEPARATOR}`,
			RENAME_NAME_INSTRUCTIONS,
			undefined,
			`${RENAME_NAME_PREFIX}${targetIdentity}`,
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
		await this.sendDirect(
			chatId,
			`Имя сессии ${this.sessionFooter(sessionId)} очищено.`,
		);
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
		if (
			(action === "delete" && session.status !== "stopped") ||
			(action === "stop" && session.status === "stopped")
		) {
			await this.sendDirect(
				chatId,
				action === "delete"
					? `${sessionLabel(session)} is ${session.status}, not stopped. Delete is unavailable; stop it first.`
					: `${sessionLabel(session)} is already stopped. No stop action was taken.`,
			);
			return this.renderSessionDetails(chatId, sender, sessionId, messageId);
		}
		const prompt =
			action === "stop"
				? `Остановить ${sessionLabel(session)}?`
				: `Удалить запись ${sessionLabel(session)}? Будут удалены запись harnessd и полученные вложения во входящих; файлы в рабочей папке и файлы Pi останутся.`;
		this.invalidateChatConfirmations(chatId);
		const token = this.makeIntentToken();
		const generation = this.nextPanelGeneration(chatId);
		this.confirmationIntents.set(token, {
			chatId,
			messageId,
			generation,
			invalidationEpoch: this.confirmationEpochs.get(sessionId) ?? 0,
			sessionId,
			action,
			expectedStatus: session.status,
		});
		await this.updatePanel(
			chatId,
			prompt,
			keyboard([
				[
					inlineButton("Подтвердить", `action:confirm:${token}`),
					inlineButton("Отмена", "action:cancel"),
				],
			]),
			messageId,
		);
	}

	private async performSessionAction(
		chatId: number,
		sender: number,
		token: string,
		messageId: number,
	): Promise<void> {
		const intent = this.confirmationIntents.get(token);
		if (
			!intent ||
			intent.chatId !== chatId ||
			intent.messageId !== messageId ||
			intent.generation !== this.panelGenerations.get(chatId)
		)
			return this.showStaleCallback(chatId, messageId);
		const { action, sessionId } = intent;
		this.inFlightConfirmationRefs.set(
			sessionId,
			(this.inFlightConfirmationRefs.get(sessionId) ?? 0) + 1,
		);
		this.confirmationIntents.delete(token);
		try {
			const inspected = await this.request(sender, {
				kind: "inspect",
				sessionId,
			});
			if (!inspected.ok) {
				await this.sendDirect(chatId, inspected.error.message);
				return this.renderSessions(chatId, sender, messageId);
			}
			const current = inspected.value as SessionSummary;
			this.rememberSession(current);
			const stillValid = () =>
				(this.confirmationEpochs.get(sessionId) ?? 0) ===
				intent.invalidationEpoch;
			if (current.status !== intent.expectedStatus || !stillValid())
				return this.showStaleCallback(chatId, messageId);
			const { result, cleanupPending, invalidated } =
				action === "delete"
					? await this.deleteSessionAndInbox(sender, sessionId, stillValid)
					: {
							result: stillValid()
								? await this.request(sender, {
										kind: action,
										sessionId,
									} as TelegramRequest)
								: {
										requestId: randomUUID(),
										ok: false as const,
										error: {
											code: "confirmation_expired",
											message: "Confirmation expired.",
										},
									},
							cleanupPending: false,
						};
			if (invalidated) return this.showStaleCallback(chatId, messageId);
			if (!result.ok) {
				const selectedTarget = this.selected.get(chatId);
				await this.sendDirect(
					chatId,
					`${result.error.message} Selection is unchanged${selectedTarget ? `; messages target ${this.sessionFooter(selectedTarget)}` : "; no session is selected"}. Next: refresh /menu and choose an available action.`,
				);
				return this.renderPanel(chatId, sender, messageId);
			}
			let selectionPersistenceWarning = false;
			this.invalidateSessionConfirmations(sessionId);
			if (action === "stop") {
				if (this.selected.get(chatId) === sessionId) {
					selectionPersistenceWarning = !(await this.clearSelected(chatId));
					this.previews.delete(chatId);
				}
			} else {
				this.invalidateSession(sessionId);
				if (cleanupPending)
					await this.sendDirect(
						chatId,
						"Session deleted; inbox cleanup is pending.",
					);
				for (const [selectedChat, selectedId] of this.selected) {
					if (selectedId === sessionId) {
						selectionPersistenceWarning =
							!(await this.clearSelected(selectedChat)) ||
							selectionPersistenceWarning;
						this.previews.delete(selectedChat);
					}
				}
			}
			const selectedAfterAction = this.selected.get(chatId);
			const actionOutcome =
				action === "stop"
					? `Session ${this.sessionFooter(sessionId)} stopped.`
					: `Stopped session ${this.sessionFooter(sessionId)} deleted from harnessd.`;
			const outcome = `${actionOutcome} ${selectedAfterAction ? `Selection unchanged; messages target ${this.sessionFooter(selectedAfterAction)}.` : "This chat has no selected session for messages."} ${action === "stop" ? `Resume and select it below, or resume without selecting with /resume ${sessionId}.` : "Next: choose another session in /menu."}${selectionPersistenceWarning ? " Saved selection cleanup may be retried after restart." : ""}${cleanupPending ? " Inbox cleanup is pending." : ""}`;
			if (action === "stop") {
				const token = this.createResumeSelectIntent(chatId, sender, sessionId);
				await this.sendWithDeadline(
					chatId,
					outcome,
					{
						reply_markup: keyboard([
							[
								inlineButton(
									"Возобновить и выбрать",
									`action:resume-select:${token}`,
								),
							],
						]),
					},
					undefined,
					(messageId) => this.bindResumeSelectMessage(token, messageId),
				);
			} else await this.sendDirect(chatId, outcome);
			await this.renderPanel(chatId, sender, messageId);
		} finally {
			this.releaseInFlightConfirmation(sessionId);
		}
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
		if (event.kind === "activity" && event.activityEvent) {
			this.updateLiveActivityFromEvent(event.sessionId, event.activityEvent);
			return;
		}
		if (event.kind === "status") {
			if (event.text === "harness_recovered")
				this.reportedErrors.delete(event.sessionId);
			if (
				event.text === "harness_restarting" ||
				event.text === "harness_recovered" ||
				event.text === "harness_recovery_failed"
			) {
				this.invalidateSessionConfirmations(event.sessionId);
				this.runningSessions.delete(event.sessionId);
				this.stopTyping(event.sessionId);
			}
			if (event.text === "agent_start") {
				this.invalidateSessionConfirmations(event.sessionId);
				this.runningSessions.add(event.sessionId);
				this.startTyping(event.sessionId);
				const turn: TurnBuffer = {
					chunks: [],
					subagentStream: new SubagentTextStream(),
					recipients: new Set(),
					statusRecipients: new Set(),
					pendingInputs: new Set(),
					characters: 0,
					settled: false,
					interrupted: false,
					overflow: false,
				};
				this.turnBuffers.set(event.sessionId, turn);
				for (const record of this.inputAttributions.values())
					if (
						record.sessionId === event.sessionId &&
						record.waitingForRun &&
						!record.terminal
					)
						this.associateInputWithTurn(record, turn);
				for (const activity of this.activitiesForSession(event.sessionId)) {
					activity.subagentStatus = undefined;
					activity.status = "Pi выполняет ход сессии";
					activity.thinking = false;
					this.renderLiveActivity(activity);
					void this.refreshLiveActivityStats(activity);
				}
				return;
			}
			if (event.text === "agent_end") return;
			if (event.text === "agent_settled") {
				this.invalidateSessionConfirmations(event.sessionId);
				this.runningSessions.delete(event.sessionId);
				this.stopTyping(event.sessionId);
				const turn = this.turnBuffers.get(event.sessionId);
				if (turn) this.settleInputAttributions(turn);
				this.flushTurn(event.sessionId);
				this.reconcileOverflowAtRunSettlement(event.sessionId);
				this.scheduleLiveActivityFinish(event.sessionId, true);
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
			const detail = redactDiagnosticText(
				event.text?.trim() || "Pi reported an unspecified session error.",
				[this.options.token],
			);
			const fingerprint = detail;
			let seen = this.reportedErrors.get(event.sessionId);
			if (!seen) {
				seen = new Set();
				this.reportedErrors.set(event.sessionId, seen);
			}
			if (seen.has(fingerprint)) return;
			seen.add(fingerprint);
			if (event.fatal) {
				this.runningSessions.delete(event.sessionId);
				this.stopTyping(event.sessionId);
				this.flushTurn(event.sessionId, true);
			}
			for (const activity of this.activitiesForSession(event.sessionId)) {
				activity.notices.push(`⚠️ ${detail}`);
				if (event.fatal) this.stopLiveActivityStats(activity);
				activity.status = event.fatal ? "Ошибка сессии" : activity.status;
				this.renderLiveActivity(activity);
			}
			this.enqueueForSelected(event.sessionId, `Pi error: ${detail}`);
			return;
		}
		if (event.kind === "input" && event.inputEvent) {
			const { inputId, state, detail } = event.inputEvent;
			this.trackInputEvent(event.sessionId, inputId, state);
			const canceledByUser =
				state === "failed" && detail?.toLowerCase() === "input canceled";
			const inputPresentation = canceledByUser
				? `Input ${inputId}: canceled by user`
				: `Input ${inputId}: ${state}${state === "uncertain" ? " (not resent)" : ""}`;
			if (state === "failed" || state === "uncertain")
				this.stopTyping(event.sessionId);
			if (state === "accepted") return;
			const activities = this.activitiesForSession(event.sessionId);
			if (activities.length) {
				for (const activity of activities) {
					this.updateActivityInput(activity, inputId, state, detail);
					if (state === "completed")
						this.scheduleLiveActivityFinish(event.sessionId, true);
				}
				if (state === "failed" || state === "uncertain")
					this.enqueueForSelected(
						event.sessionId,
						`${inputPresentation}${!canceledByUser && detail ? ` · ${redactDiagnosticText(detail, [this.options.token])}` : ""}`,
						{ inputId, state },
					);
				return;
			}
			this.enqueueForSelected(event.sessionId, inputPresentation, {
				inputId,
				state,
			});
		}
	}

	private activitiesForSession(sessionId: SessionId): LiveActivity[] {
		return [...this.liveActivities.values()].filter(
			(activity) => activity.sessionId === sessionId,
		);
	}

	private updateLiveActivityFromEvent(
		sessionId: SessionId,
		event: HarnessActivityEvent,
	): void {
		const activities = this.activitiesForSession(sessionId);
		const notification =
			event.type === "notification"
				? parseNotificationText(event.text)
				: undefined;
		if (notification) {
			const turn = this.turnBuffers.get(sessionId);
			if (turn)
				for (const status of notification.statuses) {
					turn.subagentStatus = status;
					this.applySubagentStatus(sessionId, turn.statusRecipients, status);
				}
			if (!notification.visibleText.trim()) return;
			if (activities.length === 0) {
				this.enqueueForSelected(
					sessionId,
					`Pi: ${redactDiagnosticText(notification.visibleText, [this.options.token])}`,
				);
				return;
			}
		}
		if (activities.length === 0) return;
		for (const activity of activities) {
			switch (event.type) {
				case "thinking":
					activity.thinking = event.active;
					break;
				case "tool_start": {
					const existing = activity.tools.find(
						(tool) => tool.id === event.toolCallId,
					);
					if (existing) {
						existing.status = "running";
						existing.history.push("running");
						if (existing.history.length > 4) existing.history.shift();
					} else
						activity.tools.push({
							id: event.toolCallId,
							summary: truncateDiagnostic(
								redactDiagnosticText(event.summary, [this.options.token]),
								700,
							),
							status: "running",
							history: ["running"],
						});
					if (activity.tools.length > 40) activity.tools.shift();
					activity.status = "Вызов инструмента";
					void this.refreshLiveActivityStats(activity);
					break;
				}
				case "tool_end": {
					const tool = activity.tools.find(
						(item) => item.id === event.toolCallId,
					);
					if (tool) {
						tool.status = event.failed ? "failed" : "done";
						tool.history.push(tool.status);
						if (tool.history.length > 4) tool.history.shift();
					}
					activity.status = "Pi выполняет ход сессии";
					void this.refreshLiveActivityStats(activity);
					break;
				}
				case "notification":
					if (notification?.visibleText.trim()) {
						activity.notices.push(
							redactDiagnosticText(notification.visibleText, [
								this.options.token,
							]),
						);
						if (activity.notices.length > 12) activity.notices.shift();
					}
					break;
			}
			this.renderLiveActivity(activity);
		}
	}

	private getInputAttribution(
		sessionId: SessionId,
		inputId: InputId,
	): InputAttribution | undefined {
		const existing = this.inputAttributions.get(inputId);
		if (existing)
			return existing.sessionId === sessionId ? existing : undefined;
		if (this.inputAttributions.size >= MAX_INPUT_ATTRIBUTIONS) {
			const expired = [...this.inputAttributions].find(
				([, record]) => record.terminal,
			);
			if (expired) this.inputAttributions.delete(expired[0]);
		}
		if (this.inputAttributions.size >= MAX_INPUT_ATTRIBUTIONS) return undefined;
		const record: InputAttribution = {
			inputId,
			sessionId,
			state: "pending",
			terminal: false,
			pendingSeen: false,
			steered: false,
			waitingForRun: false,
		};
		this.inputAttributions.set(inputId, record);
		return record;
	}

	private associateInputWithTurn(
		record: InputAttribution,
		turn: TurnBuffer,
	): void {
		record.turn = turn;
		record.waitingForRun = false;
		turn.pendingInputs.add(record.inputId);
		if (record.chatId !== undefined && turn.statusRecipients.size < 128) {
			turn.statusRecipients.add(record.chatId);
			if (turn.subagentStatus) {
				const activity = this.liveActivities.get(
					activityKey(record.chatId, record.sessionId),
				);
				if (activity) {
					activity.subagentStatus = turn.subagentStatus;
					this.renderLiveActivity(activity);
				}
			}
		}
		if (record.state === "uncertain" && record.chatId !== undefined)
			if (turn.recipients.size < 128) turn.recipients.add(record.chatId);
	}

	private associateInputWithObservedRun(record: InputAttribution): void {
		if (record.turn || record.terminal) return;
		const turn = this.turnBuffers.get(record.sessionId);
		if (turn && this.runningSessions.has(record.sessionId) && !turn.settled)
			this.associateInputWithTurn(record, turn);
		else record.waitingForRun = true;
	}

	private recordInputOutcome(
		sessionId: SessionId,
		inputId: InputId,
		chatId: number,
		state: "accepted" | "uncertain" | "failed",
	): void {
		const record = this.getInputAttribution(sessionId, inputId);
		if (!record || record.terminal) return;
		record.chatId = chatId;
		record.state = state;
		if (state === "failed") {
			this.finishInputAttribution(record, false);
			return;
		}
		if (state === "accepted" && !record.turn)
			this.associateInputWithObservedRun(record);
		if (
			record.turn &&
			state === "uncertain" &&
			record.turn.recipients.size < 128
		)
			record.turn.recipients.add(chatId);
		if (record.turn?.settled && state === "uncertain")
			this.finishInputAttribution(record, true);
	}

	private trackInputEvent(
		sessionId: SessionId,
		inputId: InputId,
		state: InputDeliveryState,
	): void {
		const record = this.getInputAttribution(sessionId, inputId);
		if (!record || record.terminal) return;
		if (state === "pending") {
			if (!record.pendingSeen)
				record.steered =
					this.runningSessions.has(sessionId) ||
					[...this.inputAttributions.values()].some(
						(other) =>
							other !== record &&
							other.sessionId === sessionId &&
							!other.terminal,
					);
			record.pendingSeen = true;
			const flight = this.inFlightSubmissions.get(sessionId);
			if (flight) record.chatId ??= flight.chatId;
			if (!record.turn) this.associateInputWithObservedRun(record);
			return;
		}
		const previousState = record.state;
		record.state = state;
		if (state === "accepted" && !record.turn)
			this.associateInputWithObservedRun(record);
		if (state === "uncertain" && record.turn && record.chatId !== undefined)
			if (record.turn.recipients.size < 128)
				record.turn.recipients.add(record.chatId);
		if (state === "uncertain") {
			if (record.turn?.settled) this.finishInputAttribution(record, true);
			return;
		}
		if (state === "completed" || state === "failed") {
			const handledWithoutRunOutput =
				state === "completed" &&
				previousState === "accepted" &&
				record.steered &&
				record.turn !== undefined &&
				!record.turn.settled;
			this.finishInputAttribution(
				record,
				state === "completed" && !handledWithoutRunOutput,
			);
		}
	}

	private finishInputAttribution(
		record: InputAttribution,
		includeRecipient: boolean,
	): void {
		if (record.terminal) return;
		record.terminal = true;
		record.waitingForRun = false;
		const turn = record.turn;
		if (!turn) return;
		if (
			includeRecipient &&
			record.chatId !== undefined &&
			turn.recipients.size < 128
		)
			turn.recipients.add(record.chatId);
		turn.pendingInputs.delete(record.inputId);
		if (turn.settled && turn.pendingInputs.size === 0)
			this.flushTurn(record.sessionId, turn.interrupted, turn);
	}

	private settleInputAttributions(turn: TurnBuffer): void {
		for (const record of this.inputAttributions.values()) {
			if (record.turn !== turn || record.terminal) continue;
			if (
				record.state === "pending" &&
				record.pendingSeen &&
				record.steered &&
				!this.cancelingInputs.has(record.inputId)
			) {
				turn.pendingInputs.delete(record.inputId);
				record.turn = undefined;
				record.waitingForRun = true;
				continue;
			}
			if (record.state === "uncertain")
				this.finishInputAttribution(record, true);
			else if (!record.pendingSeen && record.state === "accepted")
				this.finishInputAttribution(record, true);
		}
	}

	private appendTurnOutput(sessionId: SessionId, text: string): void {
		let buffer = this.turnBuffers.get(sessionId);
		if (!buffer) {
			buffer = {
				chunks: [],
				subagentStream: new SubagentTextStream(),
				recipients: new Set(),
				statusRecipients: new Set(),
				pendingInputs: new Set(),
				characters: 0,
				settled: false,
				interrupted: false,
				overflow: false,
			};
			this.turnBuffers.set(sessionId, buffer);
		}
		this.appendSubagentResult(
			sessionId,
			buffer,
			buffer.subagentStream.consume(text),
		);
	}

	private appendSubagentResult(
		sessionId: SessionId,
		buffer: TurnBuffer,
		result: {
			readonly visibleText: string;
			readonly statuses: readonly string[];
		},
	): void {
		if (result.visibleText) this.appendTurnVisible(buffer, result.visibleText);
		for (const status of result.statuses) {
			buffer.subagentStatus = status;
			this.applySubagentStatus(sessionId, buffer.statusRecipients, status);
		}
	}

	private applySubagentStatus(
		sessionId: SessionId,
		chats: ReadonlySet<number>,
		status: string,
	): void {
		for (const chatId of chats) {
			const activity = this.liveActivities.get(activityKey(chatId, sessionId));
			if (activity && activity.subagentStatus !== status) {
				activity.subagentStatus = status;
				this.renderLiveActivity(activity);
			}
		}
	}

	private appendTurnVisible(buffer: TurnBuffer, text: string): void {
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

	private flushTurn(
		sessionId: SessionId,
		interrupted = false,
		target?: TurnBuffer,
	): void {
		const buffer = target ?? this.turnBuffers.get(sessionId);
		if (!buffer) return;
		buffer.settled = true;
		buffer.interrupted ||= interrupted;
		this.appendSubagentResult(
			sessionId,
			buffer,
			buffer.subagentStream.consume("", true),
		);
		if (buffer.pendingInputs.size > 0) return;
		if (this.turnBuffers.get(sessionId) === buffer)
			this.turnBuffers.delete(sessionId);
		if (buffer.characters === 0 && !buffer.overflow) return;
		let text = buffer.chunks.join("");
		if (!text.trim()) return;
		if (buffer.interrupted)
			text += "\n\n[Response interrupted before completion.]";
		if (buffer.overflow)
			text +=
				"\n\n[Additional output omitted because the response reached the queue limit.]";
		const selectedChats = new Set<number>();
		for (const [chatId, selectedId] of this.selected)
			if (selectedId === sessionId) selectedChats.add(chatId);
		const recipients = buffer.recipients.size
			? buffer.recipients
			: selectedChats;
		for (const chatId of recipients) {
			const attributed = buffer.recipients.has(chatId);
			this.enqueue(
				chatId,
				sessionId,
				attributed
					? `Фоновая сессия · ${this.eventFooter(sessionId)}\n\n${text}`
					: text,
				undefined,
				true,
				attributed,
			);
		}
	}

	private eventChannelDisabled(chatId: number): boolean {
		return this.queues.get(chatId)?.failed ?? false;
	}

	private enqueueForSelected(
		sessionId: SessionId,
		text: string,
		input?: { readonly inputId: string; readonly state: string },
		output = false,
	): void {
		for (const [chatId, selectedId] of this.selected) {
			if (selectedId === sessionId)
				this.enqueue(chatId, sessionId, text, input, output);
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

	private invalidateSession(sessionId: SessionId): void {
		this.turnBuffers.delete(sessionId);
		for (const [inputId, record] of this.inputAttributions)
			if (record.sessionId === sessionId)
				this.inputAttributions.delete(inputId);
		this.knownSessions.delete(sessionId);
		this.sessionNames.delete(sessionId);
		this.sessionCwds.delete(sessionId);
		this.reportedErrors.delete(sessionId);
		for (const [chatId, previewId] of this.previews) {
			if (previewId === sessionId) this.previews.delete(chatId);
		}
		for (const [chatId, choices] of this.modelChoices) {
			if (choices.sessionId === sessionId) this.modelChoices.delete(chatId);
		}
		for (const [chatId, choices] of this.effortChoices) {
			if (choices.sessionId === sessionId) this.effortChoices.delete(chatId);
		}
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
			if (!present.has(sessionId)) this.invalidateSession(sessionId);
		}
		for (const session of sessions) this.rememberSession(session);
	}

	private enqueue(
		chatId: number,
		sessionId: SessionId,
		text: string,
		input?: { readonly inputId: string; readonly state: string },
		output = false,
		background = false,
	): void {
		let queue = this.queues.get(chatId);
		if (!queue) {
			queue = {
				messages: [],
				pendingCharacters: 0,
				failed: false,
				overflowNotices: new Set(),
				idleWaiters: [],
			};
			this.queues.set(chatId, queue);
		}
		if (queue.failed || this.stopping) return;
		const parts = output
			? splitAssistantHtml(text, this.eventFooter(sessionId), sessionId)
			: splitMessageWithFooter(text, this.eventFooter(sessionId));
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
				this.queueOverflow(queue, sessionId, background);
				break;
			}
			queue.messages.push({
				sessionId,
				text: part,
				...(output ? { output: true as const } : {}),
				...(background ? { background: true as const } : {}),
			});
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
				if (removed) {
					queue.pendingCharacters -= removed.text.length;
					this.queueOverflow(
						queue,
						removed.sessionId,
						removed.background === true,
					);
				}
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

	private queueOverflow(
		queue: ChatQueue,
		sessionId: SessionId,
		background = false,
	): void {
		const overflowKey = JSON.stringify([sessionId, background]);
		if (
			queue.overflowNotices.has(overflowKey) ||
			queue.overflowNotices.size >= MAX_OVERFLOW_NOTICES
		)
			return;
		const notice = {
			sessionId,
			text:
				splitMessageWithFooter(
					OVERFLOW_NOTICE,
					this.eventFooter(sessionId),
				)[0] ?? OVERFLOW_NOTICE,
			...(background ? { background: true as const } : {}),
			overflow: true as const,
			overflowKey,
		};
		queue.overflowNotices.add(overflowKey);
		queue.messages.push(notice);
		queue.pendingCharacters += notice.text.length;
	}

	private scheduleDrain(chatId: number, queue: ChatQueue): void {
		if (queue.draining || queue.drainTimer) return;
		if (!queue.messages.length) {
			for (const resolve of queue.idleWaiters.splice(0)) resolve();
			return;
		}
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
				queue.overflowNotices.clear();
				finish();
			});
		}, OUTPUT_COALESCE_MS);
	}

	private async drain(chatId: number, queue: ChatQueue): Promise<void> {
		while (!this.stopping && !queue.failed && queue.messages.length) {
			const message = queue.messages.shift();
			if (!message) break;
			queue.pendingCharacters -= message.text.length;
			if (message.overflowKey)
				queue.overflowNotices.delete(message.overflowKey);
			const backgroundDelivery =
				message.background && this.selected.get(chatId) !== message.sessionId;
			if (
				!message.background &&
				this.selected.get(chatId) !== message.sessionId
			)
				continue;
			const sender = this.authorizedChatPrincipals.get(chatId);
			const token =
				backgroundDelivery && sender !== undefined
					? this.createSelectIntent(chatId, sender, message.sessionId)
					: undefined;
			const text =
				message.background && !backgroundDelivery
					? message.text.replace(/^Фоновая сессия · [^\n]+\n\n/, "")
					: message.text;
			const delivered = await this.sendWithDeadline(
				chatId,
				text,
				{
					...(message.output ? { parse_mode: "HTML" } : {}),
					...(backgroundDelivery && token
						? {
								reply_markup: keyboard([
									[
										inlineButton(
											"Переключиться на эту сессию",
											`action:select:${token}`,
										),
									],
								]),
							}
						: !message.output
							? sessionIdEntity(text, message.sessionId)
							: {}),
				},
				message.output ? message.sessionId : undefined,
				(messageId) => {
					if (token) this.bindSelectMessage(token, messageId);
				},
			);
			if (!delivered) {
				queue.failed = true;
				queue.messages.length = 0;
				queue.pendingCharacters = 0;
				queue.overflowNotices.clear();
			}
		}
	}

	private sendWithDeadline(
		chatId: number,
		text: string,
		other?: unknown,
		correlatedSessionId?: SessionId,
		onSent?: (messageId: number | undefined) => void,
	): Promise<boolean> {
		return this.telegramCall((signal) =>
			this.bot.api.sendMessage(chatId, text, other, signal),
		).then((result) => {
			if (!result.ok) {
				this.reportError("Telegram message delivery failed", result.error);
				return false;
			}
			const messageId = messageIdFrom(result.value);
			onSent?.(messageId);
			if (correlatedSessionId && messageId !== undefined)
				this.rememberReplyRoute(chatId, messageId, correlatedSessionId);
			return true;
		});
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
