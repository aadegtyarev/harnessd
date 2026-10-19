import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, realpath, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bot, InputFile } from "grammy";
import {
	getTelegramCommands,
	getTelegramHelpLines,
} from "./command-catalog.js";
import type { Capability } from "./core/errors.js";
import type {
	AgentFileSendRequest,
	AgentFileSendResult,
	AgentFileSendTransport,
	HarnessCommand,
	HarnessEffortCatalog,
	HarnessModelCatalog,
	HarnessModelChangeResult,
	HarnessModelInfo,
	HarnessOptionCatalog,
	HarnessOptionUpdate,
	HarnessRegistryEntry,
	HarnessSessionStatus,
	HarnessUsageStats,
	ToolPermissionDecision,
	ToolPermissionRequest,
	ToolPermissionTransport,
	TransportAdapter,
	TransportEvent,
	TransportEventSubscription,
	TransportResult,
} from "./core/ports.js";
import type {
	AdapterId,
	HarnessActivityEvent,
	HarnessAnomaly,
	HarnessEvent,
	InputDeliveryState,
	InputId,
	SessionFailureReason,
	SessionId,
	SessionSummary,
} from "./core/types.js";
import {
	describeError,
	redactDiagnosticText,
	truncateDiagnostic,
} from "./error-diagnostics.js";
import { OVERFLOW_ID } from "./telegram-activity-ledger.js";
import {
	approvedSubagentRole,
	localActivityTime,
	meaningfulToolSummary,
	updateActivityRow,
} from "./telegram-activity-projection.js";
import {
	type AgentSnapshot,
	type AgentVerdict,
	agentVerdicts,
	latestAgentSnapshot,
	MAX_AGENT_VERDICTS,
	renderAgentBoard,
	shortRunId,
} from "./telegram-agent-board.js";
import {
	AnomalyNoticeCoalescer,
	anomalyRoute,
	inputFailureText,
	stopNoticeText,
} from "./telegram-anomaly-notice.js";
import {
	extensionCommands,
	isNativeTelegramCommand,
	paginateTelegramHelp,
	telegramMenuCommands,
} from "./telegram-command-catalog.js";
import {
	listDirectories,
	listDirectoryEntries,
	MAX_LIST_ENTRIES,
	parsePathArgument,
	resolveExistingDirectory,
	resolvePathFrom,
	safeAttachmentName,
} from "./telegram-filesystem.js";
import { parseNewHarnessSelection } from "./telegram-harness-selection.js";
import {
	TelegramInbox,
	TelegramInboxError,
	TelegramInboxQuotaError,
	TelegramInboxWorkspaceError,
} from "./telegram-inbox.js";
import {
	isTelegramParseError,
	renderTelegramMarkdown,
	telegramHtmlToPlainText,
} from "./telegram-markdown.js";
import { TelegramPanelIntent } from "./telegram-panel-intent.js";
import { TelegramPanelRefreshScheduler } from "./telegram-panel-refresh.js";
import { TelegramPanelStore } from "./telegram-panel-store.js";
import {
	actionsLabel,
	addThoughtEvent,
	addToolEvent,
	finishToolEvent,
	formatDuration,
	type RunCardEvent,
	type RunCardTask,
	renderRunCard,
	runCardStateIcon,
} from "./telegram-run-card.js";
import { SubagentTextStream } from "./telegram-subagent-stream.js";

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
const PANEL_EDIT_RETRIES = 2;
const PANEL_RETRY_BASE_DELAY_MS = 500;
const PANEL_RETRY_MAX_DELAY_MS = 10_000;
const TURN_OVERFLOW_NOTICE =
	"[Additional output omitted because the response reached the queue limit.]";
const INPUT_CHARACTER_RESERVE = 4096;
const OUTPUT_COALESCE_MS = 40;
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_DOWNLOAD_BYTES = 20_000_000;
const INBOX_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const TYPING_REFRESH_MS = 4000;
const OVERFLOW_NOTICE =
	"Additional notifications were omitted because the queue is full.";
const RETIRED_PANEL_NOTE = "Панель перенесена ниже ↓";
const NAME_PROMPT_MARKER = "Назовите сессию (запрос имени harnessd):";
const NAME_PROMPT_ENVELOPE_PREFIX = `${NAME_PROMPT_MARKER}\n`;
const CREATE_NAME_INSTRUCTIONS =
	"Ответьте названием. Ниже есть кнопки «Создать без имени» и «Отмена».";
const RENAME_NAME_INSTRUCTIONS =
	"Ответьте новым названием; ниже есть кнопка «Отмена».";
const CREATE_NAME_PREFIX = "Новая сессия будет создана в ";
const CREATE_NAME_FALLBACK = "Точная папка указана в предыдущих сообщениях.";
const RENAME_NAME_FALLBACK = "в точной папке из предыдущих сообщений";
const RENAME_NAME_PREFIX = "Переименовать ";
const RENAME_NAME_SEPARATOR = " in ";
const NAME_PROMPT_COPY_VARIANTS = [
	{
		marker: NAME_PROMPT_MARKER,
		createInstructions: CREATE_NAME_INSTRUCTIONS,
		createPrefix: CREATE_NAME_PREFIX,
		createFallback: CREATE_NAME_FALLBACK,
		renameInstructions: RENAME_NAME_INSTRUCTIONS,
		renameFallback: RENAME_NAME_FALLBACK,
		renamePrefix: RENAME_NAME_PREFIX,
		renameSeparator: RENAME_NAME_SEPARATOR,
	},
	{
		marker: "Name this session (harnessd name prompt):",
		createInstructions:
			"Reply with a name. Create unnamed and Cancel buttons are below.",
		createPrefix: "New session will be created in ",
		createFallback: "The exact folder is shown in the preceding messages.",
		renameInstructions: "Reply with a name; use Cancel below.",
		renameFallback: "in the exact folder shown in the preceding messages",
		renamePrefix: "Rename ",
		renameSeparator: " in ",
	},
] as const;
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
		unpinChatMessage?(
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
			other?: {
				readonly scope?:
					| { readonly type: "all_private_chats" }
					| { readonly type: "chat"; readonly chat_id: number };
			},
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
	readonly silent?: true;
	readonly inputId?: string;
	inputState?: string;
	overflow?: true;
	overflowKey?: string;
};
type PendingNameFlow =
	| {
			readonly kind: "create";
			readonly cwd: string;
			readonly harnessId?: AdapterId;
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
type CreateHarnessIntent = {
	readonly chatId: number;
	readonly sender: number;
	readonly cwd: string;
	readonly harnessId: AdapterId;
	messageId?: number;
};
type ReplyRoute = { readonly sessionId: SessionId };
type WelcomeAction = "panel" | "sessions" | "new";
type WelcomeIntent = {
	readonly chatId: number;
	readonly sender: number;
	messageId?: number;
	readonly action: WelcomeAction;
};
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
	| {
			readonly kind: "create";
			readonly cwd: string;
			readonly harnessId?: AdapterId;
	  }
	| { readonly kind: "rename"; readonly sessionId: SessionId };
type ModelChoices = {
	readonly sessionId: SessionId;
	readonly models: readonly HarnessModelInfo[];
	readonly optionKey?: "model";
};
type EffortChoices = {
	readonly sessionId: SessionId;
	readonly levels: readonly string[];
	readonly optionKey?: "effort";
};
type PermissionIntent = {
	readonly requestId: string;
	readonly chatId: number;
	readonly sender: number;
	readonly sessionId: SessionId;
	readonly inputId: InputId;
	messageId?: number;
	readonly decision: ToolPermissionDecision;
};
type PendingPermission = {
	readonly request: ToolPermissionRequest;
	readonly resolve: (decision: ToolPermissionDecision) => void;
	readonly tokens: Set<string>;
	readonly abortListener: () => void;
	timer?: NodeJS.Timeout;
};
type DangerousOptionIntent = {
	readonly chatId: number;
	readonly sender: number;
	readonly sessionId: SessionId;
	readonly key: string;
	readonly value: string;
	readonly confirm: boolean;
	messageId?: number;
	timer?: NodeJS.Timeout;
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
	cancelled?: boolean;
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
type RestoreIntent = {
	readonly chatId: number;
	readonly sender: number;
	readonly sessionId: SessionId;
};
type ActivityTool = {
	readonly id: string;
	summary: string;
	status: "running" | "done" | "failed";
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
	readonly childStatuses: Map<string, string>;
	readonly notices: string[];
	status: string;
	subagentStatus?: string;
	visibleModel?: string;
	updatedAt?: string;
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
	/** Run card state. */
	startedAtMs?: number;
	readonly events: RunCardEvent[];
	thought?: string;
	task?: RunCardTask;
	readonly frozenMessageIds: number[];
	readonly cardToken: string;
	/** Tool calls in this run (the event list itself is capped). */
	actionCount: number;
	reportRequestedAtMs?: number;
	freezePending?: boolean;
	/** Whether the last published card carried live buttons. */
	lastButtons?: boolean;
};

export interface TelegramTransportOptions {
	readonly token: string;
	readonly allowedUserIds: readonly number[];
	readonly stateDirectory: string;
	readonly initialCwd: string;
	readonly signal?: AbortSignal;
	readonly onFatal?: () => void;
	readonly botFactory?: BotFactory;
	readonly activityClock?: () => Date;
	readonly activityTimeFormatter?: (date: Date) => string;
	readonly panelClock?: () => number;
	readonly panelSleep?: (milliseconds: number) => Promise<void>;
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
	const text = renderTelegramMarkdown(body);
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
		if (
			tagName &&
			["b", "i", "s", "a", "code", "pre", "blockquote"].includes(tagName)
		) {
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
/** Panel label: full name with an 8-character ID; the full ID stays in details and answer footers. */
function panelSessionLabel(
	session: Pick<SessionSummary, "id" | "name">,
): string {
	return `${session.name ? `${oneLine(session.name)} · ` : ""}#${session.id.slice(0, 8)}`;
}
const PANEL_SEPARATOR = "━━━━━━━━━━━━";
function sessionStatusLabel(status: SessionSummary["status"]): string {
	return status === "running"
		? "записана как работающая (после аварийного перезапуска может быть устаревшей)"
		: status === "stopped"
			? "остановлена"
			: status === "starting"
				? "запускается или восстанавливается"
				: "ошибка (статус может быть устаревшим)";
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
	const statusLabels: Readonly<Record<SessionSummary["status"], string>> = {
		running: "работает",
		stopped: "остановлена",
		starting: "запускается",
		uncertain: "неизвестен",
		failed: "ошибка/устаревший статус",
	};
	return `${selected ? "✓ " : ""}${escapeHtml(shortSessionLabel(session))} · ${escapeHtml(session.status)} (${statusLabels[session.status]}) · ${escapeHtml(compactSessionPath(session.cwd))}`;
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
const CANCEL_CONFIRMATION_TTL_MS = 120_000;
const RUN_REPORT_DEBOUNCE_MS = 60_000;
const RUN_REPORT_PROMPT =
	"Кратко (2–3 строки) доложи, что сейчас делаешь и что дальше, и продолжай работу.";
const CONTROL_BUTTONS = {
	status: "📊 Ход",
	panel: "📋 Панель",
	cancel: "✋ Прервать",
	sessions: "🗂 Сессии",
} as const;
/** Persistent reply keyboard under the input field; it never scrolls away. */
function controlKeyboard(): unknown {
	return {
		keyboard: [
			[{ text: CONTROL_BUTTONS.status }, { text: CONTROL_BUTTONS.panel }],
			[{ text: CONTROL_BUTTONS.cancel }, { text: CONTROL_BUTTONS.sessions }],
		],
		is_persistent: true,
		resize_keyboard: true,
	};
}
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
function hasGeneratedNamePromptBody(
	body: string,
	copy: (typeof NAME_PROMPT_COPY_VARIANTS)[number],
): boolean {
	const createSuffix = `. ${copy.createInstructions}`;
	if (
		body.startsWith(copy.createPrefix) &&
		body.endsWith(createSuffix) &&
		body.length > copy.createPrefix.length + createSuffix.length
	)
		return true;
	if (body.startsWith(`${copy.createFallback} `) && body.endsWith(createSuffix))
		return true;

	const renameSuffix = `. ${copy.renameInstructions}`;
	if (!body.startsWith(copy.renamePrefix) || !body.endsWith(renameSuffix))
		return false;
	const renameBody = body.slice(copy.renamePrefix.length, -renameSuffix.length);
	let boundary = renameBody.indexOf(copy.renameSeparator);
	while (boundary !== -1) {
		const identity = renameBody.slice(0, boundary);
		const cwd = renameBody.slice(boundary + copy.renameSeparator.length);
		if (cwd.length > 0 && hasRenamePromptIdentity(identity)) return true;
		boundary = renameBody.indexOf(copy.renameSeparator, boundary + 1);
	}
	const fallbackSuffix = ` ${copy.renameFallback}`;
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
function telegramErrorCode(error: unknown): number | undefined {
	if (error === null || typeof error !== "object") return undefined;
	if ("error_code" in error && typeof error.error_code === "number")
		return error.error_code;
	return undefined;
}
/** Rate limits, server errors, and failures without a Telegram verdict (deadline, network). */
function isTransientTelegramError(error: unknown): boolean {
	const code = telegramErrorCode(error);
	if (code !== undefined) return code === 429 || code >= 500;
	return apiErrorDescription(error) === undefined;
}
function telegramRetryAfterMs(error: unknown): number | undefined {
	if (error === null || typeof error !== "object" || !("parameters" in error))
		return undefined;
	const parameters = error.parameters as { retry_after?: unknown } | undefined;
	return typeof parameters?.retry_after === "number"
		? parameters.retry_after * 1000
		: undefined;
}
/** Edit rejections that mean the old panel message is gone or frozen, so a fresh panel replaces it. */
function isReplaceablePanelEditError(error: unknown): boolean {
	const description = apiErrorDescription(error)?.toLowerCase() ?? "";
	return (
		description.includes("message to edit not found") ||
		description.includes("message can't be edited") ||
		description.includes("message_id_invalid")
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
	const statusLabels: Readonly<Record<SessionSummary["status"], string>> = {
		running: "работает",
		stopped: "остановлена",
		starting: "запускается или восстанавливается",
		uncertain: "неизвестен",
		failed: "ошибка/устаревший статус",
	};
	const lines = [
		`Сессия: ${activitySessionLabel(session.id, session.name)}`,
		`Рабочая папка: ${oneLine(session.cwd)}`,
		`Статус: ${statusLabels[session.status]} (${session.status})`,
		...(failureCauseLine(session) ? [failureCauseLine(session) as string] : []),
		`Модель: ${live?.model ? modelId(live.model) : "недоступно"}`,
		`Усилие: ${live?.effort ? oneLine(live.effort) : "недоступно"}`,
	];
	const usage = live?.usage;
	lines.push(
		`Токены: ${usage?.totalTokens !== undefined ? formatCount(usage.totalTokens) : "недоступно"}`,
		`Расчётная стоимость: ${usage?.costUsd !== undefined ? `~$${usage.costUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}` : "недоступно"}`,
	);
	if (hasContextUsage(usage))
		lines.push(`Контекст: ${compactContextUsage(usage)}`);
	if (!live)
		lines.push("Данные Pi в реальном времени недоступны для этой сессии.");
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
	return `Pi мог принять ввод, но подтверждение не получено; автоматической повторной отправки не было${inputId ? `; InputId ${inputId}` : ""}`;
}
function safeResultError(error: {
	readonly code: string;
	readonly message: string;
	readonly inputId?: string;
}): string {
	if (error.code === "UNCERTAIN_INPUT_DELIVERY")
		return `Статус доставки ввода неизвестен (${uncertainDeliveryNotice(error.inputId)})${error.message ? `\n${error.message}` : ""}`;
	if (error.code === "INPUT_NOT_DELIVERED")
		return error.message === "Input canceled"
			? "Отменено пользователем"
			: (inputFailureText(error.message) ?? "Сообщение не доставлено");
	return error.message;
}
const NO_SESSION_SELECTED_MESSAGE =
	"Сессия не выбрана. Найдите её через /sessions и выберите командой /use <sessionId> или откройте /menu.";
const SELECTION_NOT_SAVED_WARNING =
	" Сейчас сессия выбрана, но сохранить выбор для следующего запуска не удалось.";

const FAILURE_REASON_TEXT: Readonly<Record<SessionFailureReason, string>> = {
	launch_failed: "процесс сессии не запустился",
	unexpected_exit:
		"процесс сессии неожиданно завершился, и автоматическое восстановление не удалось",
	resume_unavailable:
		"продолжить сессию нельзя: нет сохранённого ID сессии или поддержки возобновления",
	native_id_mismatch: "при восстановлении открылась другая сессия",
	options_replacement_failed:
		"не удалось перезапустить процесс сессии с новыми настройками",
};
function failureReasonText(reason: SessionFailureReason | undefined): string {
	return reason
		? `${FAILURE_REASON_TEXT[reason]} (${reason})`
		: "причина не сохранена";
}
/** `2026-10-19T12:34:56.000Z` → `2026-10-19 12:34 UTC`. */
function failureTimeText(failedAt: string | undefined): string | undefined {
	if (!failedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(failedAt))
		return undefined;
	return `${failedAt.slice(0, 10)} ${failedAt.slice(11, 16)} UTC`;
}
/** Last failure cause line for /status and the session card, while it is stored. */
function failureCauseLine(session: SessionSummary): string | undefined {
	if (!session.failureReason) return undefined;
	const time = failureTimeText(session.failedAt);
	return `Последняя ошибка: ${failureReasonText(session.failureReason)}${time ? `, ${time}` : ""}`;
}
/** Restore resumes the same native session; without one it cannot help. */
function isRestorable(session: SessionSummary | undefined): boolean {
	return session?.failureReason !== "resume_unavailable";
}
const NOT_RESTORABLE_HINT =
	"Восстановить эту сессию нельзя. Создайте новую сессию в той же папке командой /new.";
function failureNoticeText(session: SessionSummary | undefined): string {
	const cause = `Сессия остановилась с ошибкой: ${failureReasonText(session?.failureReason)}.`;
	if (isRestorable(session))
		return `${cause} Нажмите «Восстановить», чтобы продолжить ту же сессию.`;
	return `${cause} ${NOT_RESTORABLE_HINT}${session ? `\nПапка: ${panelPath(session.cwd)}` : ""}`;
}
const RESTORE_ERROR_TEXT: Readonly<Record<string, string>> = {
	SESSION_NOT_RESUMABLE:
		"сессию нельзя продолжить: она не остановлена или у неё нет сохранённого ID сессии",
	UNSUPPORTED_CAPABILITY: "харнесс этой сессии не поддерживает возобновление",
	SESSION_NOT_FOUND: "сессия не найдена",
	SESSION_STORE_ERROR: "не удалось сохранить состояние сессии",
	HARNESS_OPTIONS_BUSY: "у сессии сейчас меняются настройки, попробуйте позже",
	RUNTIME_CLOSING: "harnessd останавливается",
	PI_EXECUTABLE_NOT_FOUND: "исполняемый файл харнесса не найден",
	PI_EXECUTABLE_NOT_ACCESSIBLE: "исполняемый файл харнесса нельзя запустить",
	PI_RPC_STARTUP_TIMEOUT: "процесс сессии не ответил вовремя при запуске",
	PI_EXITED_BEFORE_READY: "процесс сессии завершился до готовности",
	PI_STARTUP_FAILED: "процесс сессии не запустился",
};
/** Russian restore failure text from a safe error code; never core's English message. */
function restoreErrorText(error: {
	readonly code: string;
	readonly message: string;
}): string {
	const known = RESTORE_ERROR_TEXT[error.code];
	const reference = /\(ref ([A-Za-z0-9-]{1,32})\)/.exec(error.message)?.[1];
	return `${known ?? "операция не удалась"} (${error.code}${reference ? `, ref ${reference}` : ""}). Подробности — в журнале harnessd.`;
}

function statusMessage(value: string | undefined): string {
	switch (value) {
		case "harness_restarting":
			return "Супервизор перезапускается.";
		case "harness_recovered":
			return "Супервизор восстановлен.";
		case "harness_recovery_failed":
			return "Не удалось восстановить супервизор.";
		default:
			return "Статус сессии изменился.";
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
	implements TransportAdapter, AgentFileSendTransport, ToolPermissionTransport
{
	readonly descriptor = {
		id: "telegram" as AdapterId,
		capabilities: ["transport.poll"] as const,
	};
	private getSessionCapabilities?: (
		sessionId: SessionId,
	) => Promise<readonly Capability[]>;
	private listHarnesses?: () => readonly HarnessRegistryEntry[];
	private readonly selected = new Map<number, SessionId>();
	private readonly selectionCurrency = new Map<number, number>();
	private readonly commandMenuGenerations = new Map<number, number>();
	private readonly commandMenuRequests = new Map<
		number,
		{
			readonly generation: number;
			readonly liveSessionId?: SessionId;
			readonly selectedSessionId?: SessionId;
			readonly sender: number;
		}
	>();
	private readonly commandMenuTasks = new Map<number, Promise<void>>();
	private readonly commandMenuAborts = new Map<number, AbortController>();
	private readonly uncertainCommandMenus = new Set<number>();
	private readonly sessionMenuCurrencies = new Map<SessionId, number>();
	private readonly sessionNames = new Map<SessionId, string>();
	private readonly knownSessions = new Set<SessionId>();
	private readonly reportedErrors = new Map<SessionId, Set<string>>();
	/** A stop anomaly waiting to be folded into the session's fatal error message. */
	private readonly stopAnomalies = new Map<SessionId, HarnessAnomaly>();
	/** Coalesced plain-Russian notices for tolerated harness anomalies. */
	private readonly anomalyNotices = new AnomalyNoticeCoalescer(
		(sessionId, text) =>
			this.enqueueForSelected(
				sessionId,
				redactDiagnosticText(text, [this.options.token]),
			),
	);
	private readonly liveActivities = new Map<string, LiveActivity>();
	private readonly runningSessions = new Set<SessionId>();
	private readonly reloadingSessions = new Map<SessionId, symbol>();
	private readonly recoveringSessions = new Set<SessionId>();
	private readonly previews = new Map<number, SessionId>();
	private readonly pendingNames = new Map<number, PendingNameFlow>();
	private readonly staleNamePrompts = new Map<number, Set<number>>();
	private readonly namePromptVersions = new Map<number, number>();
	private readonly replyRoutes = new Map<number, Map<number, ReplyRoute>>();
	private readonly replyChoices = new Map<string, ReplyChoice>();
	private readonly modelChoices = new Map<number, ModelChoices>();
	private readonly effortChoices = new Map<number, EffortChoices>();
	private readonly permissionRequests = new Map<string, PendingPermission>();
	private readonly permissionIntents = new Map<string, PermissionIntent>();
	private readonly dangerousOptionIntents = new Map<
		string,
		DangerousOptionIntent
	>();
	private readonly turnBuffers = new Map<SessionId, TurnBuffer>();
	private readonly inputAttributions = new Map<InputId, InputAttribution>();
	private readonly cancelingInputs = new Map<InputId, number>();
	private readonly cancelingCurrentRunInputs = new Map<InputId, number>();
	private readonly inFlightSubmissions = new Map<
		SessionId,
		InFlightSubmission
	>();
	private readonly currentDirectories = new Map<number, string>();
	private readonly panelMessageIds = new Map<number, number>();
	/** Panels whose staleness is shown to the operator (notice posted, or restored after restart). */
	private readonly panelStaleChats = new Set<number>();
	/** Panels that must be repainted after an uncertain Telegram failure, without user-visible text. */
	private readonly panelRepairChats = new Set<number>();
	/** Latest pi-subagents snapshot and reviewer verdicts per session. */
	private readonly agentSnapshots = new Map<
		SessionId,
		{ readonly widgetKey?: string; readonly snapshot: AgentSnapshot }
	>();
	private readonly agentVerdicts = new Map<SessionId, AgentVerdict[]>();
	/** Run cards by their button token. */
	private readonly cardTokens = new Map<string, LiveActivity>();
	/** Chats that received the persistent control keyboard in this process. */
	private readonly keyboardChats = new Set<number>();
	private readonly cancelIntents = new Map<
		string,
		{
			chatId: number;
			sender: number;
			sessionId: SessionId;
			createdAt: number;
			messageId?: number;
		}
	>();
	/** Message IDs of panels replaced in this process; their buttons must not re-adopt them. */
	private readonly retiredPanelIds = new Map<number, Set<number>>();
	private readonly panelGenerations = new Map<number, number>();
	private readonly panelIntents = new TelegramPanelIntent();
	private readonly panelSemantic = new Map<number, string>();
	private readonly panelUpdatedAt = new Map<number, string>();
	private readonly panelPublished = new Map<number, string>();
	private readonly panelPublicationTimes = new Map<number, number>();
	private readonly panelUpdateQueues = new Map<number, Promise<unknown>>();
	/** In-flight bottom publishes per chat: the newest request and the panel it replaces. */
	private readonly bottomPanelPublishes = new Map<
		number,
		{ latest: number; detached: number | undefined }
	>();
	private bottomPanelRequestCounter = 0;
	private readonly panelRefreshScheduler = new TelegramPanelRefreshScheduler(
		Date.now,
		500,
		2000,
		(error) => this.reportError("Telegram panel refresh failed", error),
	);
	private readonly welcomeIntents = new Map<string, WelcomeIntent>();
	private readonly createHarnessIntents = new Map<
		string,
		CreateHarnessIntent
	>();
	private readonly folderIntents = new Map<string, FolderIntent>();
	private readonly confirmationIntents = new Map<string, ConfirmationIntent>();
	private readonly resumeSelectIntents = new Map<string, ResumeSelectIntent>();
	private readonly selectIntents = new Map<string, SelectIntent>();
	private readonly restoreIntents = new Map<string, RestoreIntent>();
	/** Sessions whose current failure was already announced; cleared by a new recovery. */
	private readonly announcedFailures = new Set<SessionId>();
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
		getSessionCapabilities?: (
			sessionId: SessionId,
		) => Promise<readonly Capability[]>,
		listHarnesses?: () => readonly HarnessRegistryEntry[],
	): Promise<void> {
		this.dispatch = dispatch;
		this.listSessions = listSessions;
		this.getSessionCapabilities = getSessionCapabilities;
		this.listHarnesses = listHarnesses;
		this.releaseLock = await acquireTelegramPollingLock(
			this.options.token,
			this.options.stateDirectory,
		);
		try {
			this.panelStore = await TelegramPanelStore.open(
				this.options.stateDirectory,
				this.options.token,
			);
			for (const [chatId, messageId] of this.panelStore.panels()) {
				this.panelMessageIds.set(chatId, messageId);
				this.panelStaleChats.add(chatId);
			}
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
							getTelegramCommands(false),
							{ scope: { type: "all_private_chats" } },
							this.initializationAbort.signal,
						),
						SEND_TIMEOUT_MS,
					);
				} catch (error) {
					this.reportError("Telegram command menu registration failed", error);
				}
				for (const chatId of this.selected.keys())
					await this.refreshCommandMenu(chatId, this.selected.get(chatId));
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
				for (const [chatId, messageId] of this.panelMessageIds) {
					const sender = this.options.allowedUserIds[0];
					if (sender === undefined) continue;
					const intent = this.panelIntents.current(chatId);
					await this.publishRestoredPanelStale(chatId, messageId);
					this.panelRefreshScheduler.schedule(chatId, () =>
						this.panelIntents.isCurrent(chatId, intent)
							? this.refreshExistingPanel(chatId, sender)
							: Promise.resolve(),
					);
				}
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
		for (const requestId of this.permissionRequests.keys())
			this.finishPermissionRequest(requestId, {
				behavior: "deny",
				message: "Transport stopped",
				interrupt: false,
			});
		for (const [token, intent] of this.dangerousOptionIntents) {
			if (intent.timer) clearTimeout(intent.timer);
			this.dangerousOptionIntents.delete(token);
		}
		for (const controller of this.commandMenuAborts.values())
			controller.abort();
		this.commandMenuAborts.clear();
		for (const chatId of this.selected.keys())
			this.commandMenuGenerations.set(
				chatId,
				(this.commandMenuGenerations.get(chatId) ?? 0) + 1,
			);
		for (const [chatId, sessionId] of this.selected) {
			this.selectionCurrency.set(
				chatId,
				(this.selectionCurrency.get(chatId) ?? 0) + 1,
			);
			this.sessionMenuCurrencies.set(
				sessionId,
				(this.sessionMenuCurrencies.get(sessionId) ?? 0) + 1,
			);
		}
		for (const chatId of this.commandMenuGenerations.keys())
			this.commandMenuGenerations.set(
				chatId,
				(this.commandMenuGenerations.get(chatId) ?? 0) + 1,
			);
		await withDeadline(
			Promise.all([...this.commandMenuTasks.values()]).then(() => undefined),
			STOP_TIMEOUT_MS,
		).catch(() => {});
		for (const chatId of this.panelMessageIds.keys())
			this.panelIntents.begin(chatId);
		try {
			await withDeadline(this.panelRefreshScheduler.stop(), STOP_TIMEOUT_MS);
		} catch {
			// Late refreshes are invalidated and cannot publish after shutdown.
		}
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
		this.anomalyNotices.stop();
		this.stopAnomalies.clear();
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
		this.cancelingCurrentRunInputs.clear();
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

	private async publishRestoredPanelStale(
		chatId: number,
		messageId: number,
	): Promise<void> {
		await this.updatePanel(
			chatId,
			"📌 Панель сессий\nСтатус: проверяется после перезапуска harnessd…",
			{},
			messageId,
		);
	}

	private async restoreSelectedSessions(): Promise<void> {
		const store = this.panelStore;
		if (!store) return;
		for (const [chatId, sessionId] of store.selections()) {
			this.selected.set(chatId, sessionId as SessionId);
			this.selectionCurrency.set(
				chatId,
				(this.selectionCurrency.get(chatId) ?? 0) + 1,
			);
		}
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
		this.selectionCurrency.set(
			chatId,
			(this.selectionCurrency.get(chatId) ?? 0) + 1,
		);
		void this.refreshCommandMenu(chatId, sessionId);
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
		this.selectionCurrency.set(
			chatId,
			(this.selectionCurrency.get(chatId) ?? 0) + 1,
		);
		void this.refreshCommandMenu(chatId, undefined);
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

	private async discoverExtensionCommands(
		sender: number,
		sessionId: SessionId,
	): Promise<readonly HarnessCommand[] | undefined> {
		try {
			const result = await this.request(sender, {
				kind: "command_list",
				sessionId,
			});
			if (!result.ok || !Array.isArray(result.value)) return undefined;
			return extensionCommands(result.value as HarnessCommand[]);
		} catch (error) {
			this.reportError("Telegram extension command discovery failed", error);
			return undefined;
		}
	}

	private refreshMenusForSession(sessionId: SessionId, live: boolean): void {
		this.sessionMenuCurrencies.set(
			sessionId,
			(this.sessionMenuCurrencies.get(sessionId) ?? 0) + 1,
		);
		for (const [chatId, selectedId] of this.selected)
			if (selectedId === sessionId)
				void this.refreshCommandMenu(
					chatId,
					live ? sessionId : undefined,
					chatId,
					selectedId,
				);
	}

	private refreshCommandMenu(
		chatId: number,
		liveSessionId: SessionId | undefined,
		sender = chatId,
		selectedSessionId = liveSessionId,
	): Promise<void> {
		const generation = (this.commandMenuGenerations.get(chatId) ?? 0) + 1;
		this.commandMenuGenerations.set(chatId, generation);
		this.commandMenuRequests.set(chatId, {
			generation,
			liveSessionId,
			selectedSessionId,
			sender,
		});
		const existing = this.commandMenuTasks.get(chatId);
		if (existing) return existing;
		const task = (async () => {
			let completed = 0;
			while (!this.stopping && !this.uncertainCommandMenus.has(chatId)) {
				const request = this.commandMenuRequests.get(chatId);
				if (!request || request.generation === completed) return;
				const extensions = request.liveSessionId
					? ((await this.discoverExtensionCommands(
							request.sender,
							request.liveSessionId,
						)) ?? [])
					: [];
				let includeCancel = false;
				let includeReload = request.selectedSessionId === undefined;
				if (request.selectedSessionId && this.getSessionCapabilities) {
					try {
						const capabilities = await this.getSessionCapabilities(
							request.selectedSessionId,
						);
						includeCancel = capabilities.includes("harness.cancel");
						includeReload = capabilities.includes("harness.reload");
					} catch {
						includeCancel = false;
						includeReload = false;
					}
				}
				if (this.stopping) return;
				if (
					this.commandMenuRequests.get(chatId)?.generation !==
						request.generation ||
					(request.selectedSessionId !== undefined &&
						this.selected.get(chatId) !== request.selectedSessionId)
				)
					continue;
				const controller = new AbortController();
				this.commandMenuAborts.set(chatId, controller);
				let publication: Promise<unknown>;
				try {
					publication = Promise.resolve(
						this.bot.api.setMyCommands(
							telegramMenuCommands(extensions, includeCancel, includeReload),
							{ scope: { type: "chat", chat_id: chatId } },
							controller.signal,
						),
					);
				} catch (error) {
					publication = Promise.reject(error);
				}
				void publication.catch(() => {});
				try {
					await withDeadline(publication, SEND_TIMEOUT_MS);
				} catch (error) {
					this.reportError(
						"Telegram chat command menu registration failed",
						error,
					);
					if (
						!this.stopping &&
						error instanceof Error &&
						error.message === "deadline"
					) {
						this.uncertainCommandMenus.add(chatId);
						void publication.then(
							() => {
								this.uncertainCommandMenus.delete(chatId);
								if (this.commandMenuAborts.get(chatId) === controller)
									this.commandMenuAborts.delete(chatId);
								if (!this.stopping) {
									const latest = this.commandMenuRequests.get(chatId);
									if (latest)
										void this.refreshCommandMenu(
											chatId,
											latest.liveSessionId,
											latest.sender,
											latest.selectedSessionId,
										);
								}
							},
							() => {
								this.uncertainCommandMenus.delete(chatId);
								if (this.commandMenuAborts.get(chatId) === controller)
									this.commandMenuAborts.delete(chatId);
								if (!this.stopping) {
									const latest = this.commandMenuRequests.get(chatId);
									if (latest)
										void this.refreshCommandMenu(
											chatId,
											latest.liveSessionId,
											latest.sender,
											latest.selectedSessionId,
										);
								}
							},
						);
					}
				}
				if (
					!this.uncertainCommandMenus.has(chatId) &&
					this.commandMenuAborts.get(chatId) === controller
				)
					this.commandMenuAborts.delete(chatId);
				if (this.stopping) return;
				if (this.uncertainCommandMenus.has(chatId)) return;
				completed = request.generation;
			}
		})();
		this.commandMenuTasks.set(chatId, task);
		void task.finally(() => {
			if (this.commandMenuTasks.get(chatId) === task)
				this.commandMenuTasks.delete(chatId);
		});
		return task;
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
			// Keyboard labels are commands even when Telegram sends the tap as a reply
			// (including to a name prompt), so a label never becomes a name or a prompt.
			const control = Object.values(CONTROL_BUTTONS).find(
				(button) => button === text.trim(),
			);
			if (control) {
				if (routedSessionId === undefined)
					await this.handleControlButton(
						chatId,
						sender,
						control,
						ctx.message?.message_id,
					);
				return;
			}
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
					"Запрос имени устарел. Начните действие заново.",
				);
			if (text.startsWith("/")) {
				await this.command(chatId, sender, text, ctx.message?.message_id);
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

	requestToolPermission(
		request: ToolPermissionRequest,
	): Promise<ToolPermissionDecision> {
		const deny = (message: string): ToolPermissionDecision => ({
			behavior: "deny",
			message,
			interrupt: false,
		});
		if (
			this.stopping ||
			request.signal.aborted ||
			this.permissionRequests.has(request.requestId) ||
			this.permissionRequests.size >= 128
		)
			return Promise.resolve(deny("Permission request unavailable"));
		const recipients = [...this.selected].flatMap(([chatId, sessionId]) =>
			sessionId === request.sessionId &&
			this.authorized.has(this.authorizedChatPrincipals.get(chatId) ?? -1)
				? [
						{
							chatId,
							sender: this.authorizedChatPrincipals.get(chatId) as number,
						},
					]
				: [],
		);
		if (!recipients.length)
			return Promise.resolve(deny("No authorized chat selected this session"));
		return new Promise((resolve) => {
			const pending: PendingPermission = {
				request,
				resolve,
				tokens: new Set(),
				abortListener: () =>
					this.finishPermissionRequest(
						request.requestId,
						deny("Permission prompt expired"),
					),
			};
			pending.timer = setTimeout(pending.abortListener, 55_000);
			this.permissionRequests.set(request.requestId, pending);
			request.signal.addEventListener("abort", pending.abortListener, {
				once: true,
			});
			for (const recipient of recipients)
				void this.sendPermissionPrompt(
					pending,
					recipient.chatId,
					recipient.sender,
				);
		});
	}

	private async sendPermissionPrompt(
		pending: PendingPermission,
		chatId: number,
		sender: number,
	): Promise<void> {
		const request = pending.request;
		const token = this.makeIntentToken();
		const allow: ToolPermissionDecision = { behavior: "allow" };
		const deny: ToolPermissionDecision = {
			behavior: "deny",
			message: "Permission denied by user",
			interrupt: false,
		};
		const intentBase = {
			requestId: request.requestId,
			chatId,
			sender,
			sessionId: request.sessionId,
			inputId: request.inputId,
		};
		const allowIntent: PermissionIntent = { ...intentBase, decision: allow };
		const denyToken = this.makeIntentToken();
		const denyIntent: PermissionIntent = { ...intentBase, decision: deny };
		pending.tokens.add(token);
		pending.tokens.add(denyToken);
		this.permissionIntents.set(token, allowIntent);
		this.permissionIntents.set(denyToken, denyIntent);
		const context = request.context;
		const detail =
			context.description ??
			context.title ??
			context.displayName ??
			"Claude запросил разрешение на действие";
		const input = JSON.stringify(request.input, null, 2).slice(0, 1400);
		const text = `Запрос разрешения · ${escapeHtml(request.toolName)}\n${escapeHtml(detail.slice(0, 500))}\n<pre>${escapeHtml(input)}</pre>`;
		const sent = await this.sendWithDeadline(
			chatId,
			text,
			{
				parse_mode: "HTML",
				reply_markup: keyboard([
					[
						inlineButton("Разрешить один раз", `permission:${token}`),
						inlineButton("Запретить", `permission:${denyToken}`),
					],
				]),
			},
			request.sessionId,
			(messageId) => {
				allowIntent.messageId = messageId;
				denyIntent.messageId = messageId;
			},
		);
		if (!sent) {
			this.permissionIntents.delete(token);
			this.permissionIntents.delete(denyToken);
			pending.tokens.delete(token);
			pending.tokens.delete(denyToken);
			if (!pending.tokens.size)
				this.finishPermissionRequest(request.requestId, {
					behavior: "deny",
					message: "Permission prompt could not be delivered",
					interrupt: false,
				});
		}
	}

	private dispatchPermissionDecision(
		chatId: number,
		sender: number,
		token: string,
		messageId: number,
	): void {
		const intent = this.permissionIntents.get(token);
		if (
			!intent ||
			intent.chatId !== chatId ||
			intent.sender !== sender ||
			intent.messageId !== messageId
		)
			return;
		const pending = this.permissionRequests.get(intent.requestId);
		if (
			!pending ||
			pending.request.sessionId !== intent.sessionId ||
			pending.request.inputId !== intent.inputId
		)
			return;
		if (
			this.selected.get(chatId) !== intent.sessionId ||
			pending.request.signal.aborted
		) {
			this.finishPermissionRequest(intent.requestId, {
				behavior: "deny",
				message: "Permission request became stale",
				interrupt: false,
			});
			return;
		}
		this.finishPermissionRequest(intent.requestId, intent.decision);
	}

	private finishPermissionRequest(
		requestId: string,
		decision: ToolPermissionDecision,
	): void {
		const pending = this.permissionRequests.get(requestId);
		if (!pending) return;
		this.permissionRequests.delete(requestId);
		if (pending.timer) clearTimeout(pending.timer);
		pending.request.signal.removeEventListener("abort", pending.abortListener);
		for (const token of pending.tokens) this.permissionIntents.delete(token);
		pending.resolve(decision);
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
				(await this.sendFileToChat(
					request.sessionId,
					request.path,
					chatId,
					request.caption,
				)) === "sent"
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
	): Promise<
		| "sent"
		| "missing"
		| "inaccessible"
		| "outside"
		| "nonregular"
		| "size"
		| "session"
		| "telegram"
	> {
		const cwd = this.sessionCwds.get(sessionId);
		if (!cwd) return "inaccessible";
		if (
			!Number.isSafeInteger(chatId) ||
			!this.authorized.has(this.authorizedChatPrincipals.get(chatId) ?? -1) ||
			this.selected.get(chatId) !== sessionId
		)
			return "session";
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
				return "outside";
			const data = await readBoundedFile(canonicalRoot, canonicalFile);
			if (this.stopping || this.selected.get(chatId) !== sessionId)
				return "session";
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
				return "telegram";
			}
			return "sent";
		} catch (error) {
			this.reportError("Telegram agent file preparation failed", error, [
				filePath,
				caption,
			]);
			if (error instanceof TelegramAttachmentTooLargeError) return "size";
			if (error instanceof Error && error.message === "not a regular file")
				return "nonregular";
			if (
				error instanceof Error &&
				error.message === "file is outside session cwd"
			)
				return "outside";
			if (isCode(error, "ENOENT")) return "missing";
			return "inaccessible";
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
		if (text === undefined) return false;
		return NAME_PROMPT_COPY_VARIANTS.some((copy) => {
			const envelopePrefix = `${copy.marker}\n`;
			return (
				text.startsWith(envelopePrefix) &&
				hasGeneratedNamePromptBody(text.slice(envelopePrefix.length), copy)
			);
		});
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
					? `Источник ответа неизвестен. Отправить только в выбранную сессию ${this.sessionFooter(selectedSession)} или отменить:`
					: `Это сообщение относится к ${this.sessionFooter(sourceSession)}, но выбрана ${this.sessionFooter(selectedSession)}. Выберите, куда отправить его:`,
				{
					reply_markup: keyboard([
						[
							...(sourceSession === selectedSession
								? [inlineButton("В выбранную сессию", `reply:${token}:c`)]
								: [
										inlineButton("В исходную сессию", `reply:${token}:s`),
										inlineButton("В выбранную сессию", `reply:${token}:c`),
									]),
							inlineButton("Отмена", `reply:${token}:x`),
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
				"Выбор имени устарел. Начните действие заново.",
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
				"Выбор маршрута устарел. При необходимости отправьте сообщение ещё раз.",
			);
			return;
		}
		this.replyChoices.delete(match?.[1] as string);
		if (match?.[2] === "x")
			return this.sendDirect(chatId, "Ответ отменён; ничего не отправлено.");
		if (
			match?.[2] === "c" &&
			this.selected.get(chatId) !== choice.selectedSession
		)
			return this.sendDirect(
				chatId,
				"Выбранная сессия изменилась до подтверждения. Ничего не отправлено; ответьте ещё раз, чтобы выбрать текущего адресата.",
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
				"Этот тип вложения не поддерживается. Отправьте документ Telegram или фотографию.",
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
				"Запрос имени устарел или требует текстового ответа; вложение не отправлено.",
			);
		const sessionId =
			routedSessionId ??
			knownReplyRoute?.sessionId ??
			footerSession ??
			this.selected.get(chatId);
		if (!sessionId)
			return this.sendDirect(
				chatId,
				"Нет выбранной сессии. Выберите сессию через /sessions и /use <sessionId> или откройте /menu.",
			);
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
			return this.sendDirect(chatId, "Этот тип вложения не поддерживается.");
		const fileId = document?.file_id ?? photo?.file_id;
		if (!fileId)
			return this.sendDirect(chatId, "Не удалось определить вложение.");
		const declaredSize = document?.file_size ?? photo?.file_size;
		if (
			declaredSize !== undefined &&
			declaredSize > MAX_TELEGRAM_DOWNLOAD_BYTES
		)
			return this.sendDirect(
				chatId,
				"Вложение превышает лимит загрузки Telegram 20 MB.",
			);
		const inbox = this.inbox;
		if (!inbox)
			return this.sendDirect(chatId, "Хранилище вложений сессии недоступно.");
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
					"Вложение превышает лимит загрузки Telegram 20 MB.",
				);
			return this.sendDirect(
				chatId,
				error instanceof Error &&
					(error.message.includes("timed out") || error.message === "deadline")
					? "Загрузка вложения превысила 60 секунд; оно не отправлено. Автоматической повторной загрузки нет."
					: "Не удалось загрузить вложение из Telegram; оно не отправлено. Автоматической повторной загрузки нет.",
			);
		}
		await inbox.withSessionLock(sessionId, async () => {
			if (
				(!explicitlyRouted || confirmedCurrentSession !== undefined) &&
				this.selected.get(chatId) !== selectedAtDownload
			) {
				await this.sendDirect(
					chatId,
					"Выбранная сессия изменилась во время получения вложения; оно не отправлено.",
				);
				return;
			}
			const inspected = await this.request(sender, {
				kind: "inspect",
				sessionId,
			});
			if (!inspected.ok) {
				await this.sendDirect(
					chatId,
					inspected.error.code === "SESSION_NOT_FOUND"
						? "Сессия недоступна; вложение не отправлено. Выберите другую сессию через /sessions и /use <sessionId> или откройте /menu."
						: inspected.error.message,
				);
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
					"Выбранная сессия изменилась во время получения вложения; оно не отправлено.",
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
						"Выбранная сессия изменилась во время получения вложения; оно не отправлено.",
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
						"Выбранная сессия изменилась во время получения вложения; оно не отправлено.",
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
					`Вложение сохранено и отправлено: ${saved.path}`,
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
						"Вложение превышает лимит загрузки Telegram 20 MB.",
					);
				if (error instanceof TelegramInboxQuotaError)
					return this.sendDirect(
						chatId,
						"Достигнут лимит хранилища сессии: 10 файлов или 100 MiB. Удалите ненужные файлы; очистка пропускает работающие сессии.",
					);
				if (error instanceof TelegramInboxWorkspaceError)
					return this.sendDirect(
						chatId,
						"Папка вложений находится внутри рабочей папки сессии; вложение не сохранено. Выберите сессию с другой рабочей папкой.",
					);
				if (error instanceof TelegramInboxError)
					return this.sendDirect(
						chatId,
						"Не удалось записать вложение в хранилище сессии; оно не отправлено. Проверьте свободное место и доступ к хранилищу.",
					);
				return this.sendDirect(
					chatId,
					"Не удалось обработать вложение; оно не отправлено. Автоматической повторной отправки нет.",
				);
			}
		});
	}

	private async command(
		chatId: number,
		sender: number,
		raw: string,
		messageId?: number,
	): Promise<void> {
		this.invalidatePanelIntent(chatId);
		raw = raw.replace(/^\/(\S+)/, (token) => token.toLowerCase());
		if (/^\/start(?:@[^\s]+)?$/.test(raw)) {
			// The persistent keyboard goes first so the welcome stays the latest message.
			this.keyboardChats.delete(chatId);
			await this.ensureControlKeyboard(chatId);
			const actions: readonly WelcomeAction[] = ["panel", "sessions", "new"];
			const tokens = actions.map((action) => {
				const token = this.makeIntentToken();
				this.welcomeIntents.set(token, { chatId, sender, action });
				return token;
			});
			while (this.welcomeIntents.size > 128)
				this.welcomeIntents.delete(
					this.welcomeIntents.keys().next().value as string,
				);
			const sent = await this.sendWithDeadline(
				chatId,
				"Добро пожаловать! Откройте панель, выберите или создайте сессию. Обычные сообщения и вложения отправляются в выбранную сессию; файл из рабочей папки сессии можно отправить командой /send <путь>.",
				{
					reply_markup: keyboard([
						[inlineButton("Открыть панель", `welcome:${tokens[0]}`)],
						[
							inlineButton("Сессии", `welcome:${tokens[1]}`),
							inlineButton("Новая сессия", `welcome:${tokens[2]}`),
						],
					]),
				},
				undefined,
				(messageId) => {
					if (messageId === undefined) return;
					for (const token of tokens) {
						const intent = this.welcomeIntents.get(token);
						if (intent) intent.messageId = messageId;
					}
				},
			);
			if (
				!sent ||
				!tokens.every((token) => this.welcomeIntents.get(token)?.messageId)
			)
				for (const token of tokens) this.welcomeIntents.delete(token);
			return;
		}
		if (/^\/menu(?:@[^\s]+)?$/.test(raw)) {
			// Like the 📋 button: the command is noise and the panel goes to the bottom.
			if (messageId !== undefined)
				void this.telegramCall((signal) =>
					this.bot.api.deleteMessage(chatId, messageId, signal),
				);
			return this.showPanelAtBottom(chatId, sender);
		}
		const renameCommand = /^\/rename(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(raw);
		if (renameCommand)
			return this.renameCommand(chatId, sender, renameCommand[1] ?? "");
		const newCommand = /^\/new(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(raw);
		if (newCommand) {
			const selection = parseNewHarnessSelection(
				newCommand[1],
				this.listHarnesses?.() ?? [],
			);
			if (!selection.ok)
				return this.sendDirect(
					chatId,
					selection.reason === "unknown_harness"
						? "Неизвестный harness. Укажите зарегистрированный alias после @; сессия не создана."
						: "Возьмите весь путь в парные кавычки или уберите кавычки.",
				);
			const currentDirectory =
				this.currentDirectories.get(chatId) ?? this.options.initialCwd;
			const cwd = selection.cwdArgument
				? resolvePathFrom(selection.cwdArgument, currentDirectory)
				: currentDirectory;
			const result = await this.request(sender, {
				kind: "create",
				cwd,
				...(selection.harnessId ? { harnessId: selection.harnessId } : {}),
			});
			if (!result.ok) return this.sendDirect(chatId, result.error.message);
			const session = result.value as SessionSummary;
			this.rememberSession(session);
			this.refreshPanelsPreviewing(session.id, sender, true);
			const selectionSaved = await this.setSelected(chatId, session.id);
			this.previews.delete(chatId);
			await this.refreshExistingPanel(chatId, sender);
			return this.sendDirect(
				chatId,
				`Сессия ${sessionLabel(session)} создана и выбрана.${selectionSaved ? "" : SELECTION_NOT_SAVED_WARNING}`,
			);
		}
		const sendCommand = /^\/send(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(raw);
		if (sendCommand) {
			const parsedPath = parsePathArgument(sendCommand[1]);
			if (!parsedPath.ok || !parsedPath.path)
				return this.sendDirect(chatId, "Использование: /send <path>");
			const sessionId = this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const sent = await this.sendFileToChat(
				sessionId,
				parsedPath.path,
				chatId,
			);
			const messages = {
				sent: "Файл отправлен.",
				missing: "Файл не найден в рабочей папке выбранной сессии.",
				inaccessible:
					"Файл недоступен для чтения. Проверьте права доступа к файлу в рабочей папке.",
				outside:
					"Файл должен находиться внутри рабочей папки выбранной сессии.",
				nonregular:
					"Можно отправить только обычный файл, не папку или ссылку на другой объект.",
				size: "Файл превышает лимит Telegram 20 MiB.",
				session: "Выбранная сессия изменилась; файл не отправлен.",
				telegram:
					"Telegram не доставил файл. Автоматической повторной отправки не будет.",
			};
			return this.sendDirect(chatId, messages[sent]);
		}
		const pathCommand = /^\/(ls|cd)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(raw);
		if (pathCommand) {
			const parsedPath = parsePathArgument(pathCommand[2]);
			if (!parsedPath.ok)
				return this.sendDirect(
					chatId,
					"Возьмите весь путь в парные кавычки или уберите кавычки.",
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
						`Рабочая папка: ${oneLine(directory)}`,
					);
				} catch {
					return this.sendDirect(
						chatId,
						"Папка не найдена, недоступна или не является папкой; текущая папка не изменена.",
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
					entries.push(`… показаны первые 100 из ${listing.total} элементов`);
				return this.sendDirect(
					chatId,
					[`Папка: ${oneLine(listing.cwd)}`, ...entries].join("\n"),
				);
			} catch {
				return this.sendDirect(
					chatId,
					"Папка не найдена, недоступна или не является папкой.",
				);
			}
		}
		const tokenMatch = /^\/(\S+)([\s\S]*)$/.exec(raw);
		const commandToken = tokenMatch?.[1] ?? "";
		const name = `/${commandToken.split("@")[0]}`.toLowerCase();
		const rawRemainder = tokenMatch?.[2] ?? "";
		const args = rawRemainder.trim().split(/\s+/).filter(Boolean);
		if (name === "/help" && args.length === 0) {
			const sessionId = this.selected.get(chatId);
			const selectionCurrency = this.selectionCurrency.get(chatId) ?? 0;
			const sessionCurrency = sessionId
				? (this.sessionMenuCurrencies.get(sessionId) ?? 0)
				: 0;
			const discovered = sessionId
				? await this.discoverExtensionCommands(sender, sessionId)
				: undefined;
			const current =
				sessionId !== undefined &&
				this.selected.get(chatId) === sessionId &&
				(this.selectionCurrency.get(chatId) ?? 0) === selectionCurrency &&
				(this.sessionMenuCurrencies.get(sessionId) ?? 0) === sessionCurrency;
			const commands = current ? discovered : undefined;
			const notes = !sessionId
				? [
						"Расширения Pi недоступны: сначала выберите живую сессию через /menu.",
					]
				: !commands
					? [
							current
								? "Расширения Pi сейчас недоступны; показаны только команды harnessd."
								: "Выбор или состояние сессии изменились; показаны только команды harnessd. Повторите /help.",
						]
					: [];
			const extensions = (commands ?? []).map(
				({ name, description }) => `/${name} — ${description}`,
			);
			let includeCancel = false;
			let includeReload = true;
			if (sessionId && this.getSessionCapabilities) {
				try {
					const capabilities = await this.getSessionCapabilities(sessionId);
					const stillCurrent =
						current &&
						this.selected.get(chatId) === sessionId &&
						(this.selectionCurrency.get(chatId) ?? 0) === selectionCurrency;
					includeCancel =
						stillCurrent && capabilities.includes("harness.cancel");
					includeReload =
						stillCurrent && capabilities.includes("harness.reload");
				} catch {
					includeCancel = false;
					includeReload = false;
				}
			}
			const omitted = Math.max(0, extensions.length - 1_000);
			const lines = [
				"Как начать: откройте /menu, выберите сессию или создайте новую. Обычные сообщения и вложения отправляются в выбранную сессию; /send <путь> отправляет файл из её рабочей папки.",
				"Команды:",
				...getTelegramHelpLines(includeCancel, includeReload),
				...notes,
				...extensions.slice(0, 1_000),
				...(omitted ? [`… ещё команд: ${omitted}`] : []),
			];
			for (const page of paginateTelegramHelp(lines)) {
				const carriesExtensions = extensions.some((line) =>
					page.includes(line),
				);
				if (
					carriesExtensions &&
					(!sessionId ||
						this.selected.get(chatId) !== sessionId ||
						(this.selectionCurrency.get(chatId) ?? 0) !== selectionCurrency ||
						(this.sessionMenuCurrencies.get(sessionId) ?? 0) !==
							sessionCurrency)
				)
					break;
				await this.sendDirect(chatId, page);
			}
			return;
		}
		if (name === "/reload") {
			if (args.length !== 0)
				return this.sendDirect(chatId, "Использование: /reload");
			const sessionId = this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			if (this.getSessionCapabilities) {
				try {
					if (
						!(await this.getSessionCapabilities(sessionId)).includes(
							"harness.reload",
						)
					)
						return this.sendDirect(
							chatId,
							"Команда /reload не поддерживается выбранной сессией.",
						);
				} catch {
					return this.sendDirect(
						chatId,
						"Не удалось проверить поддержку /reload выбранной сессией.",
					);
				}
			}
			const reloadOwner = Symbol("reload owner");
			const ownsReloadMarker = !this.reloadingSessions.has(sessionId);
			if (ownsReloadMarker) {
				this.reloadingSessions.set(sessionId, reloadOwner);
				this.refreshPanelsPreviewing(sessionId, sender, true);
			}
			let result: TransportResult;
			try {
				result = await this.request(sender, {
					kind: "reload",
					sessionId,
					beforeDispatch: () => this.selected.get(chatId) === sessionId,
				});
			} finally {
				if (
					ownsReloadMarker &&
					this.reloadingSessions.get(sessionId) === reloadOwner
				) {
					this.reloadingSessions.delete(sessionId);
					this.refreshPanelsPreviewing(sessionId, sender, true);
				}
			}
			if (result.ok) {
				this.refreshMenusForSession(sessionId, true);
				const name = this.sessionNames.get(sessionId);
				const currentSelection = this.selected.get(chatId);
				const destinationName = currentSelection
					? this.sessionNames.get(currentSelection)
					: undefined;
				const destination = currentSelection
					? `${destinationName ? `${oneLine(destinationName)} · ` : ""}#${currentSelection}`
					: "не выбрана";
				const selectionText =
					currentSelection === sessionId
						? "Выбор не изменился; обычные сообщения направляются в эту сессию."
						: `Перезагружена исходная сессия; текущий выбор не изменён. Обычные сообщения направляются в ${destination}.`;
				return this.sendDirect(
					chatId,
					`Ресурсы Pi перезагружены для ${name ? `${oneLine(name)} · ` : ""}#${sessionId}. ${selectionText}`,
				);
			}
			const messages: Record<string, string> = {
				RELOAD_ALREADY_RUNNING:
					"Перезагрузка уже выполняется; повторять команду не нужно.",
				RELOAD_BUSY:
					"Сессия занята или не готова. Дождитесь завершения работы Pi и повторите команду.",
				RELOAD_SELECTION_CHANGED:
					"Выбранная сессия изменилась; перезагрузка не выполнялась.",
				UNSUPPORTED_CAPABILITY:
					"Эта сессия не поддерживает перезагрузку ресурсов Pi.",
				SESSION_NOT_FOUND:
					"Выбранная сессия недоступна. Проверьте /sessions и выберите её снова.",
				PI_CONTROL_FAILED:
					"Pi не подтвердил перезагрузку. Результат неизвестен; автоматически команда не повторялась.",
			};
			return this.sendDirect(
				chatId,
				messages[result.error.code] ??
					"Не удалось подтвердить перезагрузку Pi. Автоматического повтора не было; проверьте /status.",
			);
		}
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
		if (name === "/permissions")
			return this.handlePermissionCommand(chatId, sender, args);
		if (name === "/model" && args.length === 0) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const optionCatalogResult = await this.request(sender, {
				kind: "adapter_options_list",
				sessionId,
			});
			if (
				optionCatalogResult.ok &&
				optionCatalogResult.value &&
				typeof optionCatalogResult.value === "object"
			) {
				const optionCatalog = optionCatalogResult.value as HarnessOptionCatalog;
				const option = optionCatalog.descriptors.find(
					(entry) => entry.key === "model",
				);
				if (option)
					return this.sendDirect(
						chatId,
						`Модель: ${String(optionCatalog.effective?.model ?? option.defaultValue ?? "по умолчанию")}. Установка: /model <model>; сброс: /model default.`,
					);
			}
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
				choices.length ? choices.join("\n") : "Модели недоступны.",
			);
		}
		if (name === "/model" && args.length >= 1 && args.length <= 2) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const optionCatalogResult = await this.request(sender, {
				kind: "adapter_options_list",
				sessionId,
			});
			if (
				optionCatalogResult.ok &&
				optionCatalogResult.value &&
				typeof optionCatalogResult.value === "object"
			) {
				const optionCatalog = optionCatalogResult.value as HarnessOptionCatalog;
				const option = optionCatalog.descriptors.find(
					(entry) => entry.key === "model",
				);
				if (option) {
					if (args[0] === "default" && args.length === 1)
						return this.applySessionOption(
							chatId,
							sender,
							sessionId,
							{ resetKeys: ["model"] },
							"Переопределение модели снято.",
						);
					if (!args[0] || args[0].length > 128 || /\s/.test(args[0]))
						return this.sendDirect(
							chatId,
							"Использование: /model <model|default> [effort].",
						);
					const effort = optionCatalog.descriptors.find(
						(entry) => entry.key === "effort",
					);
					if (args[1] && effort && !effort.values.includes(args[1]))
						return this.sendDirect(
							chatId,
							`Недопустимый effort: ${effort.values.join(", ")}.`,
						);
					return this.applySessionOption(
						chatId,
						sender,
						sessionId,
						{
							set: { model: args[0], ...(args[1] ? { effort: args[1] } : {}) },
						},
						`Модель изменена: ${args[0]}${args[1] ? `; effort: ${args[1]}` : ""}.`,
					);
				}
			}
			if (
				!(await this.requireRunningSession(chatId, sender, sessionId, "model"))
			)
				return;
			const slash = args[0].indexOf("/");
			if (slash <= 0 || slash === args[0].length - 1)
				return this.sendDirect(
					chatId,
					"Использование: /model <provider/modelId> [effort]",
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
					`Выбрана модель ${modelId(change.model)}, но Pi не подтвердил effort ${oneLine(effort ?? "")}. Проверьте /status перед повтором.`,
				);
			return this.sendDirect(
				chatId,
				effort === undefined
					? `Выбрана модель ${modelId(change.model)}.`
					: `Выбрана модель ${modelId(change.model)}; effort установлен: ${oneLine(effort)}.`,
			);
		}
		if (name === "/effort" && args.length === 0) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const optionCatalogResult = await this.request(sender, {
				kind: "adapter_options_list",
				sessionId,
			});
			if (
				optionCatalogResult.ok &&
				optionCatalogResult.value &&
				typeof optionCatalogResult.value === "object"
			) {
				const catalog = optionCatalogResult.value as HarnessOptionCatalog;
				const option = catalog.descriptors.find(
					(entry) => entry.key === "effort",
				);
				if (option)
					return this.sendDirect(
						chatId,
						`Effort: ${String(catalog.effective?.effort ?? option.defaultValue ?? "по умолчанию")}. Доступно: ${option.values.join(", ")}.`,
					);
			}
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
				`Уровни effort${catalog.current ? ` (текущий: ${oneLine(catalog.current)})` : ""}: ${catalog.levels.map(oneLine).join(", ") || "недоступно"}`,
			);
		}
		if (name === "/effort" && args.length === 1) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const optionCatalogResult = await this.request(sender, {
				kind: "adapter_options_list",
				sessionId,
			});
			if (
				optionCatalogResult.ok &&
				optionCatalogResult.value &&
				typeof optionCatalogResult.value === "object"
			) {
				const catalog = optionCatalogResult.value as HarnessOptionCatalog;
				const option = catalog.descriptors.find(
					(entry) => entry.key === "effort",
				);
				if (option) {
					if (args[0] === "default")
						return this.applySessionOption(
							chatId,
							sender,
							sessionId,
							{ resetKeys: ["effort"] },
							"Переопределение effort снято.",
						);
					if (!option.values.includes(args[0]))
						return this.sendDirect(
							chatId,
							`Недопустимый effort: ${option.values.join(", ")}.`,
						);
					return this.applySessionOption(
						chatId,
						sender,
						sessionId,
						{ set: { effort: args[0] } },
						`Effort изменён: ${args[0]}.`,
					);
				}
			}
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
				result.ok
					? `Установлен effort: ${oneLine(args[0])}.`
					: result.error.message,
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
							.join("\n") || "Сессий нет."
					: escapeHtml(result.error.message),
			);
		}
		if (name === "/use") {
			if (args.length > 1)
				return this.sendDirect(chatId, "Использование: /use [sessionId]");
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
					`${result.error.message} Выберите другую сессию через /sessions или /menu.`,
				);
			}
			const session = result.value as SessionSummary;
			this.rememberSession(session);
			const selectionSaved = await this.setSelected(chatId, session.id);
			this.previews.delete(chatId);
			await this.refreshExistingPanel(chatId, sender);
			return this.sendDirect(
				chatId,
				`Выбрана ${sessionLabel(session)}.${args.length === 0 && session.status === "stopped" ? " Новое сообщение возобновит её." : ""}${selectionSaved ? "" : SELECTION_NOT_SAVED_WARNING}`,
			);
		}
		if (name === "/resume") {
			if (args.length > 1)
				return this.sendDirect(chatId, "Использование: /resume [sessionId]");
			const sessionId =
				(args[0] as SessionId | undefined) ?? this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const result = await this.request(sender, { kind: "resume", sessionId });
			if (result.ok) {
				this.refreshMenusForSession(sessionId, true);
				this.invalidateSessionConfirmations(sessionId);
				this.rememberSession(result.value as SessionSummary);
				this.refreshPanelsPreviewing(sessionId, sender, true);
				await this.refreshExistingPanel(chatId, sender);
			}
			if (result.ok) {
				const target = this.selected.get(chatId);
				const sameTarget = target === sessionId;
				const text = sameTarget
					? `Сессия ${this.sessionFooter(sessionId)} возобновлена. Выбор не изменён; обычные сообщения по-прежнему направляются в эту сессию.`
					: `Сессия ${this.sessionFooter(sessionId)} работает, но не выбрана. Выбор не изменён; обычные сообщения направляются в ${target ? this.sessionFooter(target) : "невыбранную сессию"}.`;
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
			if (result.ok) {
				// Deliver buffered answers before clearing the selection they route to.
				this.flushTurn(sessionId, true);
				this.clearAgentBoard(sessionId);
				await this.waitForEventQueue(chatId);
				this.refreshMenusForSession(sessionId, false);
				this.invalidateSessionConfirmations(sessionId);
				this.refreshPanelsPreviewing(sessionId, sender, true);
			}
			let selectionCleared = true;
			if (result.ok && this.selected.get(chatId) === sessionId) {
				selectionCleared = await this.clearSelected(chatId);
				this.previews.delete(chatId);
			}
			const selectedAfterStop = this.selected.get(chatId);
			const selectionMessage =
				selectedAfterStop === sessionId
					? "Выбор сохранён, но не удалось сбросить его в хранилище; он может вернуться после перезапуска."
					: wasSelected
						? selectionCleared
							? "Выбор сброшен; адресата для обычных сообщений нет."
							: "Выбор сброшен в памяти, но не сохранён; он может вернуться после перезапуска."
						: selectedAfterStop
							? `Выбор не изменён; сообщения направляются в ${this.sessionFooter(selectedAfterStop)}.`
							: "Сессия не была выбрана; адресата для обычных сообщений нет.";
			const message = result.ok
				? `Сессия ${this.sessionFooter(sessionId)} остановлена. ${selectionMessage} Возобновите её кнопкой ниже с выбором либо командой /resume ${sessionId} без смены выбора.`
				: `${result.error.message} Выбор не изменён${selectedAfterStop ? `; сообщения направляются в ${this.sessionFooter(selectedAfterStop)}` : "; адресата для сообщений нет"}. Далее: проверьте /menu.`;
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
				return this.sendDirect(chatId, "Использование: /delete <sessionId>");
			const sessionId = args[0] as SessionId;
			const inspected = await this.request(sender, {
				kind: "inspect",
				sessionId,
			});
			if (!inspected.ok)
				return this.sendDirect(
					chatId,
					`${inspected.error.message} Выбор не изменён; проверьте /menu.`,
				);
			const existing = inspected.value as SessionSummary;
			this.rememberSession(existing);
			if (existing.status !== "stopped")
				return this.sendDirect(
					chatId,
					`${sessionLabel(existing)} существует; статус Pi: ${existing.status}. Удалить запись можно только после остановки. Далее: /stop ${sessionId}, затем /delete ${sessionId}.`,
				);
			const { result, cleanupPending } = await this.deleteSessionAndInbox(
				sender,
				sessionId,
			);
			let selectionsCleared = true;
			if (result.ok) {
				this.refreshPanelsPreviewing(sessionId, sender, true);
				this.invalidateSession(sessionId);
				for (const [selectedChat, selectedId] of this.selected) {
					if (selectedId === sessionId) {
						selectionsCleared =
							(await this.clearSelected(selectedChat)) && selectionsCleared;
						this.previews.delete(selectedChat);
					}
				}
			}
			const remainingTarget = this.selected.get(chatId);
			return this.sendDirect(
				chatId,
				result.ok
					? `Запись остановленной сессии ${this.sessionFooter(sessionId)} удалена из harnessd. ${remainingTarget ? `Сообщения направляются в ${this.sessionFooter(remainingTarget)}.` : "В этом чате нет выбранной сессии для сообщений."} Далее: выберите сессию в /menu.${cleanupPending ? " Очистка вложений ещё не завершена." : ""}${selectionsCleared ? "" : " Сохранённый выбор может быть очищен при следующем запуске."}`
					: `${result.error.message} Selection is unchanged${remainingTarget ? `; messages target ${this.sessionFooter(remainingTarget)}` : "; no session is selected"}. Next: inspect /menu.`,
			);
		}
		if (name === "/cancel" && args.length <= 1) {
			const sessionId = this.selected.get(chatId);
			if (!sessionId)
				return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
			const selectionCurrency = this.selectionCurrency.get(chatId) ?? 0;
			let supportsCancel = false;
			try {
				supportsCancel =
					(await this.getSessionCapabilities?.(sessionId))?.includes(
						"harness.cancel",
					) ?? false;
			} catch {
				supportsCancel = false;
			}
			if (
				this.selected.get(chatId) !== sessionId ||
				(this.selectionCurrency.get(chatId) ?? 0) !== selectionCurrency
			)
				return this.sendDirect(
					chatId,
					"Выбор сессии изменился; отмена не выполнялась.",
				);
			if (!supportsCancel)
				return this.sendDirect(
					chatId,
					"Отмена ввода для выбранной сессии не поддерживается.",
				);
			return this.cancelRunInputs(
				chatId,
				sender,
				sessionId,
				args[0] as InputId | undefined,
			);
		}
		const extensionName = commandToken.split("@")[0]?.toLowerCase() ?? "";
		if (commandToken && !isNativeTelegramCommand(extensionName)) {
			const sessionId = this.selected.get(chatId);
			const selectionCurrency = this.selectionCurrency.get(chatId) ?? 0;
			if (!sessionId)
				return this.sendDirect(
					chatId,
					"Сначала выберите живую сессию через /menu.",
				);
			const inventory = await this.discoverExtensionCommands(sender, sessionId);
			if (!inventory)
				return this.sendDirect(
					chatId,
					"Команды расширений Pi сейчас недоступны; выполните /help позже.",
				);
			if (
				!inventory.some(
					(command) => command.name.toLowerCase() === extensionName,
				)
			)
				return this.sendDirect(
					chatId,
					"Эта команда Pi сейчас недоступна или больше не обнаружена.",
				);
			if (
				this.selected.get(chatId) !== sessionId ||
				(this.selectionCurrency.get(chatId) ?? 0) !== selectionCurrency
			)
				return this.sendDirect(
					chatId,
					"Выбор сессии изменился; повторите команду.",
				);
			let result: TransportResult;
			try {
				result = await this.request(sender, {
					kind: "command_run",
					sessionId,
					name: extensionName,
					remainder: rawRemainder,
					beforeDispatch: () =>
						this.selected.get(chatId) === sessionId &&
						(this.selectionCurrency.get(chatId) ?? 0) === selectionCurrency,
				});
			} catch (error) {
				this.reportError("Telegram extension command dispatch failed", error);
				return this.sendDirect(
					chatId,
					"Не удалось подтвердить команду Pi; автоматического повтора нет.",
				);
			}
			if (!result.ok) {
				const replies: Record<string, string> = {
					COMMAND_NOT_AVAILABLE:
						"Эта команда Pi больше недоступна; запрос не повторялся.",
					COMMAND_SELECTION_CHANGED:
						"Выбор сессии изменился; команда Pi не была отправлена.",
					RELOAD_BUSY: "Идёт перезагрузка Pi; команда не была отправлена.",
					COMMAND_REJECTED: "Pi не принял команду; запрос не повторялся.",
					COMMAND_UNCERTAIN:
						"Pi мог принять команду; результат неизвестен, повтор не выполнялся.",
					COMMAND_DISCOVERY_FAILED:
						"Не удалось проверить команду Pi; запрос не повторялся.",
					SESSION_NOT_FOUND:
						"Выбранная живая сессия недоступна; команда не выполнялась.",
				};
				return this.sendDirect(
					chatId,
					replies[result.error.code] ??
						"Не удалось выполнить команду Pi; автоматического повтора нет.",
				);
			}
			const commandResult = result.value as {
				disposition?: "handled" | "accepted";
				output?: string;
			};
			if (extensionName === "cost")
				return this.sendDirect(
					chatId,
					commandResult.output ??
						"Pi обработал /cost, но не вернул результат. Повтор автоматически не выполнялся.",
				);
			return this.sendDirect(
				chatId,
				commandResult.disposition === "handled"
					? "Pi обработал команду; это не подтверждает завершение работы."
					: "Pi принял команду; это не подтверждает завершение работы.",
			);
		}
		return this.sendDirect(chatId, "Неизвестная команда. Используйте /help.");
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
				"Укажите ID сессии или сначала выберите сессию.",
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
		if (flow.kind === "create")
			return this.promptForCreation(chatId, sender, flow.cwd, flow.harnessId);
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

	private async promptForHarnessSelection(
		chatId: number,
		sender: number,
		cwd: string,
	): Promise<void> {
		const entries = this.listHarnesses?.() ?? [];
		if (!entries.length) return this.promptForCreation(chatId, sender, cwd);
		const tokens = entries.map(() => this.makeIntentToken());
		entries.forEach((entry, index) => {
			const token = tokens[index];
			if (token)
				this.createHarnessIntents.set(token, {
					chatId,
					sender,
					cwd,
					harnessId: entry.id,
				});
		});
		while (this.createHarnessIntents.size > 512)
			this.createHarnessIntents.delete(
				this.createHarnessIntents.keys().next().value as string,
			);
		const rows = entries.map((entry, index) => {
			const label = oneLine(entry.metadata?.name ?? entry.id).slice(0, 48);
			const token = tokens[index];
			return [inlineButton(label, `create-harness:${token}`)];
		});
		const sent = await this.sendWithDeadline(
			chatId,
			"Выберите harness для новой сессии.",
			{ reply_markup: keyboard(rows) },
			undefined,
			(messageId) => {
				for (const token of tokens) {
					const intent = token
						? this.createHarnessIntents.get(token)
						: undefined;
					if (intent && messageId !== undefined) intent.messageId = messageId;
				}
			},
		);
		if (!sent)
			for (const token of tokens) this.createHarnessIntents.delete(token);
	}

	private async dispatchCreateHarness(
		chatId: number,
		sender: number,
		token: string,
		messageId: number,
	): Promise<void> {
		const intent = this.createHarnessIntents.get(token);
		if (
			!intent ||
			intent.chatId !== chatId ||
			intent.sender !== sender ||
			intent.messageId !== messageId
		)
			return this.showStaleCallback(chatId, messageId);
		for (const [key, candidate] of this.createHarnessIntents)
			if (candidate.chatId === chatId && candidate.messageId === messageId)
				this.createHarnessIntents.delete(key);
		return this.promptForCreation(chatId, sender, intent.cwd, intent.harnessId);
	}

	private async promptForCreation(
		chatId: number,
		sender: number,
		cwd: string,
		harnessId?: AdapterId,
	): Promise<void> {
		if (!harnessId && this.listHarnesses?.().length)
			return this.promptForHarnessSelection(chatId, sender, cwd);
		const instructions = CREATE_NAME_INSTRUCTIONS;
		return this.promptForPathName(
			chatId,
			{ kind: "create", cwd, ...(harnessId ? { harnessId } : {}) },
			cwd,
			CREATE_NAME_PREFIX,
			instructions,
			"Точная папка создания сессии (управляющие символы экранированы):",
		);
	}

	private async promptForPathName(
		chatId: number,
		flow: PendingNameRequest,
		cwd: string,
		prefix: string,
		instructions: string,
		pathHeader = "Точная рабочая папка сессии (управляющие символы экранированы):",
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
				"Предыдущий запрос имени заменён новым действием.",
			);
		}
		const choices = await this.telegramCall((signal) =>
			this.bot.api.sendMessage(
				chatId,
				flow.kind === "create"
					? "Создать сессию без имени или отменить?"
					: "Отменить запрос переименования?",
				{
					reply_markup: keyboard(
						flow.kind === "create"
							? [
									[
										inlineButton("Создать без имени", "name:unnamed"),
										inlineButton("Отмена", "name:cancel"),
									],
								]
							: [[inlineButton("Отмена", "name:cancel")]],
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
				"Не удалось открыть запрос имени; используйте /rename.",
			);
			return;
		}
		if (this.namePromptVersions.get(chatId) !== version) {
			this.rememberStaleNamePrompt(chatId, messageId);
			await this.sendDirect(
				chatId,
				"Этот запрос имени заменён более новым действием.",
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
				"Имя не может быть пустым. Тот же объект переименования остаётся активным.",
			);
			return this.reissueNameFlow(chatId, sender, flow);
		}
		if (flow.kind === "create") {
			const name = reply === "/skip" ? undefined : text;
			const result = await this.request(sender, {
				kind: "create",
				cwd: flow.cwd,
				...(flow.harnessId ? { harnessId: flow.harnessId } : {}),
				...(name !== undefined ? { name } : {}),
			});
			if (!result.ok) {
				await this.sendDirect(chatId, result.error.message);
				return this.reissueNameFlow(chatId, sender, flow);
			}
			this.pendingNames.delete(chatId);
			const session = result.value as SessionSummary;
			this.rememberSession(session);
			this.refreshPanelsPreviewing(session.id, sender, true);
			const selectionSaved = await this.setSelected(chatId, session.id);
			this.previews.delete(chatId);
			await this.refreshExistingPanel(chatId, sender);
			return this.sendDirect(
				chatId,
				`Сессия ${sessionLabel(session)} создана и выбрана.${selectionSaved ? "" : SELECTION_NOT_SAVED_WARNING}`,
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
		if (error.code === "INPUT_NOT_DELIVERED") {
			// The input event already told the chats selecting this session; only a chat
			// that submitted to another session (a reply route) needs its own line.
			if (this.selected.get(chatId) === sessionId) return;
			const text =
				error.message === "Input canceled"
					? "отменён пользователем"
					: (inputFailureText(error.message) ?? "не доставлен");
			return this.sendDirect(
				chatId,
				redactDiagnosticText(
					`Ввод${error.inputId ? ` ${error.inputId}` : ""}: ${text}`,
					[this.options.token],
				),
			);
		}
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
						: "Сессия сейчас недоступна Pi.";
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

	private async handlePermissionCommand(
		chatId: number,
		sender: number,
		args: readonly string[],
	): Promise<void> {
		const sessionId = this.selected.get(chatId);
		if (!sessionId) return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
		const listed = await this.request(sender, {
			kind: "adapter_options_list",
			sessionId,
		});
		if (!listed.ok) return this.sendDirect(chatId, listed.error.message);
		if (!listed.value || typeof listed.value !== "object")
			return this.sendDirect(chatId, "Управление разрешениями недоступно.");
		const catalog = listed.value as HarnessOptionCatalog;
		const descriptor = catalog.descriptors.find(
			(option) => option.key === "permissionMode",
		);
		if (!descriptor)
			return this.sendDirect(
				chatId,
				"Эта сессия не предоставляет управление режимом разрешений.",
			);
		if (args.length === 0) {
			const current =
				catalog.effective?.permissionMode ??
				descriptor.defaultValue ??
				"default";
			const modes = descriptor.values.map((value) =>
				value === "default"
					? "default (ручной: /permissions manual)"
					: String(value),
			);
			return this.sendDirect(
				chatId,
				`Режим разрешений: ${String(current)}. Доступно: ${modes.join(", ")}. /permissions default снимает переопределение.`,
			);
		}
		if (args.length !== 1)
			return this.sendDirect(
				chatId,
				"Использование: /permissions <режим|default>",
			);
		if (args[0] === "default")
			return this.applySessionOption(
				chatId,
				sender,
				sessionId,
				{ resetKeys: [descriptor.key] },
				"Переопределение режима разрешений снято.",
			);
		const value = args[0] === "manual" ? "default" : args[0];
		if (!descriptor.values.some((candidate) => candidate === value))
			return this.sendDirect(
				chatId,
				`Неизвестный режим. Доступно: ${descriptor.values.join(", ")}; ручной режим: manual.`,
			);
		if (descriptor.dangerousValues?.includes(value))
			return this.confirmDangerousOption(
				chatId,
				sender,
				sessionId,
				descriptor.key,
				value,
			);
		return this.applySessionOption(
			chatId,
			sender,
			sessionId,
			{ set: { [descriptor.key]: value } },
			`Режим разрешений будет изменён на ${value}.`,
		);
	}

	private async applySessionOption(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		update: HarnessOptionUpdate,
		message: string,
	): Promise<void> {
		const result = await this.request(sender, {
			kind: "adapter_options_set",
			sessionId,
			update,
		});
		if (!result.ok) return this.sendDirect(chatId, result.error.message);
		const session = result.value as SessionSummary;
		this.rememberSession(session);
		this.refreshMenusForSession(sessionId, true);
		return this.sendDirect(
			chatId,
			`${message} Сессия перезапущена с сохранением native session ID.`,
		);
	}

	private async confirmDangerousOption(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		key: string,
		value: string,
	): Promise<void> {
		const confirmToken = this.makeIntentToken();
		const cancelToken = this.makeIntentToken();
		const confirm: DangerousOptionIntent = {
			chatId,
			sender,
			sessionId,
			key,
			value,
			confirm: true,
		};
		const cancel: DangerousOptionIntent = {
			chatId,
			sender,
			sessionId,
			key,
			value,
			confirm: false,
		};
		const expire = () => {
			this.dangerousOptionIntents.delete(confirmToken);
			this.dangerousOptionIntents.delete(cancelToken);
		};
		confirm.timer = setTimeout(expire, 60_000);
		cancel.timer = confirm.timer;
		this.dangerousOptionIntents.set(confirmToken, confirm);
		this.dangerousOptionIntents.set(cancelToken, cancel);
		const sent = await this.sendWithDeadline(
			chatId,
			"Подтвердите bypassPermissions: он отключает интерактивные разрешения и повышает риск выполнения действий.",
			{
				parse_mode: "HTML",
				reply_markup: keyboard([
					[
						inlineButton(
							"Подтвердить bypass",
							`option-confirm:${confirmToken}`,
						),
						inlineButton("Отмена", `option-confirm:${cancelToken}`),
					],
				]),
			},
			undefined,
			(messageId) => {
				confirm.messageId = messageId;
				cancel.messageId = messageId;
			},
		);
		if (!sent) {
			clearTimeout(confirm.timer);
			expire();
		}
	}

	private async dispatchDangerousOptionDecision(
		chatId: number,
		sender: number,
		token: string,
		messageId: number,
	): Promise<void> {
		const intent = this.dangerousOptionIntents.get(token);
		if (
			!intent ||
			intent.chatId !== chatId ||
			intent.sender !== sender ||
			intent.messageId !== messageId
		)
			return;
		this.dangerousOptionIntents.delete(token);
		if (intent.timer) clearTimeout(intent.timer);
		for (const [key, pending] of this.dangerousOptionIntents)
			if (pending.chatId === chatId && pending.messageId === messageId) {
				if (pending.timer) clearTimeout(pending.timer);
				this.dangerousOptionIntents.delete(key);
			}
		if (!intent.confirm || this.selected.get(chatId) !== intent.sessionId)
			return this.sendDirect(
				chatId,
				"Изменение разрешений отменено или устарело.",
			);
		return this.applySessionOption(
			chatId,
			sender,
			intent.sessionId,
			{
				set: { [intent.key]: intent.value },
				confirmedDangerous: true,
			},
			"Подтверждён режим bypassPermissions.",
		);
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
					"Выбранная сессия изменилась до отправки; ничего не отправлено.",
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
			if ((result.ok && result.resumed) || (!result.ok && result.error.resumed))
				this.refreshMenusForSession(request.sessionId, true);
			if (result.ok) {
				const inputId = result.value as InputId;
				this.recordInputOutcome(request.sessionId, inputId, chatId, "accepted");
			} else if (result.error.inputId)
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

	private invalidatePanelIntent(chatId: number): void {
		this.panelIntents.begin(chatId);
	}

	private async renderPanel(
		chatId: number,
		sender: number,
		messageId?: number,
		hideStaleAction = false,
	): Promise<void> {
		if (this.stopping) return;
		const renderRequest = this.panelIntents.begin(chatId);
		const listed = await this.request(sender, { kind: "list" });
		if (this.stopping || !this.panelIntents.isCurrent(chatId, renderRequest))
			return;
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
			if (!this.panelIntents.isCurrent(chatId, renderRequest)) return;
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
		let liveQueryFailed = false;
		if (previewId) {
			const result = await this.request(sender, {
				kind: "session_status",
				sessionId: previewId,
			});
			if (this.stopping || !this.panelIntents.isCurrent(chatId, renderRequest))
				return;
			if (result.ok) status = result.value as HarnessSessionStatus;
			else liveQueryFailed = true;
		}
		if (
			this.stopping ||
			!this.panelIntents.isCurrent(chatId, renderRequest) ||
			(this.previews.get(chatId) ??
				this.selected.get(chatId) ??
				sessions[0]?.id) !== previewId
		)
			return;
		if (status) this.rememberSession(status.session);
		const preview = status?.session ?? previewFromList;
		const liveAvailable = status?.live !== undefined;
		const liveState = !preview
			? listed.ok && sessions.length === 0
				? "offline"
				: "live unavailable"
			: preview.status === "running"
				? liveQueryFailed
					? "live unavailable"
					: liveAvailable
						? this.runningSessions.has(preview.id)
							? "busy"
							: "idle"
						: "stale"
				: preview.status === "starting"
					? "starting"
					: preview.status === "stopped"
						? "stopped"
						: "failed";
		const selectedLabel = selected
			? panelSessionLabel(selected)
			: selectedId
				? panelSessionLabel({
						id: selectedId,
						name: this.sessionNames.get(selectedId),
					})
				: "никуда (сессия не выбрана)";
		const previewLabel =
			previewId && previewId === selectedId
				? "та же сессия"
				: preview
					? panelSessionLabel(preview)
					: previewId
						? panelSessionLabel({
								id: previewId,
								name: this.sessionNames.get(previewId),
							})
						: "нет";
		const lines = [
			"📌 Панель сессий",
			`✉️ Сообщения → ${selectedLabel}`,
			PANEL_SEPARATOR,
			`👁 Просмотр: ${previewLabel}`,
		];
		if (preview) {
			const statusText = this.reloadingSessions.has(preview.id)
				? "перезагружаются ресурсы"
				: this.recoveringSessions.has(preview.id)
					? "восстанавливается"
					: liveState === "busy"
						? "работает, выполняет ход"
						: liveState === "idle"
							? "работает, ожидает ввода"
							: liveState === "stale"
								? "записана как работающая, живое состояние не подтверждено"
								: liveState === "live unavailable"
									? "работает, живое состояние недоступно"
									: liveState === "starting"
										? "запускается"
										: liveState === "stopped"
											? "остановлена"
											: "ошибка (статус может быть устаревшим)";
			lines.push(`📁 ${panelPath(preview.cwd)}`, `Статус: ${statusText}`);
			if (liveQueryFailed)
				lines.push("Живые данные: запрос завершился ошибкой.");
			if (liveAvailable) {
				lines.push(compactUsage(status?.live?.usage));
				if (status?.live?.model)
					lines.push(`Модель: ${modelId(status.live.model)}`);
				else lines.push("Модель: недоступна");
				if (status?.live?.effort)
					lines.push(`Усилие: ${oneLine(status.live.effort)}`);
				else lines.push("Усилие: недоступно");
				if (!status?.live?.usage) lines.push("Использование: недоступно");
				if (
					status?.live?.usage?.contextTokens == null &&
					status?.live?.usage?.contextPercent == null
				)
					lines.push("Контекст: недоступен");
			}
		} else {
			lines.push(
				`Статус: ${liveState === "offline" ? "нет сессий" : "живое состояние недоступно"}`,
			);
		}
		lines.push(
			PANEL_SEPARATOR,
			`Новые сессии создаются в: ${boundedPathPresentation(this.currentDirectories.get(chatId) ?? this.options.initialCwd)}`,
		);
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
			const renameButton = inlineButton(
				"Переименовать",
				`session:rename:${previewId}`,
			);
			if (preview.status === "running" || preview.status === "stopped")
				rows.push([
					inlineButton("Модель", "menu:models"),
					inlineButton("Усилие", "menu:efforts"),
					renameButton,
				]);
			else rows.push([renameButton]);
			if (preview.status === "running") {
				rows.push([inlineButton("Остановить", `session:stop:${previewId}`)]);
			} else if (preview.status === "stopped") {
				rows.push([
					inlineButton(
						"Возобновить и выбрать",
						`session:resume-select:${previewId}`,
					),
				]);
				rows.push([inlineButton("Удалить…", `session:delete:${previewId}`)]);
			} else {
				rows.push([
					inlineButton(
						"Остановить для восстановления…",
						`session:stop:${previewId}`,
					),
				]);
			}
		}
		const semantic = JSON.stringify({
			preview: preview?.status ?? (previewId ? "unavailable" : "none"),
			state: liveState,
			reloading: preview ? this.reloadingSessions.has(preview.id) : false,
			recovering: preview ? this.recoveringSessions.has(preview.id) : false,
			queryFailed: liveQueryFailed,
			model:
				liveAvailable && status?.live?.model
					? modelId(status.live.model)
					: liveAvailable
						? "Модель: недоступна"
						: null,
			effort:
				liveAvailable && status?.live?.effort
					? oneLine(status.live.effort)
					: liveAvailable
						? "Усилие: недоступно"
						: null,
			usage: liveAvailable ? compactUsage(status?.live?.usage) : null,
			usageUnavailable: liveAvailable && !status?.live?.usage,
			contextUnavailable:
				liveAvailable &&
				status?.live?.usage?.contextTokens == null &&
				status?.live?.usage?.contextPercent == null,
		});
		if (this.panelSemantic.get(chatId) !== semantic) {
			this.panelSemantic.set(chatId, semantic);
			const now = (this.options.activityClock ?? (() => new Date()))();
			this.panelUpdatedAt.set(
				chatId,
				(this.options.activityTimeFormatter ?? localActivityTime)(now),
			);
		}
		lines.push(`Обновлено: ${this.panelUpdatedAt.get(chatId) ?? "недоступно"}`);
		await this.updatePanel(
			chatId,
			boundedPanelText(lines),
			keyboard(rows),
			messageId,
			() => this.panelIntents.isCurrent(chatId, renderRequest),
		);
	}

	private refreshPanelsPreviewing(
		sessionId: SessionId,
		sender: number,
		flush = true,
		invalidateIntents = false,
	): void {
		for (const chatId of this.panelMessageIds.keys()) {
			if (
				(this.previews.get(chatId) ?? this.selected.get(chatId)) !== sessionId
			)
				continue;
			if (invalidateIntents) this.invalidatePanelIntent(chatId);
			const intent = this.panelIntents.current(chatId);
			this.panelRefreshScheduler.schedule(
				chatId,
				() =>
					this.panelIntents.isCurrent(chatId, intent)
						? this.refreshExistingPanel(chatId, sender)
						: Promise.resolve(),
				flush,
			);
		}
	}

	private async refreshExistingPanel(
		chatId: number,
		sender: number,
		hideStaleAction = false,
	): Promise<void> {
		if (this.stopping) return;
		const messageId =
			this.panelMessageIds.get(chatId) ?? this.panelStore?.get(chatId);
		if (messageId !== undefined)
			await this.renderPanel(chatId, sender, messageId, hideStaleAction);
	}

	private async waitForPanelPublication(chatId: number): Promise<boolean> {
		if (this.stopping) return false;
		const clock = this.options.panelClock ?? Date.now;
		const previous = this.panelPublicationTimes.get(chatId);
		if (previous !== undefined) {
			const remaining = 500 - (clock() - previous);
			if (remaining > 0)
				await (
					this.options.panelSleep ??
					((milliseconds) =>
						new Promise((resolve) => setTimeout(resolve, milliseconds)))
				)(remaining);
		}
		if (this.stopping) return false;
		this.panelPublicationTimes.set(chatId, clock());
		return true;
	}

	private panelRetryDelay(milliseconds: number): Promise<void> {
		return (
			this.options.panelSleep ??
			((delay) => new Promise((resolve) => setTimeout(resolve, delay)))
		)(milliseconds);
	}

	private async notifyPanelStale(chatId: number): Promise<void> {
		await this.telegramCall((signal) =>
			this.bot.api.sendMessage(
				chatId,
				"Telegram отклонил публикацию панели. Последняя операция не отменена и не повторялась. Нажмите «Обновить панель» или /menu, результат можно проверить через /status.",
				{
					reply_markup: keyboard([
						[inlineButton("Обновить панель", "panel:refresh")],
					]),
				},
				signal,
			),
		);
	}

	private updatePanel(
		chatId: number,
		text: string,
		replyMarkup: unknown,
		messageId?: number,
		isCurrent?: () => boolean,
	): Promise<boolean> {
		const generation = this.panelIntents.current(chatId);
		const current =
			isCurrent ?? (() => this.panelIntents.isCurrent(chatId, generation));
		const previous = this.panelUpdateQueues.get(chatId) ?? Promise.resolve();
		const update = previous
			.catch(() => undefined)
			.then(() =>
				current()
					? this.updatePanelNow(chatId, text, replyMarkup, messageId, current)
					: false,
			);
		this.panelUpdateQueues.set(chatId, update);
		const cleanup = () => {
			if (this.panelUpdateQueues.get(chatId) === update)
				this.panelUpdateQueues.delete(chatId);
		};
		void update.then(cleanup, cleanup);
		return update;
	}

	private async updatePanelNow(
		chatId: number,
		text: string,
		replyMarkup: unknown,
		messageId: number | undefined,
		isCurrent: () => boolean,
	): Promise<boolean> {
		const publication = JSON.stringify([text, replyMarkup]);
		if (
			this.panelPublished.get(chatId) === publication &&
			!this.panelStaleChats.has(chatId) &&
			!this.panelRepairChats.has(chatId)
		)
			return true;
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
			this.panelMessageIds.get(chatId) ??
			this.panelStore?.get(chatId) ??
			messageId;
		let replacedPanelId: number | undefined;
		const referenceIsCurrent = (expected: number | undefined) =>
			(this.panelMessageIds.get(chatId) ?? this.panelStore?.get(chatId)) ===
			expected;
		if (existing !== undefined) {
			if (
				!(await this.waitForPanelPublication(chatId)) ||
				!isCurrent() ||
				!referenceIsCurrent(existing)
			)
				return false;
			const clock = this.options.panelClock ?? Date.now;
			const edit = () =>
				this.telegramCall((signal) =>
					this.bot.api.editMessageText(
						chatId,
						existing,
						text,
						{ reply_markup: replyMarkup },
						signal,
					),
				);
			let edited = await edit();
			// Re-editing is idempotent ("not modified" counts as success), so transient failures retry.
			for (let attempt = 1; ; attempt++) {
				if (edited.ok || isMessageNotModified(edited.error)) break;
				if (!isTransientTelegramError(edited.error)) break;
				// The failed edit may have landed: never let a later identical render be deduplicated.
				this.panelRepairChats.add(chatId);
				const delay =
					telegramRetryAfterMs(edited.error) ??
					PANEL_RETRY_BASE_DELAY_MS * attempt;
				if (attempt > PANEL_EDIT_RETRIES || delay > PANEL_RETRY_MAX_DELAY_MS)
					break;
				await this.panelRetryDelay(delay);
				if (this.stopping || !isCurrent() || !referenceIsCurrent(existing))
					return false;
				this.panelPublicationTimes.set(chatId, clock());
				edited = await edit();
			}
			if (edited.ok || isMessageNotModified(edited.error)) {
				if (!referenceIsCurrent(existing)) return false;
				await this.savePanelReference(chatId, existing);
				if (!referenceIsCurrent(existing)) return false;
				this.panelStaleChats.delete(chatId);
				this.panelRepairChats.delete(chatId);
				this.panelPublished.set(chatId, publication);
				return isCurrent();
			}
			if (!isCurrent() || !referenceIsCurrent(existing)) return false;
			if (isTransientTelegramError(edited.error)) {
				// The edit may still have applied; the next refresh repairs it without a visible warning.
				this.dropPanelGenerationIntents(chatId, generation);
				this.panelRepairChats.add(chatId);
				return false;
			}
			if (!isReplaceablePanelEditError(edited.error)) {
				this.dropPanelGenerationIntents(chatId, generation);
				if (!isCurrent() || !referenceIsCurrent(existing)) return false;
				this.panelStaleChats.add(chatId);
				await this.notifyPanelStale(chatId);
				return false;
			}
			// The old panel is gone or frozen: publish a fresh panel instead.
			replacedPanelId = isMessageNotFound(edited.error) ? undefined : existing;
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
		if (!(await this.waitForPanelPublication(chatId))) return false;
		if (!isCurrent() || !referenceIsCurrent(existing)) return false;
		const sent = await this.telegramCall((signal) =>
			this.bot.api.sendMessage(
				chatId,
				text,
				hasBoundIntents ? {} : { reply_markup: replyMarkup },
				signal,
			),
		);
		if (!sent.ok) {
			if (!isCurrent() || !referenceIsCurrent(existing)) return false;
			this.dropPanelGenerationIntents(chatId, intentGeneration);
			// An uncertain send may have delivered the panel, so it is neither resent nor announced.
			if (isTransientTelegramError(sent.error)) {
				this.panelRepairChats.add(chatId);
				return false;
			}
			this.panelStaleChats.add(chatId);
			await this.notifyPanelStale(chatId);
			return false;
		}
		const createdMessageId = messageIdFrom(sent.value);
		if (createdMessageId === undefined || !referenceIsCurrent(existing)) {
			this.dropPanelGenerationIntents(chatId, intentGeneration);
			// Another panel was adopted while this one was in flight: never leave two live panels.
			if (createdMessageId !== undefined)
				await this.removePanelMessage(chatId, createdMessageId, text);
			return false;
		}
		if (existing !== undefined && existing !== createdMessageId)
			this.retirePanel(chatId, existing);
		await this.savePanelReference(chatId, createdMessageId);
		if (!referenceIsCurrent(createdMessageId)) {
			await this.removePanelMessage(chatId, createdMessageId, text);
			return false;
		}
		this.panelStaleChats.delete(chatId);
		this.panelRepairChats.delete(chatId);
		this.panelPublished.set(chatId, publication);
		if (!isCurrent()) return false;
		if (hasBoundIntents) {
			for (const intent of this.folderIntents.values())
				if (intent.chatId === chatId && intent.generation === intentGeneration)
					intent.messageId = createdMessageId;
			for (const intent of this.confirmationIntents.values())
				if (intent.chatId === chatId && intent.generation === intentGeneration)
					intent.messageId = createdMessageId;
			if (!(await this.waitForPanelPublication(chatId))) return false;
			if (!isCurrent() || !referenceIsCurrent(createdMessageId)) return false;
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
				// The keyboard edit failed after the panel was recorded as published: force a repaint.
				this.panelRepairChats.add(chatId);
				return false;
			}
		}
		// Panels are no longer pinned; a frozen predecessor that was pinned is released.
		if (replacedPanelId !== undefined && this.bot.api.unpinChatMessage) {
			const unpinned = await this.telegramCall(
				(signal) =>
					this.bot.api.unpinChatMessage?.(
						chatId,
						replacedPanelId,
						{},
						signal,
					) ?? Promise.resolve(true),
			);
			if (!unpinned.ok)
				this.reportError(
					"Replaced Telegram control panel could not be unpinned",
					unpinned.error,
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
		if (this.retiredPanelIds.get(chatId)?.has(messageId)) {
			// A tap on a replaced panel never re-adopts it (that would spawn yet another panel).
			await this.telegramCall((signal) =>
				this.bot.api.answerCallbackQuery(
					callback.id,
					{ text: "Эта панель устарела. Нажмите «📋 Панель» для актуальной." },
					signal,
				),
			);
			return this.refreshExistingPanel(chatId, sender);
		}
		this.invalidatePanelIntent(chatId);
		await this.telegramCall((signal) =>
			this.bot.api.answerCallbackQuery(callback.id, {}, signal),
		);
		if (!callback.data || callback.data.length > 64) return;
		if (callback.data.startsWith("permission:")) {
			this.dispatchPermissionDecision(
				chatId,
				sender,
				callback.data.slice(11),
				messageId,
			);
			return;
		}
		if (callback.data.startsWith("option-confirm:")) {
			await this.dispatchDangerousOptionDecision(
				chatId,
				sender,
				callback.data.slice(15),
				messageId,
			);
			return;
		}
		if (callback.data.startsWith("welcome:")) {
			await this.dispatchWelcomeAction(
				chatId,
				sender,
				callback.data.slice(8),
				messageId,
			);
			return;
		}
		if (callback.data.startsWith("reply:")) {
			await this.dispatchReplyChoice(chatId, sender, callback.data, messageId);
			return;
		}
		if (callback.data.startsWith("name:")) {
			await this.dispatchNameChoice(chatId, sender, callback.data, messageId);
			return;
		}
		if (callback.data.startsWith("card:")) {
			await this.dispatchCardAction(chatId, sender, callback.data, messageId);
			return;
		}
		if (callback.data.startsWith("restore:")) {
			await this.performRestoreIntent(chatId, sender, callback.data.slice(8));
			return;
		}
		if (callback.data.startsWith("run-cancel:")) {
			await this.dispatchCancelConfirmation(
				chatId,
				sender,
				callback.data,
				messageId,
			);
			return;
		}
		const directAction =
			callback.data.startsWith("create-harness:") ||
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

	private async dispatchWelcomeAction(
		chatId: number,
		sender: number,
		token: string,
		messageId: number,
	): Promise<void> {
		const intent = this.welcomeIntents.get(token);
		if (
			!intent ||
			intent.chatId !== chatId ||
			intent.sender !== sender ||
			intent.messageId !== messageId
		)
			return;
		this.welcomeIntents.delete(token);
		if (intent.action === "panel")
			return this.showPanelAtBottom(chatId, sender);
		if (intent.action === "new") {
			const cwd =
				this.currentDirectories.get(chatId) ?? this.options.initialCwd;
			return this.promptForCreation(chatId, sender, cwd);
		}
		let panelId =
			this.panelMessageIds.get(chatId) ?? this.panelStore?.get(chatId);
		if (panelId === undefined) {
			await this.renderPanel(chatId, sender);
			panelId =
				this.panelMessageIds.get(chatId) ?? this.panelStore?.get(chatId);
		}
		if (panelId !== undefined)
			await this.renderSessions(chatId, sender, panelId);
	}

	private async dispatchCallback(
		chatId: number,
		sender: number,
		data: string,
		messageId: number,
	): Promise<void> {
		if (data.startsWith("create-harness:"))
			return this.dispatchCreateHarness(
				chatId,
				sender,
				data.slice(15),
				messageId,
			);
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
			return this.promptForCreation(chatId, sender, cwd);
		}
		if (data === "folder:parent")
			return this.changeFolder(chatId, sender, "parent", messageId);
		if (data === "folder:new") {
			const cwd =
				this.currentDirectories.get(chatId) ?? this.options.initialCwd;
			return this.promptForCreation(chatId, sender, cwd);
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

	/** Cancels the current run (or one queued input) of a session and reports the outcome. */
	private async cancelRunInputs(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		inputId: InputId | undefined,
	): Promise<void> {
		const activeInput = inputId
			? this.inputAttributions.get(inputId)
			: [...this.inputAttributions.values()].find(
					(record) =>
						record.sessionId === sessionId &&
						!record.terminal &&
						record.state === "accepted" &&
						!record.steered,
				);
		const trackedInput =
			activeInput?.sessionId === sessionId && !activeInput.terminal
				? activeInput
				: undefined;
		if (trackedInput) {
			this.cancelingInputs.set(
				trackedInput.inputId,
				(this.cancelingInputs.get(trackedInput.inputId) ?? 0) + 1,
			);
			if (!inputId)
				this.cancelingCurrentRunInputs.set(
					trackedInput.inputId,
					(this.cancelingCurrentRunInputs.get(trackedInput.inputId) ?? 0) + 1,
				);
		}
		let result: TransportResult;
		try {
			result = await this.request(
				sender,
				inputId
					? { kind: "cancel", sessionId, inputId }
					: { kind: "cancel_current", sessionId },
			);
		} finally {
			if (trackedInput) {
				const pendingCancels =
					this.cancelingInputs.get(trackedInput.inputId) ?? 0;
				if (pendingCancels <= 1)
					this.cancelingInputs.delete(trackedInput.inputId);
				else this.cancelingInputs.set(trackedInput.inputId, pendingCancels - 1);
				if (!inputId) {
					const pendingCurrentCancels =
						this.cancelingCurrentRunInputs.get(trackedInput.inputId) ?? 0;
					if (pendingCurrentCancels <= 1)
						this.cancelingCurrentRunInputs.delete(trackedInput.inputId);
					else
						this.cancelingCurrentRunInputs.set(
							trackedInput.inputId,
							pendingCurrentCancels - 1,
						);
				}
			}
		}
		return this.sendDirect(
			chatId,
			result.ok
				? `Запрошена отмена ввода для ${sessionId}.`
				: result.error.message,
		);
	}

	private async dispatchCardAction(
		chatId: number,
		sender: number,
		data: string,
		messageId: number,
	): Promise<void> {
		const [, action, token] = data.split(":");
		const activity = token ? this.cardTokens.get(token) : undefined;
		if (
			!activity ||
			activity.chatId !== chatId ||
			activity.messageId !== messageId ||
			!this.cardActionable(activity)
		)
			return;
		if (action === "stop") {
			let supportsCancel = false;
			try {
				supportsCancel =
					(await this.getSessionCapabilities?.(activity.sessionId))?.includes(
						"harness.cancel",
					) ?? false;
			} catch {
				supportsCancel = false;
			}
			if (!supportsCancel)
				return this.updateLiveActivity(activity, {
					notice: "Прерывание этой сессии не поддерживается.",
				});
			return this.cancelRunInputs(
				chatId,
				sender,
				activity.sessionId,
				undefined,
			);
		}
		if (action !== "report") return;
		const now = this.activityNowMs();
		if (
			activity.reportRequestedAtMs !== undefined &&
			now - activity.reportRequestedAtMs < RUN_REPORT_DEBOUNCE_MS
		)
			return;
		activity.reportRequestedAtMs = now;
		const result = await this.submitFromChat(chatId, sender, {
			kind: "submit",
			sessionId: activity.sessionId,
			text: RUN_REPORT_PROMPT,
		});
		if (!result) return;
		this.updateLiveActivity(activity, {
			notice: result.ok
				? "📋 Запрошен отчёт"
				: `Отчёт не запрошен: ${redactDiagnosticText(safeResultError(result.error), [this.options.token])}`,
		});
	}

	/** Freezes the live card in place (no buttons) so the next render opens a new one below. */
	private freezeLiveActivity(activity: LiveActivity): void {
		if (activity.freezePending) return;
		activity.freezePending = true;
		activity.renderQueue = activity.renderQueue
			.then(async () => {
				const delivered = await this.waitForEventQueue(activity.chatId);
				const messageId = activity.messageId;
				if (
					!delivered ||
					this.stopping ||
					activity.unavailable ||
					activity.finishing ||
					messageId === undefined ||
					activity.lastText === undefined ||
					this.liveActivities.get(
						activityKey(activity.chatId, activity.sessionId),
					) !== activity
				)
					return;
				const frozen = await this.telegramCall((signal) =>
					this.bot.api.editMessageText(
						activity.chatId,
						messageId,
						activity.lastText as string,
						{ reply_markup: { inline_keyboard: [] } },
						signal,
					),
				);
				const gone = !frozen.ok && isMessageNotFound(frozen.error);
				if (!frozen.ok && !gone && !isMessageNotModified(frozen.error)) {
					// Keep the card where it is rather than stacking a second live card.
					this.reportError(
						"Telegram run card could not be frozen",
						frozen.error,
					);
					return;
				}
				if (!gone) activity.frozenMessageIds.push(messageId);
				activity.messageId = undefined;
				activity.lastText = undefined;
				activity.lastButtons = undefined;
			})
			.catch((error) => {
				this.reportError("Telegram run card could not be frozen", error);
			})
			.finally(() => {
				activity.freezePending = false;
			});
		this.renderLiveActivity(activity);
	}

	private async ensureControlKeyboard(chatId: number): Promise<void> {
		if (this.keyboardChats.has(chatId)) return;
		const sent = await this.sendWithDeadline(
			chatId,
			"⌨️ Кнопки управления — внизу, у поля ввода.",
			{ reply_markup: controlKeyboard(), disable_notification: true },
		);
		if (sent) this.keyboardChats.add(chatId);
	}

	private async handleControlButton(
		chatId: number,
		sender: number,
		button: (typeof CONTROL_BUTTONS)[keyof typeof CONTROL_BUTTONS],
		messageId: number | undefined,
	): Promise<void> {
		// The operator's button press is noise in the chat history.
		if (messageId !== undefined)
			void this.telegramCall((signal) =>
				this.bot.api.deleteMessage(chatId, messageId, signal),
			);
		if (button === CONTROL_BUTTONS.panel) {
			await this.ensureControlKeyboard(chatId);
			return this.showPanelAtBottom(chatId, sender);
		}
		if (button === CONTROL_BUTTONS.status)
			return this.command(chatId, sender, "/status");
		if (button === CONTROL_BUTTONS.sessions)
			return this.command(chatId, sender, "/sessions");
		return this.confirmCancel(chatId, sender);
	}

	/**
	 * Publishes a fresh panel at the bottom of the chat and removes the previous one.
	 * Overlapping publishes in one chat share the detached panel: only the newest
	 * publish may restore it when no new panel was confirmed, so a superseded publish
	 * can never re-attach (and let a newer render edit) the old panel.
	 */
	private async showPanelAtBottom(
		chatId: number,
		sender: number,
	): Promise<void> {
		if (this.stopping) return;
		const request = ++this.bottomPanelRequestCounter;
		const pending = this.bottomPanelPublishes.get(chatId);
		const attached =
			this.panelMessageIds.get(chatId) ?? this.panelStore?.get(chatId);
		const state = {
			latest: request,
			detached: attached ?? pending?.detached,
		};
		this.bottomPanelPublishes.set(chatId, state);
		// An overlapping publish already confirmed the attached panel: its predecessor is replaced.
		const replaced =
			attached !== undefined &&
			pending?.detached !== undefined &&
			pending.detached !== attached
				? this.retireReplacedPanel(chatId, pending.detached)
				: undefined;
		try {
			await this.publishPanelAtBottom(chatId, sender, request, attached);
		} finally {
			await replaced;
		}
	}

	private async publishPanelAtBottom(
		chatId: number,
		sender: number,
		request: number,
		attached: number | undefined,
	): Promise<void> {
		if (attached !== undefined) {
			// Detach the reference so the render publishes a new message instead of editing.
			this.panelMessageIds.delete(chatId);
			this.panelPublished.delete(chatId);
			try {
				await this.panelStore?.delete(chatId);
			} catch (error) {
				this.reportError(
					"Telegram panel reference could not be cleared",
					error,
				);
			}
		}
		try {
			await this.renderPanel(chatId, sender);
		} finally {
			await this.settleBottomPublish(chatId, request);
		}
	}

	/** Restores or retires the detached panel once a bottom publish has finished. */
	private async settleBottomPublish(
		chatId: number,
		request: number,
	): Promise<void> {
		const current =
			this.panelMessageIds.get(chatId) ?? this.panelStore?.get(chatId);
		const shared = this.bottomPanelPublishes.get(chatId);
		const previous = shared?.detached;
		if (shared?.latest !== request) {
			// A newer publish is in flight: never restore, only retire a panel it replaced.
			if (
				shared === undefined ||
				previous === undefined ||
				current === undefined ||
				current === previous
			)
				return;
			shared.detached = undefined;
			return this.retireReplacedPanel(chatId, previous);
		}
		this.bottomPanelPublishes.delete(chatId);
		if (previous === undefined || current === previous) return;
		if (current === undefined) {
			// No new panel was confirmed: keep the old one as the panel.
			await this.savePanelReference(chatId, previous);
			this.panelRepairChats.add(chatId);
			return;
		}
		return this.retireReplacedPanel(chatId, previous);
	}

	private async retireReplacedPanel(
		chatId: number,
		messageId: number,
	): Promise<void> {
		this.panelStaleChats.delete(chatId);
		await this.removePanelMessage(chatId, messageId, RETIRED_PANEL_NOTE);
	}

	/**
	 * Retires a panel message that is no longer the chat's panel and deletes it. When
	 * Telegram refuses the delete (e.g. older than 48 hours) the message is edited to
	 * `fallbackText` without buttons; if both fail, its taps still report an outdated
	 * panel because the ID stays retired. An already retired ID was handled before.
	 */
	private async removePanelMessage(
		chatId: number,
		messageId: number,
		fallbackText: string,
	): Promise<void> {
		if (this.retiredPanelIds.get(chatId)?.has(messageId)) return;
		this.retirePanel(chatId, messageId);
		const deleted = await this.telegramCall((signal) =>
			this.bot.api.deleteMessage(chatId, messageId, signal),
		);
		if ((deleted.ok && deleted.value !== false) || this.stopping) return;
		const edited = await this.telegramCall((signal) =>
			this.bot.api.editMessageText(
				chatId,
				messageId,
				fallbackText,
				{ reply_markup: { inline_keyboard: [] } },
				signal,
			),
		);
		if (!edited.ok && !isMessageNotModified(edited.error))
			this.reportError(
				"Replaced Telegram control panel could not be removed",
				edited.error,
			);
	}

	private retirePanel(chatId: number, messageId: number): void {
		const retired = this.retiredPanelIds.get(chatId) ?? new Set<number>();
		this.retiredPanelIds.set(chatId, retired);
		if (retired.size >= 32)
			retired.delete(retired.values().next().value as number);
		retired.add(messageId);
	}

	private async confirmCancel(chatId: number, sender: number): Promise<void> {
		const sessionId = this.selected.get(chatId);
		if (!sessionId) return this.sendDirect(chatId, NO_SESSION_SELECTED_MESSAGE);
		const token = this.makeIntentToken();
		const intent: {
			chatId: number;
			sender: number;
			sessionId: SessionId;
			createdAt: number;
			messageId?: number;
		} = {
			chatId,
			sender,
			sessionId,
			createdAt: (this.options.panelClock ?? Date.now)(),
		};
		this.cancelIntents.set(token, intent);
		while (this.cancelIntents.size > 32)
			this.cancelIntents.delete(
				this.cancelIntents.keys().next().value as string,
			);
		await this.sendWithDeadline(
			chatId,
			`Прервать текущий ход в ${this.sessionFooter(sessionId)}?`,
			{
				reply_markup: keyboard([
					[
						inlineButton("✋ Прервать", `run-cancel:yes:${token}`),
						inlineButton("Не прерывать", `run-cancel:no:${token}`),
					],
				]),
			},
			undefined,
			(messageId) => {
				intent.messageId = messageId;
			},
		);
	}

	private async dispatchCancelConfirmation(
		chatId: number,
		sender: number,
		data: string,
		messageId: number,
	): Promise<void> {
		const [, answer, token] = data.split(":");
		const intent = token ? this.cancelIntents.get(token) : undefined;
		const edit = async (text: string) => {
			await this.telegramCall((signal) =>
				this.bot.api.editMessageText(chatId, messageId, text, {}, signal),
			);
		};
		if (!intent) return edit("Подтверждение устарело; ход не прерывался.");
		if (
			intent.chatId !== chatId ||
			intent.sender !== sender ||
			intent.messageId !== messageId
		)
			return;
		this.cancelIntents.delete(token as string);
		if (answer !== "yes") return edit("Ход не прерывался.");
		if (
			(this.options.panelClock ?? Date.now)() - intent.createdAt >
			CANCEL_CONFIRMATION_TTL_MS
		)
			return edit("Подтверждение устарело; ход не прерывался.");
		if (this.selected.get(chatId) !== intent.sessionId)
			return edit("Выбор сессии изменился; ход не прерывался.");
		// Start the cancel before any await so the checked selection is the one cancelled.
		const cancelling = this.command(chatId, sender, "/cancel");
		await edit("Прерывание запрошено.");
		await cancelling;
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
			"Статус доставки ввода",
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
				current.events.splice(0);
				current.thought = undefined;
				current.notices.splice(0);
				current.actionCount = 0;
				current.startedAtMs = this.activityNowMs();
				current.tools.splice(0);
				current.subagentStatus = undefined;
				current.childStatuses.clear();
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
			childStatuses: new Map(),
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
			startedAtMs: this.activityNowMs(),
			events: [],
			frozenMessageIds: [],
			cardToken: this.makeIntentToken(),
			actionCount: 0,
		};
		this.cardTokens.set(activity.cardToken, activity);
		this.liveActivities.set(activityKey(chatId, sessionId), activity);
		this.renderLiveActivity(activity);
		activity.statsTimer = setInterval(
			() => void this.refreshLiveActivityStats(activity),
			2500,
		);
		activity.statsTimer.unref();
		return activity;
	}

	// Card timing uses wall time; activityClock stays dedicated to the "Обновлено" stamp.
	private activityNowMs(): number {
		return Date.now();
	}

	private activityClockLabel(): string {
		const now = new Date();
		return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	}

	private liveActivityModel(activity: LiveActivity): string {
		const name = this.sessionNames.get(activity.sessionId);
		const notices: string[] = [];
		if (activity.thinking && !activity.thought) notices.push("Думаю…");
		notices.push(...activity.notices.slice(-3));
		const agents = this.agentBoardLines(activity);
		if (!agents.length)
			for (const status of activity.childStatuses.values())
				notices.push(status);
		const visibleInputs = activity.queuedInputs.slice(-5);
		const olderUnresolved = activity.queuedInputs
			.slice(0, -visibleInputs.length)
			.filter((input) => input.state !== "completed").length;
		const overflowUnresolved =
			activity.overflowInputIds.size + activity.failedOverflowInputIds.size;
		if (olderUnresolved || overflowUnresolved)
			notices.push(
				`${olderUnresolved + overflowUnresolved} earlier input(s) remain unresolved`,
			);
		if (activity.untrackedInputOverflow)
			notices.push("Additional input status is unresolved.");
		if (activity.untrackedFailureOverflow)
			notices.push("Additional failed/uncertain input status is retained.");
		for (const input of visibleInputs)
			if (input.state !== "completed")
				notices.push(`Input ${input.inputId}: ${input.state}`);
		const live = activity.liveStatus;
		const model = live?.model
			? truncateDiagnostic(modelId(live.model), 120)
			: "model unavailable";
		const effort = live?.effort
			? truncateDiagnostic(oneLine(live.effort), 60)
			: "effort unavailable";
		return truncateActivityText(
			renderRunCard({
				stateIcon: runCardStateIcon({
					...(activity.task &&
					["active", "blocked", "paused"].includes(activity.task.status)
						? { task: activity.task }
						: {}),
					events: activity.events,
				}),
				status: activity.status,
				sessionLabel: `${name ? `${oneLine(name)} · ` : ""}#${activity.sessionId.slice(0, 8)}`,
				...(activity.startedAtMs !== undefined
					? { elapsedMs: this.activityNowMs() - activity.startedAtMs }
					: {}),
				...(activity.task &&
				["active", "blocked", "paused"].includes(activity.task.status)
					? { task: activity.task }
					: {}),
				...(activity.thought ? { thought: activity.thought } : {}),
				agents,
				notices,
				events: activity.events,
				footer: `${compactUsage(live?.usage)} · ${model} · ${effort}`,
			}),
		);
	}

	private clearAgentBoard(sessionId: SessionId): void {
		this.agentSnapshots.delete(sessionId);
		this.agentVerdicts.delete(sessionId);
	}

	private agentBoardLines(activity: LiveActivity): string[] {
		const snapshot = this.agentSnapshots.get(activity.sessionId)?.snapshot;
		if (!snapshot?.runs.length) return [];
		const byShortId = new Map(
			snapshot.runs
				.flatMap(function walk(run): (typeof snapshot.runs)[number][] {
					return [run, ...run.children.flatMap(walk)];
				})
				.filter((run) => shortRunId(run))
				.map((run) => [shortRunId(run), run]),
		);
		// Running "⏸ ждёт агентов [#id]" rows name whom the parent waits for (only mid-run).
		const waits = this.runningSessions.has(activity.sessionId)
			? activity.events.filter(
					(event) => event.state === "running" && event.text.startsWith("⏸"),
				)
			: [];
		const waitingFor = waits
			.flatMap((event) => [...event.text.matchAll(/#([0-9a-f]{8})\b/gi)])
			.map((match) => {
				const run = byShortId.get(match[1] ?? "");
				return run ? `${run.label} #${shortRunId(run)}` : `#${match[1]}`;
			});
		return renderAgentBoard(snapshot, this.activityNowMs(), {
			verdicts: this.agentVerdicts.get(activity.sessionId) ?? [],
			waitingFor: [...new Set(waitingFor)],
			waitsForAll: waits.some((event) => !/#[0-9a-f]{8}\b/i.test(event.text)),
			...(activity.startedAtMs !== undefined
				? { finishedSince: activity.startedAtMs }
				: {}),
		});
	}

	/** Card buttons act only while the card's run is live in this chat. */
	private cardActionable(activity: LiveActivity): boolean {
		return (
			this.runningSessions.has(activity.sessionId) &&
			!activity.finishing &&
			!activity.unavailable &&
			this.liveActivities.get(
				activityKey(activity.chatId, activity.sessionId),
			) === activity
		);
	}

	private runCardKeyboard(activity: LiveActivity): unknown {
		if (!this.cardActionable(activity)) return { inline_keyboard: [] };
		return keyboard([
			[
				inlineButton("📋 Отчёт", `card:report:${activity.cardToken}`),
				inlineButton("⛔ Прервать", `card:stop:${activity.cardToken}`),
			],
		]);
	}

	private liveActivityText(
		activity: LiveActivity,
		preserveUpdatedAtFor?: string,
	): string {
		const visibleModel = this.liveActivityModel(activity);
		if (activity.visibleModel !== visibleModel) {
			activity.visibleModel = visibleModel;
			if (visibleModel !== preserveUpdatedAtFor) {
				const now = this.options.activityClock?.() ?? new Date();
				activity.updatedAt = (
					this.options.activityTimeFormatter ?? localActivityTime
				)(now);
			}
		}
		return truncateActivityText(
			`${visibleModel}\nОбновлено: ${activity.updatedAt ?? "00:00:00"}`,
		);
	}

	private renderLiveActivity(
		activity: LiveActivity,
		preserveUpdatedAtFor?: string,
	): void {
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
				const text = this.liveActivityText(activity, preserveUpdatedAtFor);
				if (activity.messageId === undefined) {
					const sent = await this.telegramCall((signal) =>
						this.bot.api.sendMessage(
							activity.chatId,
							text,
							{
								...(this.cardActionable(activity)
									? { reply_markup: this.runCardKeyboard(activity) }
									: {}),
								disable_notification: true,
								...(activity.sourceMessageId === undefined ||
								activity.frozenMessageIds.length > 0
									? {}
									: {
											reply_parameters: {
												message_id: activity.sourceMessageId,
											},
										}),
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
					activity.lastButtons = this.cardActionable(activity);
					return;
				}
				const buttons = this.cardActionable(activity);
				if (activity.lastText === text && activity.lastButtons === buttons)
					return;
				const edited = await this.telegramCall((signal) =>
					this.bot.api.editMessageText(
						activity.chatId,
						activity.messageId as number,
						text,
						{ reply_markup: this.runCardKeyboard(activity) },
						signal,
					),
				);
				if (!edited.ok) {
					if (isMessageNotFound(edited.error)) {
						activity.messageId = undefined;
						activity.lastText = undefined;
						this.renderLiveActivity(activity);
					} else if (
						isTransientTelegramError(edited.error) &&
						telegramErrorCode(edited.error) !== undefined
					) {
						// Rate limits and server errors: the next render retries the edit.
						this.reportError(
							"Telegram run card edit was deferred",
							edited.error,
						);
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
				activity.lastButtons = buttons;
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
					? `Ввод ${inputId}: отменён пользователем`
					: `Ввод ${inputId}: ${state}${state === "uncertain" ? " (повторно не отправлялся)" : ""}`,
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

	/** Collapses the finished card into a one-line summary and removes frozen pieces. */
	private async deleteLiveActivity(activity: LiveActivity): Promise<void> {
		await activity.renderQueue;
		if (activity.statsTimer) clearInterval(activity.statsTimer);
		activity.statsTimer = undefined;
		if (activity.finishTimer) clearTimeout(activity.finishTimer);
		activity.finishTimer = undefined;
		const key = activityKey(activity.chatId, activity.sessionId);
		if (this.liveActivities.get(key) === activity)
			this.liveActivities.delete(key);
		this.cardTokens.delete(activity.cardToken);
		for (const frozen of activity.frozenMessageIds.splice(0)) {
			const deleted = await this.telegramCall((signal) =>
				this.bot.api.deleteMessage(activity.chatId, frozen, signal),
			);
			if (!deleted.ok)
				this.reportError(
					"Telegram run card piece could not be deleted",
					deleted.error,
				);
		}
		if (activity.messageId === undefined) return;
		const actions = activity.actionCount;
		const elapsed =
			activity.startedAtMs !== undefined
				? ` за ${formatDuration(this.activityNowMs() - activity.startedAtMs)}`
				: "";
		const cost = activity.liveStatus?.usage?.costUsd;
		const summary = [
			`✅ Ход завершён${elapsed}`,
			...(actions ? [actionsLabel(actions)] : []),
			...(cost !== undefined ? [`~$${cost.toFixed(2)}`] : []),
		].join(" · ");
		const edited = await this.telegramCall((signal) =>
			this.bot.api.editMessageText(
				activity.chatId,
				activity.messageId as number,
				summary,
				{},
				signal,
			),
		);
		if (!edited.ok)
			this.reportError(
				"Telegram run card could not be collapsed",
				edited.error,
			);
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
			`Выбрана ${sessionLabel(session)}. Обычные сообщения направляются в эту сессию.${selectionSaved ? "" : SELECTION_NOT_SAVED_WARNING}`,
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
			`Выбрана ${sessionLabel(session)}. Обычные сообщения направляются в эту сессию.${selectionSaved ? "" : SELECTION_NOT_SAVED_WARNING}`,
		);
		await this.renderPanel(chatId, sender, messageId);
	}

	private async renderSessions(
		chatId: number,
		sender: number,
		messageId: number,
	): Promise<void> {
		this.invalidatePanelIntent(chatId);
		const intent = this.panelIntents.current(chatId);
		const isCurrent = () => this.panelIntents.isCurrent(chatId, intent);
		const result = await this.request(sender, { kind: "list" });
		if (!isCurrent()) return;
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
			isCurrent,
		);
	}

	private async renderSessionDetails(
		chatId: number,
		sender: number,
		sessionId: SessionId,
		messageId: number,
	): Promise<void> {
		const intent = this.panelIntents.begin(chatId);
		const isCurrent = () => this.panelIntents.isCurrent(chatId, intent);
		const result = await this.request(sender, { kind: "inspect", sessionId });
		if (!isCurrent()) return;
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
		else if (session.status === "failed")
			rows.push(
				isRestorable(session)
					? [
							inlineButton(
								"Восстановить",
								`restore:${this.createRestoreIntent(chatId, sender, session.id)}`,
							),
							inlineButton("Остановить…", `session:stop:${session.id}`),
						]
					: [inlineButton("Остановить…", `session:stop:${session.id}`)],
			);
		else if (session.status === "starting")
			rows.push([
				inlineButton("Остановить/восстановить…", `session:stop:${session.id}`),
			]);
		if (session.status === "stopped")
			rows.push([inlineButton("Удалить…", `session:delete:${session.id}`)]);
		rows.push([inlineButton("К списку", "menu:sessions")]);
		await this.updatePanel(
			chatId,
			`${sessionLabel(session)}\nСообщения: ${this.selected.get(chatId) === session.id ? "идут в эту сессию" : "идут в другую сессию"}\nСтатус: ${sessionStatusLabel(session.status)}${failureCauseLine(session) ? `\n${failureCauseLine(session)}` : ""}${session.status === "failed" && !isRestorable(session) ? `\n${NOT_RESTORABLE_HINT}` : ""}\nПапка: ${panelPath(session.cwd)}`,
			keyboard(rows),
			messageId,
			isCurrent,
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
		const intent = this.panelIntents.begin(chatId);
		const isCurrent = () => this.panelIntents.isCurrent(chatId, intent);
		const directory =
			this.currentDirectories.get(chatId) ?? this.options.initialCwd;
		try {
			const listing = await listDirectories(directory);
			if (!isCurrent()) return;
			const pageSize = 8;
			const lastPage = Math.max(
				0,
				Math.ceil(listing.directories.length / pageSize) - 1,
			);
			const page = Math.min(
				Math.max(0, this.folderPages.get(chatId) ?? 0),
				lastPage,
			);
			this.folderPages.set(chatId, page);
			const visible = listing.directories.slice(
				page * pageSize,
				(page + 1) * pageSize,
			);
			const generation = this.nextPanelGeneration(chatId);
			const rows: InlineButton[][] = visible.map((name) => {
				const token = this.makeIntentToken();
				this.folderIntents.set(token, {
					chatId,
					messageId,
					generation,
					parent: listing.cwd,
					target: path.join(listing.cwd, name),
				});
				return [
					inlineButton(`📁 ${buttonLabel(name, 48)}/`, `folder:${token}`),
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
				`Папки\n${panelPath(listing.cwd)}${listing.truncated ? `\nПоказаны первые ${MAX_LIST_ENTRIES} папок из ${listing.total}. Чтобы открыть другую папку, используйте /cd <путь>.` : ""}`,
				keyboard(rows),
				messageId,
				isCurrent,
			);
		} catch {
			if (!isCurrent()) return;
			await this.updatePanel(
				chatId,
				"Не удалось прочитать эту папку.",
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
				isCurrent,
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
		const intent = this.panelIntents.begin(chatId);
		const isCurrent = () => this.panelIntents.isCurrent(chatId, intent);
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
		if (!isCurrent()) return;
		if (!inspected.ok)
			return this.updatePanel(
				chatId,
				inspected.error.message,
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
				isCurrent,
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
		const optionResult = await this.request(sender, {
			kind: "adapter_options_list",
			sessionId,
		});
		if (
			optionResult.ok &&
			optionResult.value &&
			typeof optionResult.value === "object"
		) {
			const optionCatalog = optionResult.value as HarnessOptionCatalog;
			const option = optionCatalog.descriptors.find(
				(entry) => entry.key === "model",
			);
			if (option) {
				const values = option.values.filter(
					(value): value is string => typeof value === "string",
				);
				const current = optionCatalog.effective?.model;
				const models = values.map((value) => ({
					provider: "adapter-option",
					id: value,
					name: value,
				}));
				this.modelChoices.set(chatId, {
					sessionId,
					models,
					optionKey: "model",
				});
				const rows = models.map((model, index) => [
					inlineButton(
						`${current === model.id ? "✓ " : ""}${buttonLabel(model.id, 50)}`,
						`model:select:${index}`,
					),
				]);
				rows.push([inlineButton("По умолчанию", "model:select:default")]);
				rows.push([inlineButton("Назад", "menu:home")]);
				return this.updatePanel(
					chatId,
					`Модель · ${activitySessionLabel(sessionId, this.sessionNames.get(sessionId))} · ${String(current ?? "по умолчанию")}`,
					keyboard(rows),
					messageId,
					isCurrent,
				).then(() => {});
			}
		}
		const result = await this.request(sender, {
			kind: "model_list",
			sessionId,
		});
		if (!isCurrent()) return;
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
			`Модель · ${activitySessionLabel(sessionId, this.sessionNames.get(sessionId))}`,
			keyboard(rows),
			messageId,
			isCurrent,
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
		if (choices.optionKey === "model" && rawIndex === "default") {
			if (
				(this.previews.get(chatId) ?? this.selected.get(chatId)) !==
				choices.sessionId
			)
				return this.renderModels(chatId, sender, messageId);
			return this.applySessionOption(
				chatId,
				sender,
				choices.sessionId,
				{ resetKeys: ["model"] },
				"Переопределение модели снято.",
			);
		}
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
		if (choices.optionKey === "model")
			return this.applySessionOption(
				chatId,
				sender,
				choices.sessionId,
				{ set: { model: model.id } },
				`Модель изменена: ${model.id}.`,
			);
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
		const intent = this.panelIntents.begin(chatId);
		const isCurrent = () => this.panelIntents.isCurrent(chatId, intent);
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
		if (!isCurrent()) return;
		if (!inspected.ok)
			return this.updatePanel(
				chatId,
				inspected.error.message,
				keyboard([[inlineButton("Назад", "menu:home")]]),
				messageId,
				isCurrent,
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
		const optionResult = await this.request(sender, {
			kind: "adapter_options_list",
			sessionId,
		});
		if (
			optionResult.ok &&
			optionResult.value &&
			typeof optionResult.value === "object"
		) {
			const optionCatalog = optionResult.value as HarnessOptionCatalog;
			const option = optionCatalog.descriptors.find(
				(entry) => entry.key === "effort",
			);
			if (option) {
				const levels = option.values.filter(
					(value): value is string => typeof value === "string",
				);
				const current = optionCatalog.effective?.effort;
				this.effortChoices.set(chatId, {
					sessionId,
					levels,
					optionKey: "effort",
				});
				const rows = levels.map((level, index) => [
					inlineButton(
						`${current === level ? "✓ " : ""}${buttonLabel(level, 50)}`,
						`effort:select:${index}`,
					),
				]);
				rows.push([inlineButton("По умолчанию", "effort:select:default")]);
				rows.push([inlineButton("Назад", "menu:home")]);
				return this.updatePanel(
					chatId,
					`Усилие · ${activitySessionLabel(sessionId, this.sessionNames.get(sessionId))} · ${String(current ?? "по умолчанию")}`,
					keyboard(rows),
					messageId,
					isCurrent,
				).then(() => {});
			}
		}
		const result = await this.request(sender, {
			kind: "effort_list",
			sessionId,
		});
		if (!isCurrent()) return;
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
			`Усилие · ${activitySessionLabel(sessionId, this.sessionNames.get(sessionId))} · ${catalog.current ? oneLine(catalog.current) : "не задано"}`,
			keyboard(rows),
			messageId,
			isCurrent,
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
		if (choices.optionKey === "effort" && rawIndex === "default") {
			if (
				(this.previews.get(chatId) ?? this.selected.get(chatId)) !==
				choices.sessionId
			)
				return this.renderEfforts(chatId, sender, messageId);
			return this.applySessionOption(
				chatId,
				sender,
				choices.sessionId,
				{ resetKeys: ["effort"] },
				"Переопределение effort снято.",
			);
		}
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
		if (choices.optionKey === "effort")
			return this.applySessionOption(
				chatId,
				sender,
				choices.sessionId,
				{ set: { effort } },
				`Усилие изменено: ${effort}.`,
			);
		const result = await this.request(sender, {
			kind: "effort_set",
			sessionId: choices.sessionId,
			effort,
		});
		if (!result.ok) await this.sendDirect(chatId, result.error.message);
		else await this.sendDirect(chatId, `Усилие установлено: ${effort}.`);
		await this.renderPanel(chatId, sender, messageId);
	}

	/** One live token per chat, sender and session, shared by its notice and card. */
	private createRestoreIntent(
		chatId: number,
		sender: number,
		sessionId: SessionId,
	): string {
		for (const [existing, intent] of this.restoreIntents)
			if (
				intent.chatId === chatId &&
				intent.sender === sender &&
				intent.sessionId === sessionId
			)
				return existing;
		const token = this.makeIntentToken();
		this.restoreIntents.set(token, { chatId, sender, sessionId });
		while (this.restoreIntents.size > 128)
			this.restoreIntents.delete(
				this.restoreIntents.keys().next().value as string,
			);
		return token;
	}

	/** One-tap restore: stop the failed session if needed, then resume the same native session. */
	private async performRestoreIntent(
		chatId: number,
		sender: number,
		token: string,
	): Promise<void> {
		const intent = this.restoreIntents.get(token);
		if (!intent || intent.chatId !== chatId || intent.sender !== sender) {
			await this.sendDirect(
				chatId,
				"Это действие устарело или относится к другому чату. Откройте сессию в /menu.",
			);
			return;
		}
		this.restoreIntents.delete(token);
		const { sessionId } = intent;
		const outcome = await this.withSessionRequestLock(sessionId, async () => {
			const inspected = await this.dispatchRequest(sender, {
				kind: "inspect",
				sessionId,
			});
			if (!inspected.ok) return inspected;
			const status = (inspected.value as SessionSummary).status;
			if (status === "running") return inspected;
			if (status !== "stopped") {
				const stopped = await this.dispatchRequest(sender, {
					kind: "stop",
					sessionId,
				});
				if (!stopped.ok) {
					// Stop may report earlier recovery errors although the record is now stopped.
					const after = await this.dispatchRequest(sender, {
						kind: "inspect",
						sessionId,
					});
					if (!after.ok || (after.value as SessionSummary).status !== "stopped")
						return stopped;
				}
			}
			return this.dispatchRequest(sender, { kind: "resume", sessionId });
		});
		if (!outcome.ok) {
			this.refreshMenusForSession(sessionId, false);
			this.refreshPanelsPreviewing(sessionId, sender, true);
			await this.sendDirect(
				chatId,
				`Не удалось восстановить сессию ${this.sessionFooter(sessionId)}: ${restoreErrorText(outcome.error)}`,
			);
			return;
		}
		this.announcedFailures.delete(sessionId);
		this.invalidateSessionConfirmations(sessionId);
		this.rememberSession(outcome.value as SessionSummary);
		this.refreshMenusForSession(sessionId, true);
		this.refreshPanelsPreviewing(sessionId, sender, true);
		await this.sendDirect(
			chatId,
			`Сессия ${this.sessionFooter(sessionId)} восстановлена и работает.`,
		);
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
			`Выбрана ${sessionLabel(inspected.value as SessionSummary)}.${saved ? "" : SELECTION_NOT_SAVED_WARNING}`,
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
			this.refreshMenusForSession(intent.sessionId, true);
			this.refreshPanelsPreviewing(intent.sessionId, sender, true);
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
				`Сессия ${this.sessionFooter(intent.sessionId)} возобновлена и выбрана. Обычные сообщения направляются в ${this.sessionFooter(intent.sessionId)}.${saved ? "" : SELECTION_NOT_SAVED_WARNING}`,
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
			this.refreshMenusForSession(sessionId, true);
			this.refreshPanelsPreviewing(sessionId, sender, true);
			const target = this.selected.get(chatId);
			await this.sendDirect(
				chatId,
				target === sessionId
					? `Сессия ${this.sessionFooter(sessionId)} возобновлена. Выбор не изменён; обычные сообщения по-прежнему направляются в эту сессию.`
					: `Сессия ${this.sessionFooter(sessionId)} работает, но не выбрана. Выбор не изменён; обычные сообщения направляются в ${target ? this.sessionFooter(target) : "невыбранную сессию"}. Выберите её командой /use ${sessionId} или кнопкой «Выбрать».`,
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
		this.refreshMenusForSession(sessionId, true);
		this.refreshPanelsPreviewing(sessionId, sender, true);
		const saved = await this.setSelected(chatId, sessionId);
		this.previews.delete(chatId);
		await this.sendDirect(
			chatId,
			`Сессия ${this.sessionFooter(sessionId)} возобновлена и выбрана. Сообщения направляются в ${this.sessionFooter(sessionId)}.${saved ? "" : SELECTION_NOT_SAVED_WARNING}`,
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
			this.refreshPanelsPreviewing(sessionId, sender, true);
			if (action === "stop") {
				this.flushTurn(sessionId, true);
				this.clearAgentBoard(sessionId);
				await this.waitForEventQueue(chatId);
				this.refreshMenusForSession(sessionId, false);
				if (this.selected.get(chatId) === sessionId) {
					selectionPersistenceWarning = !(await this.clearSelected(chatId));
					this.previews.delete(chatId);
				}
			} else {
				this.invalidateSession(sessionId);
				if (cleanupPending)
					await this.sendDirect(
						chatId,
						"Запись сессии удалена; очистка вложений ещё не завершена.",
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
					? `Сессия ${this.sessionFooter(sessionId)} остановлена.`
					: `Остановленная сессия ${this.sessionFooter(sessionId)} удалена из harnessd.`;
			const outcome = `${actionOutcome} ${selectedAfterAction ? `Выбор не изменён; сообщения направляются в ${this.sessionFooter(selectedAfterAction)}.` : "В этом чате нет выбранной сессии для сообщений."} ${action === "stop" ? `Возобновите её кнопкой ниже с выбором либо командой /resume ${sessionId} без смены выбора.` : "Далее: выберите другую сессию в /menu."}${selectionPersistenceWarning ? " Сохранённый выбор может быть очищен при следующем запуске." : ""}${cleanupPending ? " Очистка вложений ещё не завершена." : ""}`;
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
		if (
			event.kind === "status" &&
			(event.text === "harness_restarting" ||
				event.text === "harness_recovered" ||
				event.text === "harness_recovery_failed")
		) {
			if (event.text === "harness_restarting")
				this.recoveringSessions.add(event.sessionId);
			else this.recoveringSessions.delete(event.sessionId);
			// Pi restarted: its async-agent snapshot no longer describes live runs.
			this.clearAgentBoard(event.sessionId);
			this.runningSessions.delete(event.sessionId);
		}
		const terminalPanelEvent =
			(event.kind === "error" && event.fatal === true) ||
			(event.kind === "status" &&
				(event.text === "agent_settled" ||
					event.text === "harness_restarting" ||
					event.text === "harness_recovered" ||
					event.text === "harness_recovery_failed"));
		if (
			(event.kind === "status" &&
				(event.text === "agent_start" || terminalPanelEvent)) ||
			(event.kind === "error" && event.fatal === true)
		) {
			const sender = this.options.allowedUserIds[0];
			if (sender !== undefined)
				this.refreshPanelsPreviewing(
					event.sessionId,
					sender,
					terminalPanelEvent,
					true,
				);
		}
		if (event.kind === "output" && typeof event.text === "string") {
			this.appendTurnOutput(event.sessionId, event.text);
			return;
		}
		if (event.kind === "activity" && event.activityEvent) {
			this.updateLiveActivityFromEvent(event.sessionId, event.activityEvent);
			return;
		}
		if (event.kind === "anomaly" && event.anomalyEvent) {
			const route = anomalyRoute(event.anomalyEvent);
			if (route === "notice")
				this.anomalyNotices.push(event.sessionId, event.anomalyEvent);
			else if (route === "stop")
				this.stopAnomalies.set(event.sessionId, event.anomalyEvent);
			return;
		}
		if (event.kind === "status") {
			if (event.text === "harness_recovered")
				this.reportedErrors.delete(event.sessionId);
			if (
				event.text === "harness_restarting" ||
				event.text === "harness_recovered"
			)
				this.stopAnomalies.delete(event.sessionId);
			if (
				event.text === "harness_restarting" ||
				event.text === "harness_recovered" ||
				event.text === "harness_recovery_failed"
			)
				this.refreshMenusForSession(
					event.sessionId,
					event.text === "harness_recovered",
				);
			if (
				event.text === "harness_restarting" ||
				event.text === "harness_recovered" ||
				event.text === "harness_recovery_failed"
			) {
				this.invalidateSessionConfirmations(event.sessionId);
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
					activity.tools.splice(0);
					activity.subagentStatus = undefined;
					activity.childStatuses.clear();
					activity.status = "работает";
					activity.thinking = false;
					this.renderLiveActivity(activity);
					void this.refreshLiveActivityStats(activity);
				}
				return;
			}
			if (event.text === "agent_end") return;
			if (event.text === "message_end") {
				this.flushTurnMessage(event.sessionId);
				return;
			}
			if (event.text === "agent_settled") {
				this.invalidateSessionConfirmations(event.sessionId);
				this.runningSessions.delete(event.sessionId);
				// Card buttons are only live during a run.
				for (const activity of this.activitiesForSession(event.sessionId))
					this.renderLiveActivity(activity);
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
			if (
				event.text === "harness_restarting" ||
				event.text === "harness_recovered"
			)
				this.announcedFailures.delete(event.sessionId);
			if (event.text === "harness_recovery_failed") {
				// The owner-wide notice replaces the selected-session status line.
				void this.announceFailure(event.sessionId);
				return;
			}
			this.enqueueForSelected(event.sessionId, statusMessage(event.text));
			return;
		}
		if (event.kind === "error") {
			const detail = redactDiagnosticText(
				event.text?.trim() || "Pi сообщил о неуточнённой ошибке сессии.",
				[this.options.token],
			);
			const fingerprint = detail;
			const folded = event.fatal
				? this.stopAnomalies.get(event.sessionId)
				: undefined;
			if (event.fatal) this.stopAnomalies.delete(event.sessionId);
			// Pi stopping gets one Russian message, with any stop anomaly folded in.
			const presented = event.fatal
				? stopNoticeText(detail, folded)
				: `Pi error: ${detail}`;
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
				activity.notices.push(
					`⚠️ ${event.fatal ? (presented.split("\n")[0] ?? detail) : detail}`,
				);
				if (event.fatal) this.stopLiveActivityStats(activity);
				activity.status = event.fatal ? "Ошибка сессии" : activity.status;
				this.renderLiveActivity(activity);
			}
			this.enqueueForSelected(event.sessionId, presented);
			return;
		}
		if (event.kind === "input" && event.inputEvent) {
			const { inputId, state, detail } = event.inputEvent;
			const canceledByUser =
				state === "failed" && detail?.toLowerCase() === "input canceled";
			this.trackInputEvent(event.sessionId, inputId, state, canceledByUser);
			const notDelivered =
				state === "failed" ? inputFailureText(detail) : undefined;
			const inputPresentation = canceledByUser
				? `Ввод ${inputId}: отменён пользователем`
				: notDelivered
					? `Ввод ${inputId}: ${redactDiagnosticText(notDelivered, [this.options.token])}`
					: `Ввод ${inputId}: ${state}${state === "uncertain" ? " (повторно не отправлялся)" : ""}`;
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
						`${inputPresentation}${!canceledByUser && !notDelivered && detail ? ` · ${redactDiagnosticText(detail, [this.options.token])}` : ""}`,
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
		if (event.type === "agent_notice") {
			const parsed = agentVerdicts(event.text);
			if (!parsed.length) return;
			const verdicts = [
				...(this.agentVerdicts.get(sessionId) ?? []),
				...parsed,
			];
			this.agentVerdicts.set(sessionId, verdicts.slice(-MAX_AGENT_VERDICTS));
			for (const activity of activities) this.renderLiveActivity(activity);
			return;
		}
		if (event.type === "notification") {
			const snapshot = latestAgentSnapshot(event.text);
			const stored = this.agentSnapshots.get(sessionId);
			if (snapshot) {
				this.agentSnapshots.set(sessionId, {
					...(event.widgetKey ? { widgetKey: event.widgetKey } : {}),
					snapshot,
				});
				for (const activity of activities) this.renderLiveActivity(activity);
			} else if (
				!event.text.trim() &&
				event.widgetKey &&
				stored?.widgetKey === event.widgetKey
			) {
				// The widget that carried the snapshot was cleared: no agents remain.
				this.clearAgentBoard(sessionId);
				for (const activity of activities) this.renderLiveActivity(activity);
				return;
			}
		}
		const notification =
			event.type === "notification"
				? new SubagentTextStream().consume(event.text, true)
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
			let preserveUpdatedAtFor: string | undefined;
			switch (event.type) {
				case "thinking":
					if (activity.thinking === event.active) continue;
					activity.thinking = event.active;
					break;
				case "thought":
					if (activity.thought === event.text) continue;
					activity.thought = event.text;
					addThoughtEvent(
						activity.events,
						event.text,
						this.activityClockLabel(),
					);
					break;
				case "task":
					activity.task = {
						goal: event.goal,
						...(event.progress ? { progress: event.progress } : {}),
						status: event.status,
						step: event.step,
						...(event.limit !== undefined ? { limit: event.limit } : {}),
					};
					break;
				case "tool_start": {
					const summary = truncateDiagnostic(
						redactDiagnosticText(event.summary, [this.options.token]),
						700,
					);
					const role = approvedSubagentRole(summary);
					// Workflow and management calls stay off the card (same rule as before).
					if (meaningfulToolSummary(summary)) {
						const isNew = !activity.events.some(
							(candidate) => candidate.id === event.toolCallId,
						);
						if (
							addToolEvent(
								activity.events,
								event.toolCallId,
								role ? `subagent: запустил ${role}` : summary,
								this.activityClockLabel(),
								this.activityNowMs(),
							) &&
							isNew
						)
							activity.actionCount++;
					}
					const overflowAlreadyVisible = activity.tools.some(
						(row) => row.id === OVERFLOW_ID,
					);
					if (!updateActivityRow(activity.tools, event.toolCallId, summary))
						break;
					if (role && activity.childStatuses.has(role)) {
						if (
							!overflowAlreadyVisible &&
							activity.tools.some((row) => row.id === OVERFLOW_ID)
						) {
							preserveUpdatedAtFor = this.liveActivityModel(activity);
							break;
						}
						break;
					}
					activity.status = "работает";
					void this.refreshLiveActivityStats(activity);
					break;
				}
				case "tool_end": {
					const cardChanged = finishToolEvent(
						activity.events,
						event.toolCallId,
						event.failed,
						event.detail,
						this.activityNowMs(),
					);
					const previous = activity.tools.find(
						(row) => row.id === event.toolCallId,
					);
					const role = approvedSubagentRole(previous?.summary ?? "");
					const rowChanged = updateActivityRow(
						activity.tools,
						event.toolCallId,
						undefined,
						event.failed ?? "unknown",
					);
					if (!rowChanged && !cardChanged) continue;
					if (role && activity.childStatuses.has(role) && !cardChanged)
						continue;
					activity.status = "работает";
					void this.refreshLiveActivityStats(activity);
					break;
				}
				case "notification":
					if (notification?.visibleText.trim()) {
						const notice = redactDiagnosticText(notification.visibleText, [
							this.options.token,
						]);
						if (!activity.notices.includes(notice)) {
							activity.notices.push(notice);
							if (activity.notices.length > 12) activity.notices.shift();
						} else continue;
					}
					break;
			}
			this.renderLiveActivity(activity, preserveUpdatedAtFor);
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
					const label =
						/^Задача ([^:]+):/.exec(turn.subagentStatus)?.[1] ?? "Помощник";
					activity.childStatuses.set(label, turn.subagentStatus);
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
		if (state === "accepted" && !record.pendingSeen)
			record.steered =
				this.runningSessions.has(sessionId) ||
				[...this.inputAttributions.values()].some(
					(other) =>
						other !== record &&
						other.sessionId === sessionId &&
						!other.terminal,
				);
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
		canceledByUser = false,
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
			if (state === "failed" && canceledByUser)
				this.reassignQueuedInputsAfterCancellation(record);
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
		const cancellationPending = [...this.inputAttributions.values()].some(
			(record) =>
				record.turn === turn &&
				this.cancelingCurrentRunInputs.has(record.inputId),
		);
		for (const record of this.inputAttributions.values()) {
			if (record.turn !== turn || record.terminal) continue;
			if (
				cancellationPending &&
				this.cancelingCurrentRunInputs.has(record.inputId)
			)
				continue;
			if (
				cancellationPending &&
				record.steered &&
				(record.state === "pending" || record.state === "accepted")
			) {
				this.detachInputFromTurn(record, turn);
				continue;
			}
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

	private reassignQueuedInputsAfterCancellation(
		canceledInput: InputAttribution,
	): void {
		const turn = canceledInput.turn;
		if (!turn) return;
		turn.cancelled = true;
		for (const record of this.inputAttributions.values()) {
			if (
				record === canceledInput ||
				record.turn !== turn ||
				record.terminal ||
				!record.steered ||
				(record.state !== "pending" && record.state !== "accepted")
			)
				continue;
			this.detachInputFromTurn(record, turn);
		}
	}

	private detachInputFromTurn(
		record: InputAttribution,
		turn: TurnBuffer,
	): void {
		turn.pendingInputs.delete(record.inputId);
		record.turn = undefined;
		record.waitingForRun = true;
		if (
			record.chatId !== undefined &&
			![...this.inputAttributions.values()].some(
				(other) =>
					other !== record &&
					other.turn === turn &&
					!other.terminal &&
					other.chatId === record.chatId,
			)
		) {
			turn.recipients.delete(record.chatId);
			turn.statusRecipients.delete(record.chatId);
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
			readonly overflow: boolean;
		},
	): void {
		if (result.overflow) buffer.overflow = true;
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
		const label = /^Задача ([^:]+):/.exec(status)?.[1] ?? "Помощник";
		for (const chatId of chats) {
			const activity = this.liveActivities.get(activityKey(chatId, sessionId));
			if (activity && activity.childStatuses.get(label) !== status) {
				activity.childStatuses.set(label, status);
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
		if (buffer.cancelled || (buffer.characters === 0 && !buffer.overflow))
			return;
		let text = buffer.chunks.join("");
		if (!text.trim()) {
			if (!buffer.overflow) return;
			text = TURN_OVERFLOW_NOTICE;
		} else {
			if (buffer.interrupted)
				text += "\n\n[Response interrupted before completion.]";
			if (buffer.overflow) text += `\n\n${TURN_OVERFLOW_NOTICE}`;
		}
		this.deliverTurnText(sessionId, buffer.recipients, text);
	}

	/** Delivers the assistant message that just ended while its run continues. */
	private flushTurnMessage(sessionId: SessionId): void {
		const buffer = this.turnBuffers.get(sessionId);
		if (!buffer || buffer.settled || buffer.cancelled) return;
		this.appendSubagentResult(
			sessionId,
			buffer,
			buffer.subagentStream.consume("", true),
		);
		let text = buffer.chunks.join("");
		const overflow = buffer.overflow;
		buffer.chunks.splice(0);
		buffer.characters = 0;
		buffer.overflow = false;
		if (!text.trim()) {
			if (!overflow) return;
			text = TURN_OVERFLOW_NOTICE;
		} else if (overflow) text += `\n\n${TURN_OVERFLOW_NOTICE}`;
		const attributed = new Set(buffer.recipients);
		for (const record of this.inputAttributions.values())
			if (
				record.turn === buffer &&
				!record.terminal &&
				record.chatId !== undefined &&
				(record.state === "accepted" || record.state === "uncertain")
			)
				attributed.add(record.chatId);
		// Mid-run answers arrive silently; the settled answer keeps the notification sound.
		const recipients = this.deliverTurnText(sessionId, attributed, text, true);
		// Keep the live card below the answer in the chats that received it.
		for (const activity of this.activitiesForSession(sessionId))
			if (
				recipients.has(activity.chatId) &&
				activity.messageId !== undefined &&
				!activity.finishing
			)
				this.freezeLiveActivity(activity);
	}

	private deliverTurnText(
		sessionId: SessionId,
		attributedChats: ReadonlySet<number>,
		text: string,
		silent = false,
	): ReadonlySet<number> {
		const selectedChats = new Set<number>();
		for (const [chatId, selectedId] of this.selected)
			if (selectedId === sessionId) selectedChats.add(chatId);
		const recipients = attributedChats.size ? attributedChats : selectedChats;
		for (const chatId of recipients) {
			const attributed = attributedChats.has(chatId);
			this.enqueue(
				chatId,
				sessionId,
				attributed
					? `Фоновая сессия · ${this.eventFooter(sessionId)}\n\n${text}`
					: text,
				undefined,
				true,
				attributed,
				silent,
			);
		}
		return recipients;
	}

	private eventChannelDisabled(chatId: number): boolean {
		return this.queues.get(chatId)?.failed ?? false;
	}

	/** One notice per failure to every authorized private chat, selected or not. */
	private async announceFailure(sessionId: SessionId): Promise<void> {
		if (this.announcedFailures.has(sessionId)) return;
		this.announcedFailures.add(sessionId);
		let session: SessionSummary | undefined;
		try {
			session = (await this.listSessions?.())?.find(
				(candidate) => candidate.id === sessionId,
			);
		} catch (error) {
			this.reportError(
				"Telegram failure notice could not read the session",
				error,
			);
		}
		if (session) this.rememberSession(session);
		const text = failureNoticeText(session);
		const restorable = isRestorable(session);
		// A private chat with an authorized user has that user's ID.
		await Promise.all(
			[...this.authorized].map((chatId) =>
				this.deliverFailureNotice(chatId, sessionId, text, restorable),
			),
		);
	}

	/**
	 * Send a failure notice outside the event-queue failure rules: it waits behind
	 * output already queued for the chat, but is sent even when that chat's event
	 * channel is disabled, and its own failure never disables the channel.
	 */
	private async deliverFailureNotice(
		chatId: number,
		sessionId: SessionId,
		text: string,
		restorable: boolean,
	): Promise<void> {
		if (this.stopping) return;
		const queue = this.queues.get(chatId);
		if (queue && !queue.failed) await this.waitForEventQueue(chatId);
		const body =
			splitMessageWithFooter(text, this.eventFooter(sessionId))[0] ?? text;
		const other = {
			...sessionIdEntity(body, sessionId),
			...(restorable
				? {
						reply_markup: keyboard([
							[
								inlineButton(
									"Восстановить",
									`restore:${this.createRestoreIntent(chatId, chatId, sessionId)}`,
								),
							],
						]),
					}
				: {}),
		};
		const sent = await this.telegramCall((signal) =>
			this.bot.api.sendMessage(chatId, body, other, signal),
		);
		if (!sent.ok)
			this.reportError("Telegram failure notice delivery failed", sent.error);
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
		this.clearAgentBoard(sessionId);
		for (const [inputId, record] of this.inputAttributions)
			if (record.sessionId === sessionId)
				this.inputAttributions.delete(inputId);
		this.knownSessions.delete(sessionId);
		this.sessionNames.delete(sessionId);
		this.sessionCwds.delete(sessionId);
		this.reportedErrors.delete(sessionId);
		this.anomalyNotices.forget(sessionId);
		this.stopAnomalies.delete(sessionId);
		this.announcedFailures.delete(sessionId);
		for (const [token, intent] of this.restoreIntents)
			if (intent.sessionId === sessionId) this.restoreIntents.delete(token);
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
		silent = false,
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
				this.queueOverflow(queue, sessionId, background, silent);
				break;
			}
			queue.messages.push({
				sessionId,
				text: part,
				...(output ? { output: true as const } : {}),
				...(background ? { background: true as const } : {}),
				...(silent ? { silent: true as const } : {}),
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
		silent = false,
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
			...(silent ? { silent: true as const } : {}),
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
			const switchButton =
				backgroundDelivery && token
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
					: undefined;
			const silent = message.silent ? { disable_notification: true } : {};
			const plainText = message.output
				? telegramHtmlToPlainText(text)
				: undefined;
			const delivered = await this.sendWithDeadline(
				chatId,
				text,
				{
					...(message.output ? { parse_mode: "HTML" } : {}),
					...silent,
					...(switchButton ??
						(!message.output ? sessionIdEntity(text, message.sessionId) : {})),
				},
				message.output ? message.sessionId : undefined,
				(messageId) => {
					if (token) this.bindSelectMessage(token, messageId);
				},
				plainText === undefined
					? undefined
					: {
							text: plainText,
							other: {
								...silent,
								...(switchButton ??
									sessionIdEntity(plainText, message.sessionId)),
							},
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
		plainFallback?: { readonly text: string; readonly other: unknown },
	): Promise<boolean> {
		return this.telegramCall((signal) =>
			this.bot.api.sendMessage(chatId, text, other, signal),
		).then(async (first) => {
			let result = first;
			if (!result.ok && plainFallback && isTelegramParseError(result.error)) {
				// A formatting defect must not lose the reply: resend it once as plain text.
				this.reportError(
					"Telegram rejected HTML formatting; resending as plain text",
					result.error,
				);
				result = await this.telegramCall((signal) =>
					this.bot.api.sendMessage(
						chatId,
						plainFallback.text,
						plainFallback.other,
						signal,
					),
				);
			}
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
