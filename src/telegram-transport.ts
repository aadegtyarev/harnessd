import { createHash, randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { Bot } from "grammy";
import type {
	HarnessEffortCatalog,
	HarnessModelCatalog,
	HarnessModelChangeResult,
	HarnessModelInfo,
	HarnessSessionStatus,
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

const TELEGRAM_LIMIT = 4096;
const SEND_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 6000;
const MAX_QUEUED_MESSAGES = 32;
const MAX_OUTPUT_MESSAGES = 24;
const MAX_INPUT_MESSAGES = 8;
const MAX_QUEUED_CHARACTERS = 32_768;
const INPUT_CHARACTER_RESERVE = 4096;
const OUTPUT_COALESCE_MS = 40;
const OVERFLOW_NOTICE =
	"Additional notifications were omitted because the queue is full.";
const TELEGRAM_COMMANDS = [
	{ command: "help", description: "Show available commands." },
	{ command: "sessions", description: "List saved sessions." },
	{ command: "new", description: "Create a session, optionally in a folder." },
	{ command: "use", description: "Select a session by ID." },
	{ command: "resume", description: "Resume a stopped session." },
	{ command: "inspect", description: "Show a session's details." },
	{ command: "status", description: "Show the selected session's status." },
	{ command: "model", description: "List or select a model." },
	{ command: "effort", description: "List or set model effort." },
	{ command: "stop", description: "Stop a session." },
	{ command: "delete", description: "Delete a stopped session record." },
	{
		command: "cancel",
		description: "Cancel an input in the selected session.",
	},
] as const;

type UpdateContext = {
	from?: { id: number };
	chat?: { id: number; type: string };
	message?: { text?: string };
};
type TelegramBot = {
	api: {
		sendMessage(
			chatId: number,
			text: string,
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
	text: string;
	readonly output: boolean;
	readonly inputId?: string;
	inputState?: string;
	overflow?: true;
};
type ChatQueue = {
	readonly messages: QueuedMessage[];
	pendingCharacters: number;
	draining?: Promise<void>;
	drainTimer?: NodeJS.Timeout;
	failed: boolean;
	overflowQueued: boolean;
};

export interface TelegramTransportOptions {
	readonly token: string;
	readonly allowedUserIds: readonly number[];
	readonly stateDirectory: string;
	readonly defaultCwd: string;
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

function isCode(error: unknown, code: string): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === code
	);
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
function formatSession(session: SessionSummary): string {
	const cwd = [...oneLine(session.cwd)];
	const displayCwd =
		cwd.length > 600 ? `${cwd.slice(0, 599).join("")}…` : cwd.join("");
	return `<code>${escapeHtml(session.id)}</code> · ${escapeHtml(session.status)}\n${escapeHtml(displayCwd)}`;
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
function formatCount(value: number): string {
	return Math.round(value).toLocaleString("en-US");
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
		case "agent_start":
			return "Agent started.";
		case "agent_end":
			return "Agent finished.";
		case "agent_settled":
			return "Agent is waiting for input.";
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
			() => {
				clearTimeout(timer);
				reject(new Error("operation failed"));
			},
		);
	});
}

function parseNewWorkingDirectory(
	value: string | undefined,
	defaultCwd: string,
):
	| { readonly ok: true; readonly cwd: string }
	| { readonly ok: false; readonly error: string } {
	const candidate = value?.trim();
	if (!candidate) return { ok: true, cwd: defaultCwd };
	const quote = candidate[0];
	if (quote === '"' || quote === "'") {
		if (candidate.length < 2 || candidate.at(-1) !== quote)
			return {
				ok: false,
				error:
					"Use matching quotes around the entire path, or remove the quotes.",
			};
		const cwd = candidate.slice(1, -1);
		if (!cwd)
			return { ok: false, error: "Working directory path cannot be empty." };
		return { ok: true, cwd };
	}
	return { ok: true, cwd: candidate };
}

export class TelegramTransportAdapter implements TransportAdapter {
	readonly descriptor = {
		id: "telegram" as AdapterId,
		capabilities: ["transport.poll"] as const,
	};
	private readonly selected = new Map<number, SessionId>();
	private readonly queues = new Map<number, ChatQueue>();
	private readonly pendingSends = new Set<AbortController>();
	private readonly activeSends = new Set<Promise<boolean>>();
	private readonly bot: TelegramBot;
	private readonly authorized: Set<number>;
	private dispatch?: (event: TransportEvent) => Promise<TransportResult>;
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
	): Promise<void> {
		this.dispatch = dispatch;
		this.releaseLock = await acquireTelegramPollingLock(
			this.options.token,
			this.options.stateDirectory,
		);
		try {
			if (this.options.signal?.aborted)
				throw new Error("Telegram startup aborted");
			this.unsubscribe = subscribe((event) => this.onEvent(event));
			this.bot.use(async (ctx, next) => {
				if (this.isAuthorized(ctx)) await next();
			});
			this.bot.on("message:text", async (ctx) => this.onText(ctx));
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
				this.initializationPromise = this.bot
					.init(this.initializationAbort.signal)
					.then(
						() => ({ ok: true }),
						() => ({ ok: false }),
					);
				const initialized = await this.initializationPromise;
				if (!initialized.ok) throw new Error("Telegram initialization failed");
				try {
					await withDeadline(
						this.bot.api.setMyCommands(
							TELEGRAM_COMMANDS,
							{ scope: { type: "all_private_chats" } },
							this.initializationAbort.signal,
						),
						SEND_TIMEOUT_MS,
					);
				} catch {
					console.error("harnessd: Telegram command menu registration failed");
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
					() =>
						this.pollingEnded(failReady, new Error("Telegram polling failed")),
				);
				await readiness;
				if (this.options.signal?.aborted)
					throw new Error("Telegram startup aborted");
				this.ready = true;
			} finally {
				this.options.signal?.removeEventListener("abort", abortPolling);
			}
		} catch {
			try {
				await this.stop();
			} catch {
				/* lock is retained if shutdown cannot be confirmed */
			}
			throw new Error("Telegram transport could not start");
		}
	}

	private pollingEnded(failReady: (error: Error) => void, error: Error): void {
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

	stop(): Promise<void> {
		if (!this.stopPromise) this.stopPromise = this.stopPolling();
		return this.stopPromise;
	}

	private async stopPolling(): Promise<void> {
		this.stopping = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.initializationAbort?.abort();
		for (const controller of this.pendingSends) controller.abort();
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
		} catch {
			throw new Error("Telegram shutdown incomplete; polling lock retained");
		}
		if (this.releaseLock) {
			await this.releaseLock();
			this.releaseLock = undefined;
		}
	}

	private isAuthorized(ctx: UpdateContext): boolean {
		return (
			ctx.from !== undefined &&
			Number.isSafeInteger(ctx.from.id) &&
			ctx.from.id > 0 &&
			this.authorized.has(ctx.from.id) &&
			ctx.chat?.type === "private"
		);
	}

	private async onText(ctx: UpdateContext): Promise<void> {
		const chatId = ctx.chat?.id;
		const sender = ctx.from?.id;
		const text = ctx.message?.text;
		if (chatId === undefined || sender === undefined || text === undefined)
			return;
		try {
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
				await this.sendDirect(
					chatId,
					result.ok
						? `Input accepted: ${result.value as string}`
						: safeResultError(result.error),
				);
			}
		} catch {
			await this.sendDirect(
				chatId,
				"Request failed unexpectedly. Check the harnessd service journal.",
			);
		}
	}

	private async command(
		chatId: number,
		sender: number,
		raw: string,
	): Promise<void> {
		const newCommand = /^\/new(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(raw);
		if (newCommand) {
			const parsedCwd = parseNewWorkingDirectory(
				newCommand[1],
				this.options.defaultCwd,
			);
			if (!parsedCwd.ok) return this.sendDirect(chatId, parsedCwd.error);
			const result = await this.request(sender, {
				kind: "create",
				harnessId: "pi-rpc" as never,
				cwd: parsedCwd.cwd,
			});
			if (!result.ok) return this.sendDirect(chatId, result.error.message);
			const session = result.value as SessionSummary;
			this.selected.set(chatId, session.id);
			return this.sendDirect(chatId, `Created and selected ${session.id}.`);
		}
		const [command, ...args] = raw.trim().split(/\s+/);
		const name = command.split("@")[0];
		if (name === "/help" && args.length === 0)
			return this.sendDirect(
				chatId,
				"/sessions\n/new [cwd]\n/use <sessionId>\n/resume [sessionId]\n/inspect [sessionId]\n/status\n/model [provider/modelId [effort]]\n/effort [level]\n/stop [sessionId]\n/delete <sessionId>\n/cancel <inputId>\n/help",
			);
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
			this.selected.set(chatId, (result.value as SessionSummary).id);
			return this.sendDirect(
				chatId,
				`Selected ${(result.value as SessionSummary).id}.`,
			);
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
			return this.sendDirect(
				chatId,
				result.ok
					? `Session ${(result.value as SessionSummary).id} is running.`
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
			if (result.ok && this.selected.get(chatId) === sessionId)
				this.selected.delete(chatId);
			return this.sendDirect(
				chatId,
				result.ok ? `Session ${sessionId} stopped.` : result.error.message,
			);
		}
		if (name === "/delete") {
			if (args.length !== 1)
				return this.sendDirect(chatId, "Usage: /delete <sessionId>");
			const sessionId = args[0] as SessionId;
			const result = await this.request(sender, { kind: "delete", sessionId });
			if (result.ok) {
				for (const [selectedChat, selectedId] of this.selected) {
					if (selectedId === sessionId) this.selected.delete(selectedChat);
				}
			}
			return this.sendDirect(
				chatId,
				result.ok
					? `Deleted stopped session ${sessionId} from harnessd.`
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

	private request(
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

	private async sendDirect(chatId: number, text: string): Promise<void> {
		for (const chunk of chunks(text || " "))
			await this.sendWithDeadline(chatId, chunk);
	}

	private async sendDirectHtml(chatId: number, text: string): Promise<void> {
		for (const chunk of chunks(text || " "))
			await this.sendWithDeadline(chatId, chunk, { parse_mode: "HTML" });
	}

	private onEvent(event: HarnessEvent): void {
		let text: string | undefined;
		let output = false;
		let input: { readonly inputId: string; readonly state: string } | undefined;
		if (event.kind === "output" && typeof event.text === "string") {
			text = event.text;
			output = true;
		} else if (event.kind === "status") text = statusMessage(event.text);
		else if (event.kind === "error") text = "Session reported an error.";
		else if (event.kind === "input" && event.inputEvent) {
			const { inputId, state } = event.inputEvent;
			input = { inputId, state };
			text = `Input ${inputId}: ${state}${state === "uncertain" ? " (not resent)" : ""}`;
		}
		if (!text) return;
		for (const [chatId, sessionId] of this.selected) {
			if (sessionId === event.sessionId)
				this.enqueue(chatId, event.sessionId, text, output, input);
		}
	}

	private enqueue(
		chatId: number,
		sessionId: SessionId,
		text: string,
		output: boolean,
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
		const prefixLength = sessionId.length + 3;
		if (text.length + prefixLength > MAX_QUEUED_CHARACTERS) {
			this.queueOverflow(queue, sessionId);
			this.scheduleDrain(chatId, queue);
			return;
		}
		if (input) {
			this.enqueueInput(queue, sessionId, text, prefixLength, input);
			this.scheduleDrain(chatId, queue);
			return;
		}
		const parts = splitChunks(text, TELEGRAM_LIMIT - prefixLength);
		for (const part of parts) {
			const last = queue.messages.at(-1);
			if (
				output &&
				last?.output &&
				last.sessionId === sessionId &&
				!last.overflow &&
				last.text.length + part.length <= TELEGRAM_LIMIT - prefixLength
			) {
				last.text += part;
				queue.pendingCharacters += part.length;
				continue;
			}
			const outputCount = queue.messages.filter(
				(message) => !message.inputId && !message.overflow,
			).length;
			if (
				outputCount >= MAX_OUTPUT_MESSAGES ||
				queue.messages.length >= MAX_QUEUED_MESSAGES ||
				queue.pendingCharacters + part.length + prefixLength >
					MAX_QUEUED_CHARACTERS - INPUT_CHARACTER_RESERVE
			) {
				this.queueOverflow(queue, sessionId);
				continue;
			}
			queue.messages.push({ sessionId, text: part, output });
			queue.pendingCharacters += part.length + prefixLength;
		}
		this.scheduleDrain(chatId, queue);
	}

	private enqueueInput(
		queue: ChatQueue,
		sessionId: SessionId,
		text: string,
		prefixLength: number,
		input: { readonly inputId: string; readonly state: string },
	): void {
		const existingIndex = queue.messages.findIndex(
			(message) => message.inputId === input.inputId,
		);
		if (existingIndex >= 0) {
			const existing = queue.messages[existingIndex];
			if (!existing || existing.inputState === "uncertain") return;
			const [superseded] = queue.messages.splice(existingIndex, 1);
			if (superseded)
				queue.pendingCharacters -=
					superseded.text.length + superseded.sessionId.length + 3;
		}
		const messageCharacters = text.length + prefixLength;
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
				if (removed)
					queue.pendingCharacters -=
						removed.text.length + removed.sessionId.length + 3;
				this.queueOverflow(queue, sessionId);
				continue;
			}
			const replaceableInputIndex = queue.messages.findIndex(
				(message) => message.inputId && message.inputState !== "uncertain",
			);
			if (replaceableInputIndex >= 0) {
				const [removed] = queue.messages.splice(replaceableInputIndex, 1);
				if (removed)
					queue.pendingCharacters -=
						removed.text.length + removed.sessionId.length + 3;
				continue;
			}
			return;
		}
		queue.messages.push({
			sessionId,
			text,
			output: false,
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
			text: OVERFLOW_NOTICE,
			output: false,
			overflow: true as const,
		};
		queue.messages.push(notice);
		queue.pendingCharacters += notice.text.length + sessionId.length + 3;
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
			queue.pendingCharacters -=
				message.text.length + message.sessionId.length + 3;
			if (message.overflow) queue.overflowQueued = false;
			if (this.selected.get(chatId) !== message.sessionId) continue;
			const delivered = await this.sendWithDeadline(
				chatId,
				`[${message.sessionId}] ${message.text}`,
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
		if (this.stopping) return Promise.resolve(false);
		const sending = this.performSend(chatId, text, other);
		this.activeSends.add(sending);
		void sending.finally(() => this.activeSends.delete(sending));
		return sending;
	}

	private async performSend(
		chatId: number,
		text: string,
		other?: unknown,
	): Promise<boolean> {
		const controller = new AbortController();
		this.pendingSends.add(controller);
		try {
			await withDeadline(
				this.bot.api.sendMessage(chatId, text, other, controller.signal),
				SEND_TIMEOUT_MS,
			);
			return true;
		} catch {
			controller.abort();
			return false;
		} finally {
			this.pendingSends.delete(controller);
		}
	}
}
