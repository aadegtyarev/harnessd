import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportEvent, TransportResult } from "../src/core/ports.js";
import type {
	HarnessEvent,
	SessionId,
	SessionSummary,
} from "../src/core/types.js";
import { TelegramPanelStore } from "../src/telegram-panel-store.js";
import {
	acquireTelegramPollingLock,
	TelegramTransportAdapter,
	telegramLockPath,
} from "../src/telegram-transport.js";

const roots: string[] = [];
function telegramVisibleText(text: string): string {
	return text
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}
function telegramBody(text: string): string {
	const footerStart = text.lastIndexOf("\n\n");
	return telegramVisibleText(
		footerStart < 0 ? text : text.slice(0, footerStart),
	);
}
function hasSessionFooter(text: string, sessionId: string): boolean {
	const footerStart = text.lastIndexOf("\n\n");
	if (footerStart < 0) return false;
	const footer = text
		.slice(footerStart + 2)
		.replace(/<\/?code>/g, "")
		.replace(/ · \d+\/\d+$/, "");
	return footer === sessionId || footer.endsWith(` · ${sessionId}`);
}
async function temp() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "telegram-adapter-"));
	roots.push(dir);
	return dir;
}
function stubFileDownload() {
	const mock = vi.fn(async (_url: URL) => new Response(Buffer.from("hello")));
	vi.stubGlobal("fetch", mock);
	return mock;
}
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	await Promise.all(
		roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

type Context = {
	from?: { id: number };
	chat?: { id: number; type: string };
	message?: {
		text?: string;
		caption?: string;
		document?: { file_id: string; file_name?: string; file_size?: number };
		photo?: readonly {
			file_id: string;
			file_size?: number;
			width: number;
			height: number;
		}[];
		message_id?: number;
		reply_to_message?: { message_id: number; text?: string };
	};
	callbackQuery?: {
		id: string;
		data?: string;
		message?: { message_id: number };
	};
};
class MockBot {
	middleware?: (ctx: Context, next: () => Promise<void>) => Promise<void>;
	handler?: (ctx: Context) => Promise<void>;
	photoHandler?: (ctx: Context) => Promise<void>;
	callbackHandler?: (ctx: Context) => Promise<void>;
	sent: { chatId: number; text: string; message_id?: number }[] = [];
	get lastForceReplyMessageId(): number | undefined {
		const index = this.sendOptions.findLastIndex(
			(option) =>
				(option as { reply_markup?: { force_reply?: boolean } }).reply_markup
					?.force_reply,
		);
		return index < 0 ? undefined : this.sent[index]?.message_id;
	}
	reactions: { chatId: number; messageId: number; reaction: unknown }[] = [];
	setMessageReactionBehavior: () => Promise<unknown> = async () => true;
	sendMessageBehavior: () => Promise<void> = async () => {};
	editMessageBehavior: () => Promise<void> = async () => {};
	deleteMessageBehavior: () => Promise<void> = async () => {};
	nextMessageId = 1000;
	lastMessageId?: number;
	edited: {
		chatId: number;
		messageId: number;
		text: string;
		options?: unknown;
	}[] = [];
	pinned: { chatId: number; messageId: number }[] = [];
	sendOptions: unknown[] = [];
	commandRegistrations: {
		commands: readonly { command: string; description: string }[];
		other?: unknown;
	}[] = [];
	setMyCommandsBehavior: () => Promise<void> = async () => {};
	startCalled?: () => void;
	startResolve?: () => void;
	startReject?: (error: Error) => void;
	startOptions?: { onStart?: () => void };
	initCalled = false;
	initSignal?: AbortSignal;
	initBehavior: (signal?: AbortSignal) => Promise<void> = async () => {};
	stopCalls = 0;
	stopBehavior: () => Promise<void> = async () => {
		this.finishStart();
	};
	api = {
		sendMessage: vi.fn(
			async (
				chatId: number,
				text: string,
				_other?: unknown,
				_signal?: AbortSignal,
			): Promise<unknown> => {
				if (text.length > 4096) throw new Error("Telegram text limit exceeded");
				await this.sendMessageBehavior();
				const message_id = this.nextMessageId++;
				this.sent.push({ chatId, text, message_id });
				this.sendOptions.push(_other);
				this.lastMessageId = message_id;
				return { message_id };
			},
		),
		editMessageText: vi.fn(
			async (
				chatId: number,
				messageId: number,
				text: string,
				options?: unknown,
			) => {
				if (text.length > 4096) throw new Error("Telegram text limit exceeded");
				await this.editMessageBehavior();
				this.edited.push({ chatId, messageId, text, options });
				return { message_id: messageId };
			},
		),
		deleteMessage: vi.fn(async (_chatId: number, _messageId: number) => {
			await this.deleteMessageBehavior();
			return true;
		}),
		pinChatMessage: vi.fn(async (chatId: number, messageId: number) => {
			this.pinned.push({ chatId, messageId });
			return true;
		}),
		sendChatAction: vi.fn(async (_chatId: number) => true),
		sendDocument: vi.fn(
			async (
				_chatId: number,
				_document: unknown,
				_other?: unknown,
				_signal?: AbortSignal,
			) => true,
		),
		setMessageReaction: vi.fn(
			async (
				chatId: number,
				messageId: number,
				reaction: readonly { type: "emoji"; emoji: string }[],
			) => {
				this.reactions.push({ chatId, messageId, reaction });
				return this.setMessageReactionBehavior();
			},
		),
		answerCallbackQuery: vi.fn(async () => true),
		getFile: vi.fn(
			async (
				fileId: string,
			): Promise<{ file_path?: string; file_size?: number }> => ({
				file_path: `photos/${fileId}.jpg`,
				file_size: 5,
			}),
		),
		setMyCommands: vi.fn(
			async (
				commands: readonly { command: string; description: string }[],
				other?: unknown,
			) => {
				this.commandRegistrations.push({ commands, other });
				await this.setMyCommandsBehavior();
			},
		),
	};
	use(handler: (ctx: Context, next: () => Promise<void>) => Promise<void>) {
		this.middleware = handler;
	}
	on(filter: string, handler: (ctx: Context) => Promise<void>) {
		if (filter === "message:text") this.handler = handler;
		if (filter === "message:photo") this.photoHandler = handler;
		if (filter === "message:document") this.photoHandler = handler;
		if (filter === "callback_query:data") this.callbackHandler = handler;
	}
	init(signal?: AbortSignal): Promise<void> {
		this.initCalled = true;
		this.initSignal = signal;
		return this.initBehavior(signal);
	}
	start(options?: { onStart?: () => void }): Promise<void> {
		this.startOptions = options;
		this.startCalled?.();
		return new Promise<void>((resolve, reject) => {
			this.startResolve = resolve;
			this.startReject = reject;
		});
	}
	async stop(): Promise<void> {
		this.stopCalls++;
		await this.stopBehavior();
	}
	ready() {
		this.startOptions?.onStart?.();
	}
	finishStart() {
		this.startResolve?.();
	}
	failStart(error = new Error("secret raw polling error")) {
		this.startReject?.(error);
	}
	async update(
		chatId: number,
		text: string,
		options: {
			userId?: number;
			chatType?: string;
			missingSender?: boolean;
			replyToMessageId?: number;
			replyToMessageText?: string;
		} = {},
	) {
		const {
			userId = 42,
			chatType = "private",
			missingSender = false,
		} = options;
		const ctx: Context = {
			from: missingSender ? undefined : { id: userId },
			chat: { id: chatId, type: chatType },
			message: {
				text,
				message_id: this.nextMessageId++,
				...(options.replyToMessageId === undefined
					? {}
					: {
							reply_to_message: {
								message_id: options.replyToMessageId,
								text: options.replyToMessageText,
							},
						}),
			},
		};
		await this.middleware?.(ctx, async () => this.handler?.(ctx));
	}
	async updateDocument(
		chatId: number,
		options: {
			caption?: string;
			fileId?: string;
			fileName?: string;
			fileSize?: number;
			userId?: number;
			replyToMessageId?: number;
			replyToMessageText?: string;
		} = {},
	) {
		const ctx: Context = {
			from: { id: options.userId ?? 42 },
			chat: { id: chatId, type: "private" },
			message: {
				message_id: this.nextMessageId++,
				document: {
					file_id: options.fileId ?? "document-id",
					file_name: options.fileName ?? "notes.txt",
					...(options.fileSize === undefined
						? {}
						: { file_size: options.fileSize }),
				},
				...(options.caption ? { caption: options.caption } : {}),
				...(options.replyToMessageId === undefined
					? {}
					: {
							reply_to_message: {
								message_id: options.replyToMessageId,
								text: options.replyToMessageText,
							},
						}),
			},
		};
		await this.middleware?.(ctx, async () => this.photoHandler?.(ctx));
	}
	async updatePhoto(
		chatId: number,
		caption?: string,
		userId = 42,
		replyToMessageId?: number,
		replyToMessageText?: string,
	) {
		const ctx: Context = {
			from: { id: userId },
			chat: { id: chatId, type: "private" },
			message: {
				message_id: this.nextMessageId++,
				photo: [
					{
						file_id: "largest-photo-id",
						file_size: 5,
						width: 1600,
						height: 1200,
					},
					{
						file_id: "smaller-photo-id",
						file_size: 2,
						width: 320,
						height: 240,
					},
				],
				...(caption ? { caption } : {}),
				...(replyToMessageId === undefined
					? {}
					: {
							reply_to_message: {
								message_id: replyToMessageId,
								text: replyToMessageText,
							},
						}),
			},
		};
		await this.middleware?.(ctx, async () => this.photoHandler?.(ctx));
	}
	async callback(
		chatId: number,
		data: string,
		messageId = this.lastMessageId ?? 1,
		userId = 42,
		chatType: "private" | "group" = "private",
	) {
		const ctx: Context = {
			from: { id: userId },
			chat: { id: chatId, type: chatType },
			callbackQuery: {
				id: "callback-id",
				data,
				message: { message_id: messageId },
			},
		};
		await this.middleware?.(ctx, async () => this.callbackHandler?.(ctx));
	}
}
const sessions = new Map<string, SessionSummary>([
	[
		"sid",
		{
			id: "sid" as SessionId,
			harnessId: "pi-rpc" as never,
			cwd: "/work",
			status: "running",
		},
	],
	[
		"other",
		{
			id: "other" as SessionId,
			harnessId: "pi-rpc" as never,
			cwd: "/other",
			status: "running",
		},
	],
]);
const initialSessions = [...sessions];
function sessionWith(
	id: string,
	updates: Partial<SessionSummary>,
): SessionSummary {
	const session = sessions.get(id);
	if (!session) throw new Error(`Missing session fixture: ${id}`);
	return { ...session, ...updates };
}
beforeEach(() => {
	sessions.clear();
	for (const [id, session] of initialSessions) sessions.set(id, session);
});
function result(request: TransportEvent): TransportResult {
	let value: Extract<TransportResult, { readonly ok: true }>["value"];
	switch (request.kind) {
		case "list":
			value = [...sessions.values()];
			break;
		case "inspect": {
			const inspected = sessions.get(request.sessionId);
			if (!inspected)
				return {
					requestId: request.requestId,
					ok: false,
					error: {
						code: "SESSION_NOT_FOUND",
						message: "Session was not found",
					},
				};
			value = inspected;
			break;
		}
		case "create":
			value = sessions.get("sid");
			break;
		case "resume":
			value = sessions.get(request.sessionId);
			break;
		case "rename": {
			const session = sessions.get(request.sessionId);
			if (!session)
				return {
					requestId: request.requestId,
					ok: false,
					error: {
						code: "SESSION_NOT_FOUND",
						message: "Session was not found",
					},
				};
			value = {
				...session,
				...(request.name === undefined ? {} : { name: request.name }),
			};
			break;
		}
		case "submit":
			value = "input-1" as never;
			break;
		case "session_status": {
			const session = sessions.get(request.sessionId);
			if (!session)
				return {
					requestId: request.requestId,
					ok: false,
					error: {
						code: "SESSION_NOT_FOUND",
						message: "Session was not found",
					},
				};
			value = {
				session,
				live: {
					model: { provider: "openai", id: "gpt-test", name: "Test" },
					effort: "medium",
					usage: {
						totalTokens: 1234,
						costUsd: 0.125,
						contextTokens: 145_000,
						contextWindow: 272_000,
						contextPercent: 53.3,
					},
				},
			};
			break;
		}
		case "model_list":
			value = {
				models: [{ provider: "openai", id: "gpt-test", name: "Test" }],
				current: { provider: "openai", id: "gpt-test", name: "Test" },
			};
			break;
		case "model_set":
			value = {
				model: {
					provider: request.provider,
					id: request.modelId,
					name: request.modelId,
				},
				...(request.effort !== undefined
					? { effort: request.effort, effortConfirmed: true }
					: {}),
			};
			break;
		case "effort_list":
			value = { levels: ["low", "medium", "high"], current: "medium" };
			break;
		case "effort_set":
			value = undefined;
			break;
		case "delete":
			sessions.delete(request.sessionId);
			value = undefined;
			break;
		default:
			value = undefined;
	}
	return { requestId: request.requestId, ok: true, value };
}
function harnessEvent(
	sessionId: string,
	kind: HarnessEvent["kind"],
	text?: string,
): HarnessEvent {
	return {
		sessionId: sessionId as SessionId,
		kind,
		...(text === undefined ? {} : { text }),
	};
}
async function startAdapter(
	bot: MockBot,
	dir: string,
	extras: {
		signal?: AbortSignal;
		onFatal?: () => void;
		initialCwd?: string;
		dispatch?: (request: TransportEvent) => Promise<TransportResult>;
	} = {},
) {
	let listener: ((event: HarnessEvent) => unknown) | undefined;
	let subscribed = false;
	const requests: TransportEvent[] = [];
	const adapter = new TelegramTransportAdapter({
		token: "secret-token",
		allowedUserIds: [42],
		stateDirectory: dir,
		initialCwd: extras.initialCwd ?? "/work",
		botFactory: () => bot as never,
		...extras,
	});
	const started = adapter.start(
		async (request) => {
			requests.push(request);
			return (await extras.dispatch?.(request)) ?? result(request);
		},
		(subscribe) => {
			listener = subscribe;
			subscribed = true;
			return () => {
				listener = undefined;
				subscribed = false;
			};
		},
		async () => [...sessions.values()],
	);
	await vi.waitFor(() => expect(bot.startOptions).toBeDefined());
	bot.ready();
	await started;
	return {
		adapter,
		requests,
		emit: (event: HarnessEvent) => listener?.(event),
		isSubscribed: () => subscribed,
	};
}

function callbackData(options: unknown, prefix: string): string {
	const markup = options as {
		reply_markup?: {
			inline_keyboard?: readonly (readonly { callback_data?: string }[])[];
		};
	};
	const found = markup.reply_markup?.inline_keyboard
		?.flat()
		.find((button) => button.callback_data?.startsWith(prefix))?.callback_data;
	if (!found) throw new Error(`Missing callback data with prefix ${prefix}`);
	return found;
}

describe("Telegram transport", () => {
	it("shows session name and full identity with Pi-reported context in status", async () => {
		sessions.set("sid", sessionWith("sid", { name: "Focused task" }));
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/status");
		expect(
			bot.sent.some(({ text }) =>
				text.includes("Context: 53.3%/145k/272k (auto)"),
			),
		).toBe(true);
		expect(bot.sent.at(-1)?.text).toContain("Session: Focused task · sid");
		await adapter.stop();
	});

	it("labels an input sent during an active run as queued rather than started", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "status", "agent_start"));
		await bot.update(42, "queue this input");
		await vi.waitFor(() =>
			expect(
				bot.edited.some(({ text }) => text.includes("Input input-1: queued")),
			).toBe(true),
		);
		expect(bot.edited.some(({ text }) => text.includes("В очереди Pi"))).toBe(
			true,
		);
		expect(
			bot.edited.some(({ text }) => text.includes("Pi выполняет ход сессии")),
		).toBe(false);
		await adapter.stop();
	});

	it("reacts to the source message only after Pi accepts the input", async () => {
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		const sourceMessageId = bot.nextMessageId;
		await bot.update(42, "do the task");
		await vi.waitFor(() => expect(bot.reactions).toHaveLength(1));
		expect(bot.reactions).toEqual([
			{
				chatId: 42,
				messageId: sourceMessageId,
				reaction: [{ type: "emoji", emoji: "👀" }],
			},
		]);
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Input input-1: accepted"),
		);
		await adapter.stop();
	});

	it("deletes activity after Pi reports a handled input complete without an agent_settled event", async () => {
		const bot = new MockBot();
		let emitInput: ((event: HarnessEvent) => void) | undefined;
		const { adapter, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "submit") {
					emitInput?.({
						sessionId: request.sessionId,
						kind: "input",
						inputEvent: {
							inputId: "input-1" as never,
							state: "accepted",
						},
					});
					emitInput?.({
						sessionId: request.sessionId,
						kind: "input",
						inputEvent: {
							inputId: "input-1" as never,
							state: "completed",
						},
					});
				}
				return result(request);
			},
		});
		emitInput = emit;
		await bot.update(42, "/use sid");
		await bot.update(42, "Handle this command");
		await vi.waitFor(() =>
			expect(bot.api.deleteMessage).toHaveBeenCalledOnce(),
		);
		expect(bot.sent.some(({ text }) => text.includes("Pi activity"))).toBe(
			true,
		);
		await adapter.stop();
	});

	it("retains an uncertain InputId when later completed inputs exceed the display history", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "Do not resend this");
		emit(harnessEvent("sid", "status", "agent_start"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "uncertain" },
		});
		for (let index = 2; index <= 10; index++)
			emit({
				sessionId: "sid" as SessionId,
				kind: "input",
				inputEvent: {
					inputId: `input-${index}` as never,
					state: "completed",
				},
			});
		emit(harnessEvent("sid", "status", "agent_settled"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(bot.api.deleteMessage).not.toHaveBeenCalled();
		expect(
			bot.edited.some(({ text }) =>
				text.includes("Input input-1: uncertain (not resent)"),
			),
		).toBe(true);
		await adapter.stop();
	});

	it("retains an untracked uncertain input after a large run settles", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "large queued batch");
		emit(harnessEvent("sid", "status", "agent_start"));
		for (let index = 2; index <= 180; index++)
			emit({
				sessionId: "sid" as SessionId,
				kind: "input",
				inputEvent: {
					inputId: `input-${index}` as never,
					state: "pending",
				},
			});
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-180" as never, state: "uncertain" },
		});
		emit(harnessEvent("sid", "status", "agent_settled"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(bot.api.deleteMessage).not.toHaveBeenCalled();
		expect(
			bot.edited.some(({ text }) =>
				text.includes("Input input-180: uncertain (not resent)"),
			),
		).toBe(true);
		await adapter.stop();
	});

	it("keeps the acceptance reply if Telegram cannot add the eye reaction", async () => {
		const bot = new MockBot();
		bot.setMessageReactionBehavior = async () => {
			throw new Error("reaction API unavailable");
		};
		const journal = vi.spyOn(console, "error").mockImplementation(() => {});
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "do the task");
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Input input-1: accepted"),
		);
		await vi.waitFor(() => expect(journal).toHaveBeenCalled());
		expect(journal.mock.calls.flat().join(" ")).toContain(
			"Telegram input acceptance reaction failed",
		);
		await adapter.stop();
	});

	it("edits one reply bubble with Pi tool activity, sends the final answer separately, then deletes the bubble", async () => {
		sessions.set("sid", sessionWith("sid", { name: "Review task" }));
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		const sourceMessageId = bot.nextMessageId;
		await bot.update(42, "Run the requested checks");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain(
				"Pi activity · Review task · sid",
			),
		);
		const bubbleId = bot.lastMessageId;
		emit(harnessEvent("sid", "status", "agent_start"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "tool_start",
				toolCallId: "tool-1",
				summary: "bash: npm test",
			},
		});
		await vi.waitFor(() =>
			expect(
				bot.edited.some(({ text }) => text.includes("bash: npm test …")),
			).toBe(true),
		);
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: { type: "tool_end", toolCallId: "tool-1", failed: false },
		});
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "tool_start",
				toolCallId: "tool-2",
				summary: "grep: secret token",
			},
		});
		await vi.waitFor(() =>
			expect(
				bot.edited.some(({ text }) => text.includes("grep: secret token …")),
			).toBe(true),
		);
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: { type: "tool_end", toolCallId: "tool-2", failed: true },
		});
		emit(harnessEvent("sid", "output", "All checks passed."));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "completed" },
		});
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(bot.api.deleteMessage).toHaveBeenCalledOnce(),
		);
		expect(bot.api.sendMessage).toHaveBeenCalledWith(
			42,
			expect.stringContaining("Pi activity"),
			expect.objectContaining({
				reply_parameters: { message_id: sourceMessageId },
			}),
			expect.anything(),
		);
		expect(
			bot.edited.some(({ text }) => text.includes("bash: npm test ✓")),
		).toBe(true);
		expect(
			bot.edited.some(({ text }) => text.includes("grep: secret token ❌")),
		).toBe(true);
		expect(
			bot.edited.some(({ text }) => text.includes("53.3%/145k/272k (auto)")),
		).toBe(true);
		expect(bot.api.deleteMessage).toHaveBeenCalledWith(
			42,
			bubbleId,
			expect.anything(),
		);
		const answer = bot.sent.find(({ text }) =>
			text.includes("All checks passed."),
		);
		expect(answer?.text).toContain("All checks passed.");
		expect(answer?.text).not.toContain("Pi activity");
		await adapter.stop();
	});

	it("bounds input history and reconciles overflow at run settlement", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "process a large queued batch");
		for (let index = 1; index <= 180; index++)
			emit({
				sessionId: "sid" as SessionId,
				kind: "input",
				inputEvent: {
					inputId: `input-${index}` as never,
					state: "pending",
				},
			});
		emit(harnessEvent("sid", "status", "agent_settled"));
		for (let index = 1; index <= 180; index++)
			emit({
				sessionId: "sid" as SessionId,
				kind: "input",
				inputEvent: {
					inputId: `input-${index}` as never,
					state: "completed",
				},
			});
		await vi.waitFor(() =>
			expect(bot.api.deleteMessage).toHaveBeenCalledOnce(),
		);
		expect((bot.edited.at(-1)?.text.length ?? 0) < 4096).toBe(true);
		await adapter.stop();
	});

	it("keeps activity tracking for an older session while a chat works in another session", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "first session task");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		const firstBubble = bot.lastMessageId;
		await bot.update(42, "/use other");
		await bot.update(42, "second session task");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		const secondBubble = bot.lastMessageId;
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "notification",
				text: "first session still active",
			},
		});
		await vi.waitFor(() =>
			expect(
				bot.edited.some(
					({ messageId, text }) =>
						messageId === firstBubble &&
						text.includes("first session still active"),
				),
			).toBe(true),
		);
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "completed" },
		});
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(bot.api.deleteMessage).toHaveBeenCalledWith(
				42,
				firstBubble,
				expect.anything(),
			),
		);
		expect(bot.api.deleteMessage).not.toHaveBeenCalledWith(
			42,
			secondBubble,
			expect.anything(),
		);
		await adapter.stop();
	});

	it("does not retry an activity-bubble send after an uncertain Telegram outcome", async () => {
		const bot = new MockBot();
		const journal = vi.spyOn(console, "error").mockImplementation(() => {});
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		bot.sendMessageBehavior = async () => {
			throw new Error("Telegram send timed out");
		};
		await bot.update(42, "Run this once");
		await vi.waitFor(() => expect(journal).toHaveBeenCalled());
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: { type: "notification", text: "still working" },
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			bot.api.sendMessage.mock.calls.filter(([, text]) =>
				String(text).includes("Pi activity"),
			),
		).toHaveLength(1);
		journal.mockRestore();
		await adapter.stop();
	});

	it("logs a safe diagnostic when final assistant output cannot be delivered", async () => {
		const bot = new MockBot();
		const journal = vi.spyOn(console, "error").mockImplementation(() => {});
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "Run this once");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		bot.sendMessageBehavior = async () => {
			if (
				String(bot.api.sendMessage.mock.calls.at(-1)?.[1]).includes(
					"Visible answer",
				)
			)
				throw new Error("Telegram rejected the message");
		};
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "Visible answer"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "completed" },
		});
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Ответ не удалось доставить"),
		);
		expect(journal.mock.calls.flat().join(" ")).toContain(
			"Telegram message delivery failed",
		);
		expect(journal.mock.calls.flat().join(" ")).toContain(
			"Telegram rejected the message",
		);
		journal.mockRestore();
		await adapter.stop();
	});

	it("does not retry an activity edit after an uncertain Telegram outcome", async () => {
		const bot = new MockBot();
		const journal = vi.spyOn(console, "error").mockImplementation(() => {});
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		bot.editMessageBehavior = async () => {
			throw new Error("Telegram edit timed out");
		};
		await bot.update(42, "Run this once");
		await vi.waitFor(() => expect(journal).toHaveBeenCalled());
		emit(harnessEvent("sid", "status", "agent_start"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(bot.api.editMessageText).toHaveBeenCalledOnce();
		expect(
			bot.api.sendMessage.mock.calls.filter(([, text]) =>
				String(text).includes("Pi activity"),
			),
		).toHaveLength(1);
		journal.mockRestore();
		await adapter.stop();
	});

	it("keeps a failed deletion from resending the final answer", async () => {
		const bot = new MockBot();
		const journal = vi.spyOn(console, "error").mockImplementation(() => {});
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "Run this once");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		bot.deleteMessageBehavior = async () => {
			throw new Error("Telegram delete timed out");
		};
		emit(harnessEvent("sid", "output", "Only once"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "completed" },
		});
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(bot.api.deleteMessage).toHaveBeenCalledOnce(),
		);
		emit(harnessEvent("sid", "status", "agent_settled"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			bot.sent.filter(({ text }) => text.includes("Only once")),
		).toHaveLength(1);
		expect(journal).toHaveBeenCalled();
		journal.mockRestore();
		await adapter.stop();
	});

	it("shows the runtime's safe operation reference in Telegram", async () => {
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp(), {
			dispatch: async (request) =>
				request.kind === "submit"
					? {
							requestId: request.requestId,
							ok: false,
							error: {
								code: "OPERATION_FAILED",
								message:
									"Operation failed (ref deadbeef)\n\nError: unsafe <detail> secret-token Authorization: Bearer abc123-private\n    at test.ts:1:1",
							},
						}
					: result(request),
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "hello");
		expect(bot.sent.at(-1)?.text).toContain(
			"<pre><code>Operation failed (ref deadbeef)",
		);
		expect(bot.sent.at(-1)?.text).toContain("unsafe &lt;detail&gt;");
		expect(bot.reactions).toEqual([]);
		expect(bot.sent.at(-1)?.text).not.toContain("secret-token");
		expect(bot.sent.at(-1)?.text).not.toContain("abc123-private");
		expect(bot.sent.at(-1)?.text).not.toContain("Bearer");
		expect(bot.sendOptions.at(-1)).toEqual({ parse_mode: "HTML" });
		await adapter.stop();
	});

	it("creates one pinned panel, browses sessions, selects explicitly, and guards callbacks", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		expect(panelMessageId).toBeDefined();
		expect(bot.pinned).toEqual([{ chatId: 42, messageId: panelMessageId }]);
		expect(bot.sent.at(-1)?.text).toContain(
			"Выбрана (обычные сообщения →): не выбрана",
		);
		await bot.update(42, "/menu");
		expect(bot.api.editMessageText).toHaveBeenCalledOnce();
		expect(bot.api.pinChatMessage).toHaveBeenCalledOnce();

		await bot.callback(42, "session:next", panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain("Просмотр: #other");
		expect(bot.edited.at(-1)?.text).toContain(
			"Выбрана (обычные сообщения →): не выбрана",
		);
		await bot.callback(42, "session:choose", panelMessageId);
		await bot.update(42, "/model");
		expect(requests.at(-1)).toMatchObject({
			kind: "model_list",
			sessionId: "other",
		});
		await bot.callback(42, "menu:models", panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain("Модель просмотра · other");
		await bot.callback(42, "model:select:0", panelMessageId);
		expect(
			requests.some(
				(request) =>
					request.kind === "model_set" && request.sessionId === "other",
			),
		).toBe(true);

		const callsBeforeUnauthorized = requests.length;
		const answersBeforeUnauthorized =
			bot.api.answerCallbackQuery.mock.calls.length;
		await bot.callback(42, "session:prev", panelMessageId, 7);
		expect(requests).toHaveLength(callsBeforeUnauthorized);
		expect(bot.api.answerCallbackQuery).toHaveBeenCalledTimes(
			answersBeforeUnauthorized,
		);
		await bot.callback(42, "session:select:missing", panelMessageId);
		await bot.callback(42, "session:select:bad/id", panelMessageId);
		await bot.callback(42, "session:select:sid", panelMessageId, 42, "group");
		expect(requests).toHaveLength(callsBeforeUnauthorized);
		await adapter.stop();
	});

	it("distinguishes similarly named sessions by short ID and marks selection", async () => {
		sessions.set("sid", sessionWith("sid", { name: "Shared name" }));
		sessions.set("other", sessionWith("other", { name: "Shared name" }));
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/sessions");
		const text = bot.sent.at(-1)?.text ?? "";
		expect(text).toContain("✓ Shared name · #sid · running · /work");
		expect(text).toContain("Shared name · #other · running · /other");
		await adapter.stop();
	});

	it("clears the selected label after a successful list omits the session", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		sessions.delete("sid");
		await bot.update(42, "/menu");
		const panelText = bot.edited.at(-1)?.text ?? bot.sent.at(-1)?.text ?? "";
		expect(panelText).toContain("Выбрана (обычные сообщения →): не выбрана");
		expect(panelText).not.toContain("Выбрана (обычные сообщения →): #sid");
		await bot.update(42, "must not submit to the removed session");
		expect(requests.at(-1)?.kind).not.toBe("submit");
		await adapter.stop();
	});

	it("truncates compact cwd without splitting Unicode code points", async () => {
		sessions.set(
			"sid",
			sessionWith("sid", { cwd: `${"a".repeat(3)}😀${"b".repeat(69)}` }),
		);
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/sessions");
		expect(bot.sent.at(-1)?.text).toContain("😀");
		expect(
			[...(bot.sent.at(-1)?.text ?? "")].some(
				(character) =>
					character.length === 1 &&
					character.charCodeAt(0) >= 0xdc00 &&
					character.charCodeAt(0) <= 0xdfff,
			),
		).toBe(false);
		await adapter.stop();
	});

	it("preserves the selected session after a transient panel list failure", async () => {
		const bot = new MockBot();
		const stateDirectory = await temp();
		let failList = false;
		const { adapter, requests } = await startAdapter(bot, stateDirectory, {
			dispatch: async (request) => {
				if (failList && request.kind === "list") {
					failList = false;
					return {
						requestId: request.requestId,
						ok: false,
						error: {
							code: "INTERNAL_ERROR",
							message: "Temporary list failure",
						},
					};
				}
				return result(request);
			},
		});
		await bot.update(42, "/use sid");
		failList = true;
		await bot.update(42, "/menu");
		expect(bot.sent.at(-1)?.text).toContain("Temporary list failure");
		expect(bot.sent.at(-1)?.text).toContain(
			"Выбрана (обычные сообщения →): #sid",
		);
		await bot.update(42, "still for selected");
		expect(requests.at(-1)).toMatchObject({ kind: "submit", sessionId: "sid" });
		await adapter.stop();
		const restartedBot = new MockBot();
		const restarted = await startAdapter(restartedBot, stateDirectory);
		await restartedBot.update(42, "still selected after restart");
		expect(restarted.requests.at(-1)).toMatchObject({
			kind: "submit",
			sessionId: "sid",
		});
		await restarted.adapter.stop();
	});

	it("targets preview controls independently from the selected session", async () => {
		sessions.set("other", sessionWith("other", { status: "stopped" }));
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		await bot.callback(42, "session:next", panelMessageId);
		const panel = bot.edited.at(-1)?.text ?? "";
		expect(panel).toContain("Выбрана (обычные сообщения →): #sid");
		expect(panel).toContain("Просмотр: #other");
		await bot.callback(42, "menu:models", panelMessageId);
		expect(requests.at(-1)).toMatchObject({
			kind: "model_list",
			sessionId: "other",
		});
		await bot.callback(42, "model:select:0", panelMessageId);
		expect(
			requests.findLast((request) => request.kind === "model_set"),
		).toMatchObject({ kind: "model_set", sessionId: "other" });
		await bot.callback(42, "menu:efforts", panelMessageId);
		expect(requests.at(-1)).toMatchObject({
			kind: "effort_list",
			sessionId: "other",
		});
		await bot.callback(42, "effort:select:0", panelMessageId);
		expect(
			requests.findLast((request) => request.kind === "effort_set"),
		).toMatchObject({ kind: "effort_set", sessionId: "other" });
		await bot.callback(42, "session:resume:other", panelMessageId);
		expect(
			requests.findLast((request) => request.kind === "resume"),
		).toMatchObject({
			kind: "resume",
			sessionId: "other",
		});
		await bot.callback(42, "session:stop:other", panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain("Остановить #other?");
		const stopConfirm = callbackData(
			bot.edited.at(-1)?.options,
			"action:confirm:",
		);
		await bot.callback(42, stopConfirm, panelMessageId);
		expect(
			requests.findLast((request) => request.kind === "stop"),
		).toMatchObject({ kind: "stop", sessionId: "other" });
		await bot.callback(42, "session:delete:other", panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain("Удалить запись #other?");
		const deleteConfirm = callbackData(
			bot.edited.at(-1)?.options,
			"action:confirm:",
		);
		await bot.callback(42, deleteConfirm, panelMessageId);
		expect(
			requests.findLast((request) => request.kind === "delete"),
		).toMatchObject({
			kind: "delete",
			sessionId: "other",
		});
		await bot.update(42, "still selected sid");
		expect(requests.at(-1)).toMatchObject({ kind: "submit", sessionId: "sid" });
		await adapter.stop();
	});

	it("invalidates deleted previews and cached controls across chats", async () => {
		sessions.set("other", sessionWith("other", { status: "stopped" }));
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(43, "/use sid");
		await bot.update(43, "/menu");
		const stalePanelId = bot.lastMessageId;
		await bot.callback(43, "session:next", stalePanelId);
		await bot.callback(43, "menu:models", stalePanelId);
		await bot.callback(43, "menu:efforts", stalePanelId);
		await bot.update(42, "/delete other");
		const afterDeletion = requests.length;
		for (const data of [
			"model:select:0",
			"effort:select:0",
			"session:resume:other",
			"session:stop:other",
			"session:delete:other",
			"action:confirm-delete:other",
		]) {
			await bot.callback(43, data, stalePanelId);
		}
		expect(requests.slice(afterDeletion)).toEqual([]);
		expect(
			requests.some(
				(request) => request.kind === "delete" && request.sessionId === "other",
			),
		).toBe(true);
		await adapter.stop();
	});

	it("shows the exact new-session folder in the creation prompt", async () => {
		const directory = await temp();
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp(), {
			initialCwd: directory,
		});
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		expect(bot.sent.at(-1)?.text).toContain(`папка создания: ${directory}`);
		await bot.callback(42, "menu:new", panelMessageId);
		expect(bot.sent.at(-1)?.text).toContain(
			`New session will be created in ${directory}`,
		);
		await adapter.stop();
	});

	it("preserves repeated spaces and escapes controls in creation paths", async () => {
		const cwd = "/work/repeated  spaces/line\nbreak\\t\tend";
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			initialCwd: cwd,
		});
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		expect(bot.sent.at(-1)?.text).toContain("repeated  spaces");
		await bot.callback(42, "menu:new", panelMessageId);
		const prompt = bot.sent.at(-1)?.text ?? "";
		expect(prompt).toContain("repeated  spaces");
		expect(prompt).toContain("\\u{000A}");
		expect(prompt).toContain("\\u{0009}");
		expect(prompt).toContain("\\\\t");
		await bot.update(42, "/skip", { replyToMessageId: bot.lastMessageId });
		expect(requests.find((request) => request.kind === "create")).toMatchObject(
			{
				cwd,
			},
		);
		await adapter.stop();
	});

	it("bounds panel and ForceReply text while presenting the full long creation path", async () => {
		const cwd = `/work/${"segment  ".repeat(700)}`;
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp(), {
			initialCwd: cwd,
		});
		await bot.update(42, "/menu");
		expect(bot.sent.at(-1)?.text.length).toBeLessThanOrEqual(4096);
		const panelMessageId = bot.lastMessageId;
		await bot.callback(42, "menu:new", panelMessageId);
		const pathMessages = bot.sent.slice(1, -1).map((message) => message.text);
		expect(pathMessages.join("")).toContain(cwd);
		expect(bot.sent.every((message) => message.text.length <= 4096)).toBe(true);
		expect(bot.sendOptions.at(-1)).toMatchObject({
			reply_markup: { force_reply: true, selective: true },
		});
		expect(bot.sent.at(-1)?.text.length).toBeLessThanOrEqual(4096);
		await adapter.stop();
	});

	it("presents diagnostic-looking creation path chunks literally and creates the exact cwd", async () => {
		const marker = "Invalid api_key=folder/";
		const cwd = `/${"a".repeat(2999)}${marker}${"x".repeat(1000)}`;
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			initialCwd: cwd,
		});
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		await bot.callback(42, "menu:new", panelMessageId);
		const pathChunks = bot.sent
			.map((message) => message.text)
			.filter(
				(text) =>
					text.startsWith("/") || text.startsWith("Invalid api_key=folder"),
			);
		expect(pathChunks[1]).toMatch(/^Invalid api_key=folder/);
		expect(pathChunks.join("")).toBe(cwd);
		await bot.update(42, "/skip", { replyToMessageId: bot.lastMessageId });
		expect(requests.find((request) => request.kind === "create")).toMatchObject(
			{
				cwd,
			},
		);
		await adapter.stop();
	});

	it("browses folders and creates a named session in the selected folder", async () => {
		const directory = await temp();
		const childDirectory = path.join(directory, "child folder");
		await mkdir(childDirectory);
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			initialCwd: directory,
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		await bot.callback(42, "menu:folders", panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain(directory);
		const folderCallback = callbackData(bot.edited.at(-1)?.options, "folder:");
		expect(folderCallback.length).toBeLessThanOrEqual(64);
		await mkdir(path.join(directory, "a inserted later"));
		await bot.callback(42, folderCallback, panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain(childDirectory);
		await bot.callback(42, folderCallback, panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain("действие устарело");
		expect(bot.edited.at(-1)?.text).not.toContain("Папки\n");
		await bot.update(42, "/inspect");
		expect(requests.at(-1)).toMatchObject({
			kind: "inspect",
			sessionId: "sid",
		});
		expect(bot.sent.at(-1)?.text).toContain("/work");
		await bot.callback(42, "folder:new", panelMessageId);
		expect(bot.sent.at(-1)?.text).toContain(
			`New session will be created in ${childDirectory}`,
		);
		const promptMessageId = bot.lastMessageId;
		await bot.update(42, "nested task", { replyToMessageId: promptMessageId });
		expect(requests.find((request) => request.kind === "create")).toMatchObject(
			{
				cwd: childDirectory,
				name: "nested task",
			},
		);
		await adapter.stop();
	});

	it("renames and clears the selected session using the slash command", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/rename other Explicit target");
		expect(requests.at(-1)).toMatchObject({
			kind: "rename",
			sessionId: "other",
			name: "Explicit target",
		});
		await bot.update(42, "/rename A name with spaces");
		expect(requests.at(-1)).toMatchObject({
			kind: "rename",
			sessionId: "sid",
			name: "A name with spaces",
		});
		await bot.update(42, "/rename --clear");
		expect(requests.at(-1)).toMatchObject({ kind: "rename", sessionId: "sid" });
		expect(requests.at(-1)).not.toHaveProperty("name");
		await adapter.stop();
	});

	it("invalidates stop confirmation across stop and resume", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		await bot.callback(42, "menu:sessions", panelMessageId);
		await bot.callback(42, "session:details:sid", panelMessageId);
		await bot.callback(42, "session:stop:sid", panelMessageId);
		const confirm = callbackData(bot.edited.at(-1)?.options, "action:confirm:");
		await bot.update(42, "/stop sid");
		await bot.update(42, "/resume sid");
		const stopsBeforeStaleTap = requests.filter(
			(request) => request.kind === "stop",
		).length;
		await bot.callback(42, confirm, panelMessageId);
		expect(requests.filter((request) => request.kind === "stop")).toHaveLength(
			stopsBeforeStaleTap,
		);
		expect(bot.edited.at(-1)?.text).toContain("устарело");
		await adapter.stop();
	});

	it("requires confirmation before callback stop and delete operations", async () => {
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "status", "agent_start"));
		await vi.waitFor(() => expect(bot.api.sendChatAction).toHaveBeenCalled());
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		await bot.callback(42, "menu:sessions", panelMessageId);
		await bot.callback(42, "session:details:sid", panelMessageId);
		await bot.callback(42, "session:stop:sid", panelMessageId);
		expect(requests.some((request) => request.kind === "stop")).toBe(false);
		expect(bot.edited.at(-1)?.text).toContain("Остановить #sid?");
		await bot.callback(42, "action:cancel", panelMessageId);
		await bot.callback(42, "session:details:sid", panelMessageId);
		await bot.callback(42, "session:delete:sid", panelMessageId);
		expect(bot.edited.at(-1)?.text).toBe(
			"Удалить запись #sid? Будут удалены запись harnessd и полученные вложения во входящих; файлы в рабочей папке и файлы Pi останутся.",
		);
		expect(requests.some((request) => request.kind === "delete")).toBe(false);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const canceledToken = callbackData(
			bot.edited.at(-1)?.options,
			"action:confirm:",
		);
		await bot.callback(42, "action:cancel", panelMessageId);
		await bot.callback(42, canceledToken, panelMessageId);
		expect(requests.some((request) => request.kind === "delete")).toBe(false);
		await bot.callback(42, "session:details:sid", panelMessageId);
		await bot.callback(42, "session:delete:sid", panelMessageId);
		const deleteToken = callbackData(
			bot.edited.at(-1)?.options,
			"action:confirm:",
		);
		await bot.callback(43, deleteToken, panelMessageId);
		expect(requests.some((request) => request.kind === "delete")).toBe(false);
		await bot.callback(42, deleteToken, panelMessageId);
		expect(clearIntervalSpy).toHaveBeenCalled();
		clearIntervalSpy.mockRestore();
		expect(requests.some((request) => request.kind === "delete")).toBe(true);
		const requestsAfterDelete = requests.length;
		await bot.callback(42, deleteToken, panelMessageId);
		await bot.callback(42, "session:details:sid", panelMessageId);
		expect(requests).toHaveLength(requestsAfterDelete);
		await adapter.stop();
	});

	it("does not dispatch a stop when a lifecycle event invalidates an in-flight confirmation", async () => {
		const bot = new MockBot();
		let deferInspect = false;
		let releaseInspect!: () => void;
		let inspectStarted!: () => void;
		const started = new Promise<void>((resolve) => (inspectStarted = resolve));
		const gate = new Promise<void>((resolve) => (releaseInspect = resolve));
		const { adapter, requests, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (deferInspect && request.kind === "inspect") {
					inspectStarted();
					await gate;
				}
				return result(request);
			},
		});
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		await bot.callback(42, "menu:sessions", panelMessageId);
		await bot.callback(42, "session:details:sid", panelMessageId);
		await bot.callback(42, "session:stop:sid", panelMessageId);
		const token = callbackData(bot.edited.at(-1)?.options, "action:confirm:");
		deferInspect = true;
		const confirmation = bot.callback(42, token, panelMessageId);
		await started;
		expect(
			(
				adapter as unknown as {
					inFlightConfirmationRefs: Map<SessionId, number>;
				}
			).inFlightConfirmationRefs.get("sid" as SessionId),
		).toBe(1);
		emit(harnessEvent("sid", "status", "agent_start"));
		expect(
			(
				adapter as unknown as { confirmationEpochs: Map<SessionId, number> }
			).confirmationEpochs.has("sid" as SessionId),
		).toBe(true);
		releaseInspect();
		await confirmation;
		expect(requests.some((request) => request.kind === "stop")).toBe(false);
		expect(
			(
				adapter as unknown as { confirmationEpochs: Map<SessionId, number> }
			).confirmationEpochs.has("sid" as SessionId),
		).toBe(false);
		await adapter.stop();
	});

	it("does not dispatch delete when lifecycle invalidates an in-flight confirmation", async () => {
		const bot = new MockBot();
		let deferInspect = false;
		let releaseInspect!: () => void;
		let inspectStarted!: () => void;
		const started = new Promise<void>((resolve) => (inspectStarted = resolve));
		const gate = new Promise<void>((resolve) => (releaseInspect = resolve));
		const { adapter, requests, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (deferInspect && request.kind === "inspect") {
					inspectStarted();
					await gate;
				}
				return result(request);
			},
		});
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		await bot.callback(42, "menu:sessions", panelMessageId);
		await bot.callback(42, "session:details:sid", panelMessageId);
		await bot.callback(42, "session:delete:sid", panelMessageId);
		const token = callbackData(bot.edited.at(-1)?.options, "action:confirm:");
		deferInspect = true;
		const confirmation = bot.callback(42, token, panelMessageId);
		await started;
		emit(harnessEvent("sid", "status", "harness_restarting"));
		releaseInspect();
		await confirmation;
		expect(requests.some((request) => request.kind === "delete")).toBe(false);
		await adapter.stop();
	});

	it("retires epochs for lifecycle churn without confirmation references", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		for (let index = 0; index < 100; index++) {
			emit(harnessEvent(`churn-${index}`, "status", "agent_start"));
			emit(harnessEvent(`churn-${index}`, "status", "agent_settled"));
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			(adapter as unknown as { confirmationEpochs: Map<SessionId, number> })
				.confirmationEpochs.size,
		).toBe(0);
		await adapter.stop();
	});

	it("does not resend after an uncertain panel edit and recovers a known-deleted panel", async () => {
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/menu");
		const sendsAfterCreate = bot.api.sendMessage.mock.calls.length;
		bot.api.editMessageText.mockRejectedValueOnce(
			new Error("temporary API failure"),
		);
		await bot.update(42, "/menu");
		expect(bot.api.sendMessage).toHaveBeenCalledTimes(sendsAfterCreate);

		bot.api.editMessageText.mockRejectedValueOnce(
			Object.assign(new Error("Telegram rejected edit"), {
				description: "Bad Request: message to edit not found",
			}),
		);
		await bot.update(42, "/menu");
		expect(bot.api.sendMessage).toHaveBeenCalledTimes(sendsAfterCreate + 1);
		expect(bot.api.pinChatMessage).toHaveBeenCalledTimes(2);
		await bot.update(42, "/sessions");
		expect(bot.sent.at(-1)?.text).toContain("#sid");
		await adapter.stop();
	});

	it("rebinds folder intents before publishing a replacement panel keyboard", async () => {
		const bot = new MockBot();
		const directory = await temp();
		await mkdir(path.join(directory, "child"));
		const { adapter } = await startAdapter(bot, directory, {
			initialCwd: directory,
		});
		await bot.update(42, "/menu");
		const originalId = bot.lastMessageId;
		await bot.callback(42, "menu:folders", originalId);
		const staleFolder = callbackData(bot.edited.at(-1)?.options, "folder:");
		bot.api.editMessageText.mockRejectedValueOnce(
			Object.assign(new Error("edit target gone"), {
				description: "Bad Request: message to edit not found",
			}),
		);
		await bot.callback(42, "menu:folders", originalId);
		const replacementId = bot.lastMessageId;
		const replacementToken = callbackData(
			bot.edited.at(-1)?.options,
			"folder:",
		);
		expect(replacementId).not.toBe(originalId);
		expect(bot.sendOptions.at(-1)).not.toHaveProperty("reply_markup");
		await bot.callback(42, replacementToken, replacementId);
		expect(bot.edited.at(-1)?.text).toContain("Папки");
		await bot.callback(42, staleFolder, originalId);
		expect(bot.edited.at(-1)?.text).toContain("устарело");
		await adapter.stop();
	});

	it("keeps a replacement panel reference when keyboard publication fails", async () => {
		const bot = new MockBot();
		const directory = await temp();
		await mkdir(path.join(directory, "child"));
		const { adapter } = await startAdapter(bot, directory, {
			initialCwd: directory,
		});
		await bot.update(42, "/menu");
		const originalId = bot.lastMessageId;
		bot.api.editMessageText
			.mockRejectedValueOnce(
				Object.assign(new Error("edit target gone"), {
					description: "Bad Request: message to edit not found",
				}),
			)
			.mockRejectedValueOnce(new Error("keyboard publication timed out"));
		await bot.callback(42, "menu:folders", originalId);
		const replacementId = bot.lastMessageId;
		const sendsAfterReplacement = bot.api.sendMessage.mock.calls.length;
		expect(replacementId).not.toBe(originalId);
		const publicationAttempt = bot.api.editMessageText.mock.calls.find(
			([, messageId]) => messageId === replacementId,
		);
		expect(publicationAttempt).toBeDefined();
		const unpublishedFolderToken = callbackData(
			publicationAttempt?.[3],
			"folder:",
		);
		await bot.update(42, "/menu");
		expect(bot.api.sendMessage).toHaveBeenCalledTimes(sendsAfterReplacement);
		expect(bot.api.editMessageText).toHaveBeenLastCalledWith(
			42,
			replacementId,
			expect.any(String),
			expect.any(Object),
			expect.any(AbortSignal),
		);

		await bot.callback(42, unpublishedFolderToken, replacementId);
		expect(bot.edited.at(-1)?.text).toContain("устарело");
		expect(bot.api.sendMessage).toHaveBeenCalledTimes(sendsAfterReplacement);
		await adapter.stop();
	});

	it("rebinds confirmation intents to a replacement panel before keyboard publication", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/menu");
		const originalId = bot.lastMessageId;
		await bot.callback(42, "menu:sessions", originalId);
		await bot.callback(42, "session:details:sid", originalId);
		await bot.callback(42, "session:delete:sid", originalId);
		const staleConfirmation = callbackData(
			bot.edited.at(-1)?.options,
			"action:confirm:",
		);
		await bot.callback(42, "action:cancel", originalId);
		await bot.callback(42, "session:details:sid", originalId);
		bot.api.editMessageText.mockRejectedValueOnce(
			Object.assign(new Error("edit target gone"), {
				description: "Bad Request: message to edit not found",
			}),
		);
		await bot.callback(42, "session:delete:sid", originalId);
		const replacementId = bot.lastMessageId;
		const replacementToken = callbackData(
			bot.edited.at(-1)?.options,
			"action:confirm:",
		);
		expect(replacementId).not.toBe(originalId);
		expect(bot.sendOptions.at(-1)).not.toHaveProperty("reply_markup");
		await bot.callback(42, replacementToken, replacementId);
		expect(requests.some((request) => request.kind === "delete")).toBe(true);
		const actions = requests.filter(
			(request) => request.kind === "delete",
		).length;
		await bot.callback(42, staleConfirmation, originalId);
		expect(
			requests.filter((request) => request.kind === "delete"),
		).toHaveLength(actions);
		await adapter.stop();
	});

	it("keeps slash commands available when Telegram cannot pin the panel", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		bot.api.pinChatMessage.mockRejectedValueOnce(new Error("pin unavailable"));
		await bot.update(42, "/menu");
		expect(bot.sent.at(-1)?.text).toContain("Telegram не закрепил");
		await bot.update(42, "/sessions");
		expect(requests.at(-1)).toMatchObject({ kind: "list" });
		expect(bot.sent.at(-1)?.text).toContain("#sid");
		await adapter.stop();
	});

	it("reuses the saved panel message after a transport restart", async () => {
		const directory = await temp();
		const firstBot = new MockBot();
		const first = await startAdapter(firstBot, directory);
		await firstBot.update(42, "/menu");
		const panelMessageId = firstBot.lastMessageId;
		expect(panelMessageId).toBeDefined();
		await first.adapter.stop();

		const secondBot = new MockBot();
		const second = await startAdapter(secondBot, directory);
		await secondBot.update(42, "/menu");
		expect(secondBot.edited[0]?.messageId).toBe(panelMessageId);
		expect(secondBot.pinned).toHaveLength(0);
		await second.adapter.stop();
	});

	it("restores each chat's selected stopped session after a transport restart", async () => {
		const directory = await temp();
		const sessionCwd = await temp();
		const sid = sessions.get("sid");
		if (!sid) throw new Error("Missing session fixture");
		sessions.set("sid", { ...sid, cwd: sessionCwd });
		const fetchFile = stubFileDownload();
		const firstBot = new MockBot();
		const first = await startAdapter(firstBot, directory);
		await firstBot.update(42, "/use sid");
		await firstBot.update(43, "/use other");
		await first.adapter.stop();

		const sidAfterStop = sessions.get("sid");
		const other = sessions.get("other");
		if (!sidAfterStop || !other) throw new Error("Missing session fixture");
		sessions.set("sid", { ...sidAfterStop, status: "stopped" });
		sessions.set("other", { ...other, status: "stopped" });

		const secondBot = new MockBot();
		const second = await startAdapter(secondBot, directory);
		expect(second.requests).toEqual([]);
		await secondBot.update(42, "/use");
		expect(secondBot.sent.at(-1)?.text).toContain("Selected");
		expect(secondBot.sent.at(-1)?.text).toContain(
			"A new message will resume it",
		);
		await secondBot.update(42, "continue sid");
		await secondBot.update(43, "continue other");
		await secondBot.updatePhoto(42, "describe image");
		await secondBot.updateDocument(42, { caption: "review document" });
		expect(
			second.requests.filter((request) => request.kind === "submit"),
		).toMatchObject([
			{ kind: "submit", sessionId: "sid", text: "continue sid" },
			{ kind: "submit", sessionId: "other", text: "continue other" },
			{
				kind: "submit",
				sessionId: "sid",
				text: expect.stringContaining("describe image"),
			},
			{
				kind: "submit",
				sessionId: "sid",
				text: expect.stringContaining("review document"),
			},
		]);
		expect(fetchFile).toHaveBeenCalledTimes(2);
		await second.adapter.stop();
	});

	it("reports an unresumable selected session without creating a replacement", async () => {
		const stopped = sessions.get("sid");
		if (!stopped) throw new Error("Missing session fixture");
		sessions.set("sid", { ...stopped, status: "stopped" });
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: async (request) =>
				request.kind === "submit"
					? {
							requestId: request.requestId,
							ok: false,
							error: {
								code: "SESSION_NOT_RESUMABLE",
								message: "Session cannot be resumed",
							},
						}
					: result(request),
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "new work");
		expect(requests.map(({ kind }) => kind)).toEqual(["inspect", "submit"]);
		expect(bot.sent.at(-1)?.text).toContain("This message was not submitted");
		expect(bot.sent.at(-1)?.text).toContain("did not create a replacement");
		expect(bot.sent.at(-1)?.text).toContain("/sessions or /menu");
		expect(bot.reactions).toEqual([]);
		await adapter.stop();
	});

	it("reports an unavailable saved Pi session without resending or creating a replacement", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: async (request) =>
				request.kind === "submit"
					? {
							requestId: request.requestId,
							ok: false,
							error: {
								code: "SESSION_NOT_FOUND",
								message: "Session was not found",
							},
						}
					: result(request),
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "do not replay this text");
		expect(requests.map(({ kind }) => kind)).toEqual([
			"inspect",
			"submit",
			"inspect",
		]);
		expect(bot.sent.at(-1)?.text).toContain("no live Pi process is attached");
		expect(bot.sent.at(-1)?.text).toContain("This message was not sent");
		expect(bot.sent.at(-1)?.text).toContain("/menu");
		expect(bot.sent.at(-1)?.text).toContain("do not replay this text");
		expect(bot.reactions).toEqual([]);
		await adapter.stop();
	});

	it("clears stale saved selections and guides the chat to choose a session", async () => {
		const directory = await temp();
		const store = await TelegramPanelStore.open(directory, "secret-token");
		await store.setSelected(42, "deleted-session");
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, directory);
		await bot.update(42, "do not submit");
		expect(requests.some((request) => request.kind === "submit")).toBe(false);
		expect(bot.sent.at(-1)?.text).toContain("/sessions");
		expect(bot.sent.at(-1)?.text).toContain("/menu");
		expect(
			(await TelegramPanelStore.open(directory, "secret-token")).getSelected(
				42,
			),
		).toBeUndefined();
		await adapter.stop();
	});

	it("persists selection clearing after stop and deletion", async () => {
		const directory = await temp();
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, directory);
		await bot.update(42, "/use sid");
		await bot.update(43, "/use other");
		await bot.update(42, "/stop");
		await bot.update(43, "/delete other");
		await adapter.stop();
		const store = await TelegramPanelStore.open(directory, "secret-token");
		expect(store.getSelected(42)).toBeUndefined();
		expect(store.getSelected(43)).toBeUndefined();
	});

	it("makes bare /use explain how to select a session when none is remembered", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use");
		expect(requests).toEqual([]);
		expect(bot.sent.at(-1)?.text).toContain("/sessions");
		expect(bot.sent.at(-1)?.text).toContain("/menu");
		expect(bot.sent.at(-1)?.text).not.toContain("Invalid command");
		await adapter.stop();
	});

	it("routes correlated text and media replies safely across selected sessions", async () => {
		const fetchFile = stubFileDownload();
		const bot = new MockBot();
		const cwd = await temp();
		const otherCwd = await temp();
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd,
			name: `session ${"Name this session (harnessd name prompt):"} label`,
		});
		sessions.set("other", {
			...(sessions.get("other") as SessionSummary),
			cwd: otherCwd,
		});
		const { adapter, requests, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "create a reply target");
		await vi.waitFor(() =>
			expect(bot.sent.some(({ text }) => text.includes("Pi activity"))).toBe(
				true,
			),
		);
		const sourceId = bot.sent.find(({ text }) =>
			text.includes("Pi activity"),
		)?.message_id;
		expect(sourceId).toBeDefined();
		await bot.updateDocument(42, {
			replyToMessageId: sourceId,
			replyToMessageText:
				"assistant output includes Name this session (harnessd name prompt): inline",
		});
		await vi.waitFor(() =>
			expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(2),
		);
		expect(
			requests.filter(({ kind }) => kind === "submit").at(-1),
		).toMatchObject({ sessionId: "sid" });
		await bot.update(42, "text reply stays on source", {
			replyToMessageId: sourceId,
			replyToMessageText:
				"assistant output includes Name this session (harnessd name prompt): inline",
		});
		expect(
			requests.filter(({ kind }) => kind === "submit").at(-1),
		).toMatchObject({ sessionId: "sid" });

		await bot.update(42, "/use other");
		await bot.update(42, "text reply needs a choice", {
			replyToMessageId: sourceId,
		});
		const textChoice = bot.sent.at(-1);
		const selectedChoiceData = callbackData(
			bot.sendOptions.at(-1),
			"reply:",
		).replace(/:s$/, ":c");
		await bot.update(42, "/use sid");
		await bot.callback(42, selectedChoiceData, textChoice?.message_id);
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(3);
		await bot.update(42, "/use other");
		fetchFile.mockClear();

		await bot.updatePhoto(
			42,
			undefined,
			42,
			sourceId,
			"Name this session (harnessd name prompt):\nNew session will be created in /work. Reply with a name. Create unnamed and Cancel buttons are below.",
		);
		expect(fetchFile).not.toHaveBeenCalled();
		const choice = bot.sent.at(-1);
		const choiceData = (
			bot.sendOptions.at(-1) as {
				reply_markup: { inline_keyboard: { callback_data: string }[][] };
			}
		).reply_markup.inline_keyboard[0]?.[0]?.callback_data;
		expect(choice?.text).toContain("selected session is");
		expect(choiceData).toMatch(/^reply:[a-f0-9]{12}:s$/);
		await bot.callback(42, choiceData as string, choice?.message_id);
		await vi.waitFor(() =>
			expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(4),
		);
		expect(
			requests.filter(({ kind }) => kind === "submit").at(-1),
		).toMatchObject({ sessionId: "sid" });
		expect(fetchFile).toHaveBeenCalledTimes(1);
		await bot.callback(42, choiceData as string, choice?.message_id);
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(4);
		expect(fetchFile).toHaveBeenCalledTimes(1);

		await bot.updateDocument(42, { replyToMessageId: 999999 });
		await vi.waitFor(() =>
			expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(5),
		);
		expect(
			requests.filter(({ kind }) => kind === "submit").at(-1),
		).toMatchObject({ sessionId: "other" });
		emit(harnessEvent("other", "status", "agent_settled"));
		await adapter.stop();
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: "/work",
		});
		sessions.set("other", {
			...(sessions.get("other") as SessionSummary),
			cwd: "/other",
		});
	});

	it("does not mistake a marker inside actual assistant output for a stale name prompt", async () => {
		stubFileDownload();
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "kick off a turn");
		emit(
			harnessEvent(
				"sid",
				"output",
				"Assistant says Name this session (harnessd name prompt): inline.",
			),
		);
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "completed" },
		});
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) =>
					text.includes(
						"Assistant says Name this session (harnessd name prompt): inline.",
					),
				),
			).toBe(true),
		);
		const output = bot.sent.find(({ text }) =>
			text.includes(
				"Assistant says Name this session (harnessd name prompt): inline.",
			),
		);
		expect(output).toBeDefined();
		await bot.update(42, "text reply", {
			replyToMessageId: output?.message_id,
			replyToMessageText: output?.text,
		});
		await vi.waitFor(() =>
			expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(2),
		);
		await adapter.stop();
	});

	it("routes ordinary output beginning with a prompt marker after restart for text and media", async () => {
		const fetchFile = stubFileDownload();
		const bot = new MockBot();
		const stateDirectory = await temp();
		const sessionCwd = await temp();
		const previousSession = sessions.get("sid");
		sessions.set("sid", {
			...(previousSession as SessionSummary),
			cwd: sessionCwd,
		});
		const first = await startAdapter(bot, stateDirectory);
		await bot.update(42, "/use sid");
		const outputText =
			"Name this session (harnessd name prompt):\nordinary assistant second line";
		first.emit(harnessEvent("sid", "output", outputText));
		first.emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(bot.sent.some(({ text }) => text.startsWith(outputText))).toBe(
				true,
			),
		);
		const output = bot.sent.find(({ text }) => text.startsWith(outputText));
		expect(output).toBeDefined();
		await first.adapter.stop();

		const restartedBot = new MockBot();
		const restarted = await startAdapter(restartedBot, stateDirectory);
		await restartedBot.update(42, "text after restart", {
			replyToMessageId: output?.message_id,
			replyToMessageText: output?.text,
		});
		await restartedBot.updateDocument(42, {
			replyToMessageId: output?.message_id,
			replyToMessageText: output?.text,
		});
		await vi.waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(1));
		expect(
			restarted.requests.filter(({ kind }) => kind === "submit"),
		).toMatchObject([
			{ sessionId: "sid", text: "text after restart" },
			{ sessionId: "sid", text: expect.stringContaining("inbox") },
		]);
		expect(restartedBot.sent.at(-1)?.text).not.toContain(
			"name prompt has expired",
		);
		await restarted.adapter.stop();
		if (previousSession) sessions.set("sid", previousSession);
	});

	it("supersedes one name prompt per chat, expires stale media, and restores no prompt after restart", async () => {
		stubFileDownload();
		const bot = new MockBot();
		const stateDirectory = await temp();
		const { adapter, requests } = await startAdapter(bot, stateDirectory);
		await bot.update(42, "/menu");
		const panelId = bot.lastMessageId;
		await bot.callback(42, "menu:new", panelId);
		const firstPrompt = bot.lastForceReplyMessageId;
		await bot.callback(42, "menu:new", panelId);
		const currentPrompt = bot.lastForceReplyMessageId;
		expect(currentPrompt).not.toBe(firstPrompt);
		await bot.update(42, "stale name", {
			replyToMessageId: firstPrompt,
			replyToMessageText:
				"Name this session (harnessd name prompt):\nNew session will be created in /work. Reply with a name. Create unnamed and Cancel buttons are below.",
		});
		await bot.updateDocument(42, {
			replyToMessageId: firstPrompt,
			replyToMessageText:
				"Name this session (harnessd name prompt):\nNew session will be created in /work. Reply with a name. Create unnamed and Cancel buttons are below.",
		});
		expect(
			requests.some(({ kind }) => kind === "submit" || kind === "create"),
		).toBe(false);
		await bot.update(42, "current name", { replyToMessageId: currentPrompt });
		expect(requests.some(({ kind }) => kind === "create")).toBe(true);
		await adapter.stop();

		const restartedBot = new MockBot();
		const restarted = await startAdapter(restartedBot, stateDirectory);
		await restartedBot.update(42, "reply to expired prompt", {
			replyToMessageId: currentPrompt,
			replyToMessageText:
				"Name this session (harnessd name prompt):\nNew session will be created in /work. Reply with a name. Create unnamed and Cancel buttons are below.",
		});
		expect(restarted.requests.some(({ kind }) => kind === "submit")).toBe(
			false,
		);
		await restarted.adapter.stop();
	});

	it("keeps naming prompts isolated between authorized chats", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/menu");
		const panel42 = bot.lastMessageId;
		await bot.update(43, "/menu");
		const panel43 = bot.lastMessageId;
		await bot.callback(42, "menu:new", panel42);
		const prompt42 = bot.lastForceReplyMessageId;
		await bot.callback(43, "menu:new", panel43);
		const prompt43 = bot.lastForceReplyMessageId;
		await bot.update(43, "chat forty-three", { replyToMessageId: prompt43 });
		await bot.update(42, "chat forty-two", { replyToMessageId: prompt42 });
		expect(requests.filter(({ kind }) => kind === "create")).toMatchObject([
			{ kind: "create", name: "chat forty-three" },
			{ kind: "create", name: "chat forty-two" },
		]);
		await adapter.stop();
	});

	it("reissues invalid name flows and provides unnamed and cancel buttons", async () => {
		const bot = new MockBot();
		let rejectFirstName = true;
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "create" && request.name && rejectFirstName) {
					rejectFirstName = false;
					return {
						requestId: request.requestId,
						ok: false,
						error: { code: "VALIDATION", message: "Name is too long" },
					};
				}
				return result(request);
			},
		});
		await bot.update(42, "/menu");
		const panelId = bot.lastMessageId;
		await bot.callback(42, "menu:new", panelId);
		const firstPrompt = bot.lastForceReplyMessageId;
		await bot.update(42, "invalid name", { replyToMessageId: firstPrompt });
		const retryPrompt = bot.lastForceReplyMessageId;
		expect(retryPrompt).not.toBe(firstPrompt);
		await bot.update(42, "corrected name", { replyToMessageId: retryPrompt });
		expect(requests.filter(({ kind }) => kind === "create")).toHaveLength(2);

		await bot.callback(42, "menu:new", panelId);
		const unnamedChoice = callbackData(bot.sendOptions.at(-2), "name:unnamed");
		const unnamedChoiceId = bot.sent.at(-2)?.message_id;
		await bot.callback(42, unnamedChoice, unnamedChoiceId);
		const unnamedRequest = requests
			.filter(({ kind }) => kind === "create")
			.at(-1);
		expect(unnamedRequest).toMatchObject({ kind: "create", cwd: "/work" });
		expect(unnamedRequest).not.toHaveProperty("name");
		await bot.callback(42, "menu:new", panelId);
		const cancelData = callbackData(bot.sendOptions.at(-2), "name:cancel");
		const cancelId = bot.sent.at(-2)?.message_id;
		const creates = requests.filter(({ kind }) => kind === "create").length;
		await bot.callback(42, cancelData, cancelId);
		expect(requests.filter(({ kind }) => kind === "create")).toHaveLength(
			creates,
		);
		await adapter.stop();
	});

	it("bounds exact control-heavy rename paths on initial and invalid-name retry prompts", async () => {
		const cwd = `/${"\n".repeat(700)}`;
		const presentedCwd = `/${"\\u{000A}".repeat(700)}`;
		const targetName = "Exact rename target";
		sessions.set("sid", sessionWith("sid", { cwd, name: targetName }));
		const bot = new MockBot();
		let rejectFirstRename = true;
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "rename" && request.name && rejectFirstRename) {
					rejectFirstRename = false;
					return {
						requestId: request.requestId,
						ok: false,
						error: { code: "VALIDATION", message: "Invalid name" },
					};
				}
				return result(request);
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		await bot.callback(42, "session:rename:sid");
		const firstPrompt = bot.lastForceReplyMessageId;
		const firstMessages = bot.sent.map(({ text }) => text);
		expect(firstMessages.every((text) => text.length <= 4096)).toBe(true);
		const firstForceReply = bot.sent.find(
			({ message_id }) => message_id === firstPrompt,
		)?.text;
		expect(firstForceReply).toContain(`${targetName} · #sid`);
		expect(firstForceReply).toContain("#sid");
		const firstPathChunks = firstMessages.filter((text) =>
			text.includes("\\u{000A}"),
		);
		expect(firstPathChunks.length).toBeGreaterThan(1);
		expect(firstPathChunks.join("")).toBe(presentedCwd);
		await bot.update(42, "invalid name", { replyToMessageId: firstPrompt });
		const retryPrompt = bot.lastForceReplyMessageId;
		expect(retryPrompt).not.toBe(firstPrompt);
		const retryMessages = bot.sent
			.slice(firstMessages.length)
			.map(({ text }) => text);
		expect(retryMessages.every((text) => text.length <= 4096)).toBe(true);
		const retryForceReply = bot.sent.at(-1)?.text;
		expect(retryForceReply).toContain(`${targetName} · #sid`);
		expect(retryForceReply).toContain("#sid");
		const retryPathChunks = retryMessages.filter((text) =>
			text.includes("\\u{000A}"),
		);
		expect(retryPathChunks.length).toBeGreaterThan(1);
		expect(retryPathChunks.join("")).toBe(presentedCwd);
		expect(bot.sendOptions.at(-1)).toMatchObject({
			reply_markup: { force_reply: true, selective: true },
		});
		await bot.update(42, "valid name", { replyToMessageId: retryPrompt });
		expect(requests.filter(({ kind }) => kind === "rename")).toMatchObject([
			{ sessionId: "sid", name: "invalid name" },
			{ sessionId: "sid", name: "valid name" },
		]);
		await adapter.stop();
	});

	it("uses ForceReply to create named sessions and consumes only replies to its prompt", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/menu");
		await bot.callback(42, "menu:new");
		const promptMessageId = bot.lastMessageId;
		expect(bot.sendOptions.at(-1)).toMatchObject({
			reply_markup: { force_reply: true },
		});
		await bot.update(42, "A named task", { replyToMessageId: promptMessageId });
		expect(requests.find((request) => request.kind === "create")).toMatchObject(
			{
				kind: "create",
				name: "A named task",
				cwd: "/work",
			},
		);
		expect(requests.some((request) => request.kind === "submit")).toBe(false);
		await bot.update(42, "stale prompt response", { replyToMessageId: 999999 });
		expect(requests.some((request) => request.kind === "submit")).toBe(true);
		await bot.update(42, "old name reply", {
			replyToMessageId: 999998,
			replyToMessageText:
				"Name this session (harnessd name prompt):\nNew session will be created in /work. Reply with a name. Create unnamed and Cancel buttons are below.",
		});
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(1);
		await adapter.stop();
	});

	it("rejects unauthorized, malformed sender, group, and channel updates before dispatch", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const { adapter, requests } = await startAdapter(bot, dir);
		await bot.update(42, "/sessions", { userId: 7 });
		await bot.update(42, "/delete sid", { userId: 7 });
		await bot.update(42, "/ls", { userId: 7 });
		await bot.update(42, "/cd /tmp", { userId: 7 });
		await bot.update(42, "/sessions", { missingSender: true });
		await bot.update(42, "/sessions", { userId: 0 });
		await bot.update(42, "/sessions", { userId: 42.2 });
		await bot.update(42, "/sessions", { userId: 42, chatType: "group" });
		await bot.update(42, "/sessions", { userId: 42, chatType: "supergroup" });
		await bot.update(42, "/sessions", { userId: 42, chatType: "channel" });
		expect(requests).toEqual([]);
		expect(bot.sent).toEqual([]);
		await adapter.stop();
	});

	it("registers commands and formats IDs as safely escaped code", async () => {
		const bot = new MockBot();
		const sid = sessions.get("sid");
		if (!sid) throw new Error("Missing session fixture");
		const unsafeSession = { ...sid, cwd: "/work<&" };
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: async (request) =>
				request.kind === "list"
					? {
							requestId: request.requestId,
							ok: true,
							value: [unsafeSession],
						}
					: result(request),
		});
		expect(bot.api.setMyCommands).toHaveBeenCalledOnce();
		expect(bot.commandRegistrations[0]).toMatchObject({
			other: { scope: { type: "all_private_chats" } },
		});
		expect(
			bot.commandRegistrations[0]?.commands.map(({ command }) => command),
		).toEqual([
			"help",
			"menu",
			"rename",
			"sessions",
			"new",
			"ls",
			"cd",
			"send",
			"use",
			"resume",
			"inspect",
			"status",
			"model",
			"effort",
			"stop",
			"delete",
			"cancel",
		]);

		await bot.update(100, "/help");
		expect(bot.sent.at(-1)?.text).toContain("/delete <sessionId>");
		expect(bot.sent.at(-1)?.text).toContain("/resume [sessionId]");
		expect(bot.sent.at(-1)?.text).toContain("/ls [path]");
		expect(bot.sent.at(-1)?.text).toContain("/cd [path]");
		expect(bot.sent.at(-1)?.text).toContain("/send <path>");
		await bot.update(100, "/sessions");
		expect(requests.at(-1)).toMatchObject({ kind: "list" });
		const sessionReply = bot.sent.at(-1);
		expect(sessionReply?.text).toContain("#sid · running");
		expect(sessionReply?.text).toContain("/work&lt;&amp;");
		expect(bot.sendOptions.at(-1)).toEqual({ parse_mode: "HTML" });

		await bot.update(100, "/use other");
		await bot.update(100, "/resume");
		expect(requests.at(-1)).toMatchObject({
			kind: "resume",
			sessionId: "other",
		});
		await bot.update(100, "/resume sid");
		expect(requests.at(-1)).toMatchObject({ kind: "resume", sessionId: "sid" });
		await bot.update(100, "still selected other");
		expect(requests.at(-1)).toMatchObject({
			kind: "submit",
			sessionId: "other",
		});
		await bot.update(100, "/delete other");
		expect(requests.at(-1)).toMatchObject({
			kind: "delete",
			sessionId: "other",
		});
		expect(bot.sent.at(-1)?.text).toContain("Deleted stopped session #other");
		const submitsBeforeDeletedText = requests.filter(
			({ kind }) => kind === "submit",
		).length;
		await bot.update(100, "plain text after deletion");
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(
			submitsBeforeDeletedText,
		);
		await bot.update(100, "/delete");
		expect(bot.sent.at(-1)?.text).toBe(
			"<pre><code>Usage: /delete &lt;sessionId&gt;</code></pre>",
		);
		await adapter.stop();
	});

	it("keeps chat selection unchanged when an explicit resume fails", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: async (request) =>
				request.kind === "resume"
					? {
							requestId: request.requestId,
							ok: false,
							error: {
								code: "SESSION_NOT_RESUMABLE",
								message: "Session cannot be resumed safely.",
							},
						}
					: result(request),
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/resume other");
		await bot.update(42, "still targets sid");
		expect(requests.at(-2)).toMatchObject({
			kind: "resume",
			sessionId: "other",
		});
		expect(requests.at(-1)).toMatchObject({ kind: "submit", sessionId: "sid" });
		expect(bot.sent.at(-2)?.text).toBe(
			"Session cannot be resumed safely. Choose another session with /sessions or /menu.",
		);
		await adapter.stop();
	});

	it("keeps polling and logs a trace if Telegram command registration fails", async () => {
		const bot = new MockBot();
		bot.setMyCommandsBehavior = async () => {
			throw new Error("PRIVATE Telegram API failure");
		};
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const { adapter } = await startAdapter(bot, await temp());
		expect(bot.api.setMyCommands).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(
				"harnessd: Telegram command menu registration failed (ref ",
			),
		);
		expect(log.mock.calls.flat().join(" ")).toContain(
			"PRIVATE Telegram API failure",
		);
		await adapter.stop();
	});

	it("routes model, effort, and status commands to each chat's selected session", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(100, "/use sid");
		await bot.update(101, "/use other");
		await bot.update(100, "/status");
		await bot.update(100, "/model");
		await bot.update(101, "/model openai/gpt-next high");
		await bot.update(100, "/effort");
		await bot.update(101, "/effort high");
		await bot.update(101, "/status");
		await bot.update(101, "prompt for other");
		expect(requests.map(({ kind }) => kind)).toEqual([
			"inspect",
			"inspect",
			"session_status",
			"model_list",
			"model_set",
			"effort_list",
			"effort_set",
			"session_status",
			"submit",
		]);
		expect(requests[2]).toMatchObject({
			kind: "session_status",
			sessionId: "sid",
		});
		expect(requests[3]).toMatchObject({ kind: "model_list", sessionId: "sid" });
		expect(requests[4]).toMatchObject({
			kind: "model_set",
			sessionId: "other",
			provider: "openai",
			modelId: "gpt-next",
			effort: "high",
		});
		expect(requests[5]).toMatchObject({
			kind: "effort_list",
			sessionId: "sid",
		});
		expect(requests[6]).toMatchObject({
			kind: "effort_set",
			sessionId: "other",
			effort: "high",
		});
		expect(requests[8]).toMatchObject({ kind: "submit", sessionId: "other" });
		expect(
			bot.sent.some(
				({ chatId, text }) => chatId === 100 && text.includes("Tokens: 1,234"),
			),
		).toBe(true);
		expect(
			bot.sent.some(
				({ chatId, text }) =>
					chatId === 100 && text.includes("openai/gpt-test"),
			),
		).toBe(true);
		expect(
			bot.sent.some(
				({ chatId, text }) =>
					chatId === 100 &&
					text.includes("Effort levels (current: medium): low, medium, high"),
			),
		).toBe(true);
		expect(
			bot.sent.some(
				({ chatId, text }) =>
					chatId === 101 &&
					text.includes("Switched to openai/gpt-next; effort set to high."),
			),
		).toBe(true);
		await adapter.stop();
	});

	it("reports partial model selection and saved status when live fields are unavailable", async () => {
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "model_set")
					return {
						requestId: request.requestId,
						ok: true,
						value: {
							model: {
								provider: request.provider,
								id: request.modelId,
								name: request.modelId,
							},
							effort: request.effort,
							effortConfirmed: false,
						},
					};
				if (request.kind === "session_status") {
					const session = sessions.get(request.sessionId);
					if (!session)
						return {
							requestId: request.requestId,
							ok: false,
							error: {
								code: "SESSION_NOT_FOUND",
								message: "Session was not found",
							},
						};
					return {
						requestId: request.requestId,
						ok: true,
						value: { session: { ...session, status: "stopped" } },
					};
				}
				return result(request);
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/model openai/gpt-next high");
		await bot.update(42, "/status");
		expect(
			bot.sent.some(({ text }) =>
				text.includes("Pi did not confirm effort high"),
			),
		).toBe(true);
		expect(
			bot.sent.some(
				({ text }) =>
					text.includes("Folder: /work") &&
					text.includes("Status: stopped") &&
					text.includes("Model: unavailable") &&
					text.includes("Live Pi data: unavailable"),
			),
		).toBe(true);
		await adapter.stop();
	});

	it("routes all commands, accepts cwd paths with spaces, and requires strict IDs", async () => {
		const bot = new MockBot();
		const { adapter, requests, isSubscribed, emit } = await startAdapter(
			bot,
			await temp(),
		);
		await bot.update(42, "/new /tmp/project with spaces");
		await bot.update(42, "plain prompt");
		await bot.update(42, "/use sid extra");
		await bot.update(42, "/cancel input-1 extra");
		for (const text of ["/sessions", "/use sid", "/use missing"])
			await bot.update(42, text);
		await bot.update(42, "still routed to sid");
		for (const text of ["/inspect", "/cancel input-1", "/stop other", "/help"])
			await bot.update(42, text);
		expect(requests.map(({ kind }) => kind)).toEqual([
			"create",
			"submit",
			"list",
			"inspect",
			"inspect",
			"submit",
			"inspect",
			"cancel",
			"stop",
		]);
		expect(requests[0]).toMatchObject({ cwd: "/tmp/project with spaces" });
		expect(requests[1]).toMatchObject({
			text: "plain prompt",
			sessionId: "sid",
		});
		expect(requests[5]).toMatchObject({
			text: "still routed to sid",
			sessionId: "sid",
		});
		expect(requests.find((request) => request.kind === "cancel")).toMatchObject(
			{
				kind: "cancel",
				sessionId: "sid",
				inputId: "input-1",
			},
		);
		expect(
			bot.sent.some(({ text }) => text.includes("Session was not found")),
		).toBe(true);
		expect(
			requests.every(
				(request) => request.principalId === "42" && request.requestId,
			),
		).toBe(true);
		expect(isSubscribed()).toBe(true);
		expect(requests.at(-1)).toMatchObject({ kind: "stop", sessionId: "other" });
		await adapter.stop();
		expect(isSubscribed()).toBe(false);
		const sentCount = bot.sent.length;
		emit(harnessEvent("sid", "output", "after stop"));
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(bot.sent).toHaveLength(sentCount);
	});

	it("accepts unquoted and matching quoted paths without shell parsing", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/new /tmp/project with spaces");
		await bot.update(42, '/new "/tmp/project with spaces"');
		await bot.update(42, "/new '/tmp/project with spaces'");
		await bot.update(42, '/new "/tmp/project with spaces');
		expect(
			requests
				.filter((request) => request.kind === "create")
				.map((request) => request.cwd),
		).toEqual([
			"/tmp/project with spaces",
			"/tmp/project with spaces",
			"/tmp/project with spaces",
		]);
		expect(bot.sent.at(-1)?.text).toBe(
			"Use matching quotes around the entire path, or remove the quotes.",
		);
		await adapter.stop();
	});

	it("uses the initial cwd when /new has no explicit path", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			initialCwd: "/work",
		});
		await bot.update(42, "/new");
		expect(requests[0]).toMatchObject({ kind: "create", cwd: "/work" });
		await adapter.stop();
	});

	it("uses per-chat navigation for ls, cd, and relative new paths without confinement", async () => {
		const bot = new MockBot();
		const initial = await temp();
		const child = path.join(initial, "child folder");
		const outside = await temp();
		await mkdir(child);
		await writeFile(
			path.join(initial, "visible.txt"),
			"secret contents are not read",
		);
		await writeFile(path.join(initial, ".hidden"), "");
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			initialCwd: initial,
		});

		await bot.update(100, "/ls");
		const firstListing = bot.sent.at(-1)?.text ?? "";
		expect(firstListing).toContain(`Directory: ${initial}`);
		expect(firstListing).toContain("📄 visible.txt");
		expect(firstListing).not.toContain(".hidden");
		expect(firstListing).not.toContain("secret contents");

		await bot.update(100, "/cd child folder");
		await bot.update(100, "/new relative project");
		await bot.update(101, "/new");
		await bot.update(100, `/cd ${outside}`);
		await bot.update(100, "/new");
		await bot.update(100, "/cd");
		await bot.update(100, "/new");

		expect(
			requests
				.filter(({ kind }) => kind === "create")
				.map((request) => (request.kind === "create" ? request.cwd : "")),
		).toEqual([
			path.join(child, "relative project"),
			initial,
			outside,
			os.homedir(),
		]);
		expect(
			bot.sent.some(({ text }) => text === `Working folder: ${outside}`),
		).toBe(true);
		expect(
			requests.filter(({ kind }) => kind !== "create" && kind !== "list"),
		).toEqual([]);
		await adapter.stop();
	});

	it("leaves the chat cwd unchanged when cd fails", async () => {
		const bot = new MockBot();
		const initial = await temp();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			initialCwd: initial,
		});
		await bot.update(42, "/cd missing-directory");
		await bot.update(42, "/new relative");
		expect(bot.sent[0]?.text).toContain("current folder unchanged");
		expect(requests[0]).toMatchObject({
			kind: "create",
			cwd: path.join(initial, "relative"),
		});
		await adapter.stop();
	});

	it("bounds escaped long Unicode diagnostics to Telegram's message limit", async () => {
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "submit") throw new Error("<>&😀".repeat(2000));
				return result(request);
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "trigger");
		const diagnostic = bot.sent.at(-1)?.text ?? "";
		expect(diagnostic.length).toBeLessThanOrEqual(4096);
		expect(diagnostic).toContain("[trace truncated]");
		expect(bot.sendOptions.at(-1)).toEqual({ parse_mode: "HTML" });
		await adapter.stop();
	});

	it("shows traced dispatch failures without echoing uncorrelated submitted text", async () => {
		const bot = new MockBot();
		const journal = vi.spyOn(console, "error").mockImplementation(() => {});
		const { adapter } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "submit")
					throw new Error("private dispatch detail");
				return result(request);
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "private prompt text");
		expect(
			bot.sent.some(({ text }) =>
				text.includes("<pre><code>Request failed (ref "),
			),
		).toBe(true);
		expect(
			bot.sent.some(({ text }) => text.includes("private dispatch detail")),
		).toBe(true);
		expect(
			bot.sent.some(({ text }) => text.includes("private prompt text")),
		).toBe(false);
		expect(journal.mock.calls.flat().join(" ")).not.toContain(
			"private prompt text",
		);
		journal.mockRestore();
		await adapter.stop();
	});

	it("includes the original uncertain InputId in safe submit errors without echoing prompts", async () => {
		const bot = new MockBot();
		const inputId = "original-uncertain-input";
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: async (request) =>
				request.kind === "submit"
					? {
							requestId: request.requestId,
							ok: false,
							error: {
								code: "UNCERTAIN_INPUT_DELIVERY",
								message: "Input delivery is uncertain",
								inputId: inputId as never,
							},
						}
					: result(request),
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "private prompt that must not be echoed");
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(1);
		expect(
			bot.sent.some(
				({ text }) =>
					text.includes(
						`Input delivery is uncertain (Pi may have accepted the input, but its acknowledgement was lost; no automatic resend occurred; InputId ${inputId})`,
					) && text.startsWith("<pre><code>"),
			),
		).toBe(true);
		expect(bot.sent.some(({ text }) => text.includes("private prompt"))).toBe(
			true,
		);
		await adapter.stop();
	});

	it.each(["text", "media"] as const)(
		"keeps uncertainty ahead of long diagnostics for %s submissions",
		async (kind) => {
			const fetchFile = kind === "media" ? stubFileDownload() : undefined;
			const bot = new MockBot();
			const dir = await temp();
			sessions.set("sid", {
				...(sessions.get("sid") as SessionSummary),
				cwd: dir,
			});
			const inputId = `long-${kind}-uncertain-input`;
			const traceback = `Input delivery is uncertain\n\nUncertainInputDeliveryError: lost acknowledgement\n${"    at prompt (runtime.js:1:1)\n".repeat(60)}`;
			const { adapter } = await startAdapter(bot, await temp(), {
				dispatch: async (request) =>
					request.kind === "submit"
						? {
								requestId: request.requestId,
								ok: false,
								error: {
									code: "UNCERTAIN_INPUT_DELIVERY",
									message: traceback,
									inputId: inputId as never,
								},
							}
						: result(request),
			});
			await bot.update(42, "/use sid");
			if (kind === "media") await bot.updatePhoto(42, "caption");
			else await bot.update(42, "submit text");

			const explanation =
				"Pi may have accepted the input, but its acknowledgement was lost; no automatic resend occurred";
			expect(
				bot.sent.some(
					({ text }) =>
						text.startsWith("<pre><code>") &&
						text.includes(explanation) &&
						text.includes(`InputId ${inputId}`) &&
						text.includes("UncertainInputDeliveryError"),
				),
			).toBe(true);
			expect(
				bot.edited.some(
					({ text }) =>
						text.includes(explanation) && text.includes(`InputId ${inputId}`),
				),
			).toBe(true);
			if (kind === "media") expect(fetchFile).toHaveBeenCalledTimes(1);
			await adapter.stop();
		},
	);

	it("presents definite input rejection distinctly from uncertain delivery", async () => {
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp(), {
			dispatch: async (request) =>
				request.kind === "submit"
					? {
							requestId: request.requestId,
							ok: false,
							error: { code: "INPUT_REJECTED", message: "Pi rejected input" },
						}
					: result(request),
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "rejected text");
		const failure = bot.edited.find(({ text }) =>
			text.includes("Pi rejected input"),
		);
		expect(failure?.text).toContain("Pi не принял сообщение");
		expect(failure?.text).not.toContain("acknowledgement was lost");
		await adapter.stop();
	});

	it("presents user cancellation as canceled by user, not as a send error", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "cancel me");
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: {
				inputId: "cancelled-input" as never,
				state: "failed",
				detail: "Input canceled",
			},
		});
		await vi.waitFor(() =>
			expect(
				bot.edited.some(({ text }) => text.includes("canceled by user")),
			).toBe(true),
		);
		expect(bot.edited.at(-1)?.text).toContain("Отменено пользователем");
		expect(bot.edited.at(-1)?.text).not.toContain("Ошибка отправки");
		await adapter.stop();
	});

	it("routes to each selected chat and presents only safe, session-labelled statuses/errors", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(43, "/use other");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "status", "harness_restarting"));
		emit(harnessEvent("sid", "status", "harness_recovered"));
		emit(harnessEvent("sid", "status", "harness_recovery_failed"));
		expect(clearIntervalSpy).toHaveBeenCalled();
		clearIntervalSpy.mockRestore();
		emit(harnessEvent("sid", "status", "agent_end"));
		emit(harnessEvent("sid", "status", "secret-unknown-state"));
		emit({
			...harnessEvent("sid", "error", "raw-secret-error"),
			text: "raw-secret-error",
		});
		emit(harnessEvent("other", "output", "private other session"));
		emit(harnessEvent("other", "status", "agent_settled"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-uncertain" as never, state: "uncertain" },
		});
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => text.includes("private other session")),
			).toBe(true),
		);
		const sidMessages = bot.sent.filter(
			({ chatId, text }) => chatId === 42 && hasSessionFooter(text, "sid"),
		);
		const otherMessages = bot.sent.filter(
			({ chatId, text }) => chatId === 43 && hasSessionFooter(text, "other"),
		);
		const recoveryMessages = sidMessages.map(({ text }) => telegramBody(text));
		expect(recoveryMessages).toContain("Harness is restarting.");
		expect(recoveryMessages).toContain("Harness recovered.");
		expect(recoveryMessages).toContain("Harness recovery failed.");
		expect(recoveryMessages.indexOf("Harness is restarting.")).toBeLessThan(
			recoveryMessages.indexOf("Harness recovered."),
		);
		expect(recoveryMessages.indexOf("Harness recovered.")).toBeLessThan(
			recoveryMessages.indexOf("Harness recovery failed."),
		);
		expect(recoveryMessages).toContain("Session status changed.");
		expect(
			sidMessages.some(({ text }) => text.includes("raw-secret-error")),
		).toBe(true);
		expect(
			sidMessages.some(({ text }) =>
				text.includes("input-uncertain: uncertain (not resent)"),
			),
		).toBe(true);
		expect(otherMessages).toHaveLength(1);
		expect(telegramBody(otherMessages[0]?.text ?? "")).toBe(
			"private other session",
		);
		await adapter.stop();
	});

	it("uses grammY's supported getFile API instead of a nonexistent getFileLink", () => {
		const bot = new Bot("123456:FAKE_TEST_TOKEN");
		expect(Reflect.get(bot.api, "getFileLink")).toBeUndefined();
	});

	it("explains uncertain media delivery without resending the attachment", async () => {
		const fetchFile = stubFileDownload();
		const bot = new MockBot();
		const dir = await temp();
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: dir,
		});
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: async (request) =>
				request.kind === "submit"
					? {
							requestId: request.requestId,
							ok: false,
							error: {
								code: "UNCERTAIN_INPUT_DELIVERY",
								message: "Input delivery is uncertain",
								inputId: "media-input" as never,
							},
						}
					: result(request),
		});
		await bot.update(42, "/use sid");
		await bot.updatePhoto(42, "caption");
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(1);
		expect(fetchFile).toHaveBeenCalledTimes(1);
		expect(
			bot.sent.some(({ text }) =>
				text.includes(
					"Pi may have accepted the input, but its acknowledgement was lost; no automatic resend occurred",
				),
			),
		).toBe(true);
		await adapter.stop();
	});

	it("downloads the largest selected-session photo and submits image content with the caption", async () => {
		const fetchFile = stubFileDownload();
		const bot = new MockBot();
		const dir = await temp();
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: dir,
		});
		const stateDirectory = await temp();
		const { adapter, requests } = await startAdapter(bot, stateDirectory);
		await bot.update(42, "/use sid");
		await bot.updatePhoto(42, "describe this");
		await vi.waitFor(() => expect(bot.reactions).toHaveLength(1));
		const submission = requests.find((request) => request.kind === "submit");
		expect(submission).toMatchObject({
			kind: "submit",
			text: expect.stringContaining(
				"Caption (untrusted user text): describe this",
			),
			images: [{ mimeType: "image/jpeg", data: "aGVsbG8=" }],
		});
		expect(bot.api.getFile).toHaveBeenCalledWith("largest-photo-id");
		expect(bot.reactions).toContainEqual({
			chatId: 42,
			messageId: 1002,
			reaction: [{ type: "emoji", emoji: "👀" }],
		});
		expect(fetchFile).toHaveBeenCalledTimes(1);
		const downloadUrl = fetchFile.mock.calls[0]?.[0];
		expect(downloadUrl).toBeInstanceOf(URL);
		expect(downloadUrl?.href).toBe(
			"https://api.telegram.org/file/botsecret-token/photos/largest-photo-id.jpg",
		);
		expect(bot.sent.every(({ text }) => !text.includes("secret-token"))).toBe(
			true,
		);
		const savedPath =
			submission?.kind === "submit"
				? submission.text.match(
						/saved in the harnessd inbox at (.+)\. Caption/,
					)?.[1]
				: undefined;
		expect(savedPath).toBeDefined();
		if (!savedPath) throw new Error("Photo path missing from submitted prompt");
		expect(savedPath).toContain(path.join(stateDirectory, "inbox", "sid"));
		expect(await readFile(savedPath, "utf8")).toBe("hello");
		expect(await readdir(dir)).toEqual([]);
		await adapter.stop();
	});

	it("downloads selected-session documents and submits their path with the caption", async () => {
		const fetchFile = stubFileDownload();
		const bot = new MockBot();
		const dir = await temp();
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: dir,
		});
		const stateDirectory = await temp();
		const { adapter, requests } = await startAdapter(bot, stateDirectory);
		await bot.update(42, "/use sid");
		await bot.updateDocument(42, { caption: "summarize this" });
		await vi.waitFor(() => expect(bot.reactions).toHaveLength(1));

		const submission = requests.find((request) => request.kind === "submit");
		expect(submission).toMatchObject({
			kind: "submit",
			text: expect.stringContaining(
				"Caption (untrusted user text): summarize this",
			),
		});
		expect(bot.reactions).toContainEqual({
			chatId: 42,
			messageId: 1002,
			reaction: [{ type: "emoji", emoji: "👀" }],
		});
		expect(fetchFile.mock.calls[0]?.[0]?.href).toBe(
			"https://api.telegram.org/file/botsecret-token/photos/document-id.jpg",
		);
		const savedPath =
			submission?.kind === "submit"
				? submission.text.match(
						/saved in the harnessd inbox at (.+)\. Caption/,
					)?.[1]
				: undefined;
		expect(savedPath).toBeDefined();
		if (!savedPath)
			throw new Error("Document path missing from submitted prompt");
		expect(savedPath).toContain(path.join(stateDirectory, "inbox", "sid"));
		expect(await readFile(savedPath, "utf8")).toBe("hello");
		expect(await readdir(dir)).toEqual([]);
		await adapter.stop();
	});

	it("does not submit oversized or failed incoming documents", async () => {
		const bot = new MockBot();
		const dir = await temp();
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: dir,
		});
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.updateDocument(42, { fileSize: 20_000_001 });
		const submissions = () =>
			requests.filter((request) => request.kind === "submit");
		expect(submissions()).toHaveLength(0);
		expect(bot.sent.at(-1)?.text).toContain("20 MB download limit");

		bot.api.getFile = vi.fn(async () => {
			throw new Error("secret download failure");
		});
		await bot.updateDocument(42);
		expect(submissions()).toHaveLength(0);
		expect(bot.sent.at(-1)?.text).toContain(
			"Could not safely download or save",
		);
		expect(bot.sent.at(-1)?.text).not.toContain("smaller file");
		expect(bot.sent.at(-1)?.text).not.toContain("secret");
		await adapter.stop();
	});

	it("does not submit when Telegram omits file_path or the download fails", async () => {
		const bot = new MockBot();
		const workspace = await temp();
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: workspace,
		});
		const stateDirectory = await temp();
		const { adapter, requests } = await startAdapter(bot, stateDirectory);
		await bot.update(42, "/use sid");
		bot.api.getFile = vi.fn(async () => ({ file_size: 5 }));
		await bot.updateDocument(42);
		expect(bot.sent.at(-1)?.text).toContain(
			"Could not safely download or save",
		);
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(0);

		const fetchFile = vi.fn(
			async () => new Response("failure", { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchFile);
		bot.api.getFile = vi.fn(async (fileId: string) => ({
			file_path: `photos/${fileId}.jpg`,
			file_size: 5,
		}));
		await bot.updateDocument(42);
		expect(fetchFile).toHaveBeenCalledTimes(1);
		expect(bot.sent.at(-1)?.text).toContain(
			"Could not safely download or save",
		);
		expect(bot.sent.at(-1)?.text).not.toContain("secret-token");
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(0);
		await expect(
			readdir(path.join(stateDirectory, "inbox")),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
		await adapter.stop();
	});

	it("rejects incoming files when the configured inbox lies inside the workspace", async () => {
		stubFileDownload();
		const bot = new MockBot();
		const workspace = await temp();
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: workspace,
		});
		const { adapter, requests } = await startAdapter(bot, workspace);
		await bot.update(42, "/use sid");
		await bot.updateDocument(42);
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(0);
		await expect(readdir(path.join(workspace, "inbox"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await adapter.stop();
	});

	it("does not submit an incoming document when saving into the inbox fails", async () => {
		stubFileDownload();
		const bot = new MockBot();
		const stateDirectory = await temp();
		await writeFile(path.join(stateDirectory, "inbox"), "not a directory");
		const { adapter, requests } = await startAdapter(bot, stateDirectory);
		await bot.update(42, "/use sid");
		await bot.updateDocument(42);
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(0);
		expect(bot.sent.at(-1)?.text).toContain(
			"Could not safely download or save",
		);
		await adapter.stop();
	});

	it("removes a deleted stopped session inbox without touching its workspace", async () => {
		const bot = new MockBot();
		const stateDirectory = await temp();
		const inboxDirectory = path.join(stateDirectory, "inbox", "sid");
		await mkdir(inboxDirectory, { recursive: true, mode: 0o700 });
		const inboxFile = path.join(
			inboxDirectory,
			`${Date.now()}-aaaaaaaaaaaaaaaa-upload.txt`,
		);
		await writeFile(inboxFile, "incoming");
		const workspace = await temp();
		const workspaceFile = path.join(workspace, "keep.txt");
		await writeFile(workspaceFile, "keep");
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: workspace,
			status: "stopped",
		});
		const { adapter } = await startAdapter(bot, stateDirectory);
		await bot.update(42, "/delete sid");
		await expect(readFile(inboxFile)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(workspaceFile, "utf8")).toBe("keep");
		await adapter.stop();
	});

	it("sends agent-requested files only to authorized chats selecting the session", async () => {
		const bot = new MockBot();
		const directory = await temp();
		const file = path.join(directory, "report.txt");
		await writeFile(file, "report");
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: directory,
		});
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(43, "/use sid");
		const sent = await adapter.sendAgentFile({
			sessionId: "sid" as SessionId,
			path: "report.txt",
			caption: "Requested file",
		});
		expect(sent).toEqual({
			fileName: "report.txt",
			delivered: 2,
			recipients: 2,
		});
		expect(bot.api.sendDocument).toHaveBeenCalledTimes(2);
		for (const call of bot.api.sendDocument.mock.calls) {
			expect(call[1]).toMatchObject({ filename: "report.txt" });
			expect(call[2]).toEqual({ caption: "Requested file" });
		}
		const beforeOutside = bot.api.sendDocument.mock.calls.length;
		const outside = await temp();
		await writeFile(path.join(outside, "private.txt"), "private");
		const result = await adapter.sendAgentFile({
			sessionId: "sid" as SessionId,
			path: path.join(outside, "private.txt"),
		});
		expect(result).toMatchObject({ delivered: 0, recipients: 2 });
		expect(bot.api.sendDocument).toHaveBeenCalledTimes(beforeOutside);
		await adapter.stop();
	});

	it("restricts /send to regular files inside the selected session cwd", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const outside = await temp();
		const file = path.join(dir, "report.txt");
		const outsideFile = path.join(outside, "private.txt");
		await writeFile(file, "report");
		await writeFile(outsideFile, "private");
		let symlinkAvailable = false;
		try {
			await symlink(outsideFile, path.join(dir, "escape.txt"));
			symlinkAvailable = true;
		} catch (error) {
			if (process.platform !== "win32") throw error;
		}
		const largeFile = path.join(dir, "large.txt");
		await writeFile(largeFile, "");
		await truncate(largeFile, 20 * 1024 * 1024 + 1);
		await mkdir(path.join(dir, "folder"));
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: dir,
		});
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(43, "/use sid", { userId: 42 });
		await bot.update(42, "/send report.txt");
		expect(bot.api.sendDocument).toHaveBeenCalledOnce();
		expect(bot.api.sendDocument).toHaveBeenCalledWith(
			42,
			expect.anything(),
			{},
			expect.any(AbortSignal),
		);
		await bot.update(42, `/send ${outsideFile}`);
		if (symlinkAvailable) await bot.update(42, "/send escape.txt");
		await bot.update(42, "/send large.txt");
		await bot.update(42, "/send folder");
		expect(bot.api.sendDocument).toHaveBeenCalledOnce();
		await adapter.stop();
	});

	it("sends only selected-session files through /send with paths containing spaces", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const file = path.join(dir, "report file.txt");
		await writeFile(file, "report");
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: dir,
		});
		const { adapter } = await startAdapter(bot, await temp());

		await bot.update(100, '/send "report file.txt"');
		expect(bot.api.sendDocument).not.toHaveBeenCalled();
		expect(bot.sent.at(-1)?.text).toBe(
			"No session is selected. Use /sessions to find one and /use <sessionId>, or open /menu.",
		);

		await bot.update(100, "/use sid");
		await bot.update(100, '/send "report file.txt"');
		expect(bot.api.sendDocument).toHaveBeenCalledOnce();
		expect(bot.sent.at(-1)?.text).toBe("File sent.");

		await bot.update(100, "/send ../outside.txt");
		expect(bot.api.sendDocument).toHaveBeenCalledOnce();
		expect(bot.sent.at(-1)?.text).toContain(
			"inside the selected session folder",
		);
		await adapter.stop();
	});

	it("refreshes authorized chat typing while a session is processing", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "status", "agent_start"));
		await vi.waitFor(() =>
			expect(bot.api.sendChatAction).toHaveBeenCalledWith(
				42,
				"typing",
				{},
				expect.any(AbortSignal),
			),
		);
		emit(harnessEvent("sid", "status", "agent_settled"));
		await adapter.stop();
	});

	it("stops typing for a chat immediately when it switches away from an active session", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(43, "/use sid", { userId: 42 });
		emit(harnessEvent("sid", "status", "agent_start"));
		await vi.waitFor(() =>
			expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2),
		);
		await bot.update(42, "/use other");
		expect(bot.api.sendChatAction.mock.calls.map(([chatId]) => chatId)).toEqual(
			[42, 43, 43],
		);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		await bot.update(43, "/delete sid");
		expect(clearIntervalSpy).toHaveBeenCalled();
		clearIntervalSpy.mockRestore();
		emit(harnessEvent("sid", "status", "agent_settled"));
		await adapter.stop();
	});

	it("restarts typing when a chat reselects a session with an active turn", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "status", "agent_start"));
		await vi.waitFor(() =>
			expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1),
		);

		await bot.update(42, "/use other");
		expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);
		await bot.update(42, "/use sid");
		await vi.waitFor(() =>
			expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2),
		);

		emit(harnessEvent("sid", "status", "agent_settled"));
		await adapter.stop();
	});

	it("filters internal status widgets without dropping surrounding assistant text", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		const messagesBeforeTurn = bot.sent.length;
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "Here is the result.\nPI_SUBAGENT_"));
		emit(
			harnessEvent(
				"sid",
				"output",
				'ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot"}\nAnother useful detail.',
			),
		);
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => text.includes("Another useful detail.")),
			).toBe(true),
		);
		const answer = bot.sent.at(-1)?.text ?? "";
		expect(answer).toContain("Here is the result.");
		expect(answer).toContain("Another useful detail.");
		expect(answer).not.toContain("PI_SUBAGENT_ASYNC_JSON:");
		expect(bot.sent).toHaveLength(messagesBeforeTurn + 1);
		await adapter.stop();
	});

	it("does not send a Telegram answer when a turn contains only an internal widget", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		const messagesBeforeTurn = bot.sent.length;
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(
			harnessEvent(
				"sid",
				"output",
				'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot"}',
			),
		);
		emit(harnessEvent("sid", "status", "agent_settled"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(bot.sent).toHaveLength(messagesBeforeTurn);
		await adapter.stop();
	});

	it("does not send an overflow notice when the buffered output is only internal widgets", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		const messagesBeforeTurn = bot.sent.length;
		emit(harnessEvent("sid", "status", "agent_start"));
		const snapshot =
			'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot"}\n';
		emit(harnessEvent("sid", "output", snapshot.repeat(500)));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(bot.sent).toHaveLength(messagesBeforeTurn);
		await adapter.stop();
	});

	it("formats assistant Markdown safely and keeps input acknowledgements literal", async () => {
		const bot = new MockBot();
		let emitEvent!: (event: HarnessEvent) => void;
		const { adapter, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "submit")
					emitEvent({
						sessionId: request.sessionId,
						kind: "input",
						inputEvent: { inputId: "input-1" as never, state: "accepted" },
					});
				return result(request);
			},
		});
		emitEvent = emit;
		await bot.update(42, "/use sid");
		await bot.update(42, "send this");
		const assistantOutput = [
			"**bold** *italic* ~~strike~~ `inline <code>`",
			"```ts",
			'const value = "<tag>";',
			"```",
			'raw <b>HTML</b> & text [unsafe](javascript:alert(1)) [safe](https://example.com/?x=1&y=2) [mail](mailto:user@example.com) [\u0060x\u0060](https://example.com) [code](https://example.com/\u0060x\u0060) **\u0060x\u0060** [malformed](https://example.com/" onload="x) *crossed ~~markup* stays~~ readable* unclosed **formatting',
		].join("\n");
		emit(harnessEvent("sid", "output", assistantOutput));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "completed" },
		});
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(bot.sent.some(({ text }) => text.includes("<b>bold</b>"))).toBe(
				true,
			),
		);
		const acceptanceUpdates = bot.edited.filter(({ text }) =>
			text.includes("input-1"),
		);
		expect(
			acceptanceUpdates.some(({ text }) =>
				text.includes("Input input-1: accepted"),
			),
		).toBe(true);
		const commandReplyIndex = bot.sent.findIndex(({ text }) =>
			text.startsWith("Selected"),
		);
		expect(commandReplyIndex).toBeGreaterThanOrEqual(0);
		expect(bot.sendOptions[commandReplyIndex]).not.toMatchObject({
			parse_mode: "HTML",
		});
		const outputIndex = bot.sent.findIndex(({ text }) =>
			text.includes("<b>bold</b>"),
		);
		const output = bot.sent[outputIndex];
		const options = bot.sendOptions[outputIndex] as {
			entities?: readonly { type: string; offset: number; length: number }[];
			parse_mode?: string;
		};
		expect(output?.text).toContain("<b>bold</b> <i>italic</i> <s>strike</s>");
		expect(output?.text).toContain("<code>inline &lt;code&gt;</code>");
		expect(output?.text).toContain(
			"<pre>const value = &quot;&lt;tag&gt;&quot;;\n</pre>",
		);
		expect(output?.text).toContain("raw &lt;b&gt;HTML&lt;/b&gt; &amp; text");
		expect(output?.text).toContain(
			'<a href="https://example.com/?x=1&amp;y=2">safe</a>',
		);
		expect(output?.text).toContain(
			'<a href="mailto:user@example.com">mail</a>',
		);
		expect(output?.text).not.toContain('<a href="javascript:');
		expect(output?.text).not.toContain("HARNESSDMD");
		expect(output?.text).not.toContain("<b><code>");
		expect(output?.text).not.toContain(
			'<a href="https://example.com/" onload=',
		);
		expect(telegramBody(output?.text ?? "")).toContain("unsafe");
		expect(telegramBody(output?.text ?? "")).toContain("unclosed");
		expect(output?.text).not.toContain("<i>crossed");
		expect(output?.text).not.toContain("<s>markup");
		expect(options.parse_mode).toBe("HTML");
		expect(options.entities).toBeUndefined();
		expect(hasSessionFooter(output?.text ?? "", "sid")).toBe(true);
		await adapter.stop();
	});

	it("deduplicates identical session errors until successful recovery", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		for (let index = 0; index < 3; index++)
			emit(harnessEvent("sid", "error", "RPC event stream failed"));
		emit(harnessEvent("sid", "error", "different extension error"));
		emit(harnessEvent("sid", "status", "harness_recovered"));
		for (let index = 0; index < 2; index++)
			emit(harnessEvent("sid", "error", "RPC event stream failed"));
		await vi.waitFor(() =>
			expect(
				bot.sent.filter(({ text }) =>
					telegramBody(text).startsWith("Pi error:"),
				),
			).toHaveLength(3),
		);
		expect(
			bot.sent
				.map(({ text }) => telegramBody(text))
				.filter((text) => text.startsWith("Pi error:")),
		).toEqual([
			"Pi error: RPC event stream failed",
			"Pi error: different extension error",
			"Pi error: RPC event stream failed",
		]);
		await adapter.stop();
	});

	it("keeps repeated input states in event order with intervening output and status", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-X" as never, state: "accepted" },
		});
		emit(harnessEvent("sid", "output", "answer"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-X" as never, state: "completed" },
		});
		emit(harnessEvent("sid", "status", "agent_settled"));
		const eventMessages = () =>
			bot.sent
				.filter(
					({ chatId, text }) => chatId === 42 && hasSessionFooter(text, "sid"),
				)
				.map(({ text }) => telegramBody(text));
		await vi.waitFor(() => expect(eventMessages()).toHaveLength(2));
		expect(eventMessages()).toEqual(["answer", "Input input-X: completed"]);
		expect(eventMessages()).not.toContain("Input input-X: accepted");
		await adapter.stop();
	});

	it("coalesces deltas and suppresses queued output after a chat selects a different session", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		bot.api.sendMessage.mockImplementation(async (chatId, text, other) => {
			if (telegramBody(text) === "in-flight") await gate;
			bot.sent.push({ chatId, text });
			bot.sendOptions.push(other);
		});
		emit(harnessEvent("sid", "output", "in-flight"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.api.sendMessage.mock.calls.some(
					([chatId, text]) =>
						chatId === 42 && telegramBody(text) === "in-flight",
				),
			).toBe(true),
		);
		emit(harnessEvent("sid", "output", "stale queued"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await bot.update(42, "/use other");
		release();
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(
			bot.sent.some(({ text }) => telegramBody(text) === "stale queued"),
		).toBe(false);
		emit(harnessEvent("other", "output", "delta-a"));
		emit(harnessEvent("other", "output", "delta-b"));
		emit(harnessEvent("other", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => telegramBody(text) === "delta-adelta-b"),
			).toBe(true),
		);
		const longOutput = `${"y".repeat(4080)}\n${"y".repeat(4920)}`;
		emit(harnessEvent("other", "output", longOutput));
		emit(harnessEvent("other", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.sent.filter(
					({ chatId, text }) =>
						chatId === 42 && telegramBody(text).includes("y"),
				),
			).toHaveLength(3),
		);
		const chunks = bot.sent.filter(
			({ chatId, text }) => chatId === 42 && telegramBody(text).includes("y"),
		);
		expect(
			chunks.every(
				({ text }) =>
					telegramVisibleText(text).length <= 4096 &&
					hasSessionFooter(text, "other"),
			),
		).toBe(true);
		for (const message of chunks) {
			const options = bot.sendOptions[bot.sent.indexOf(message)] as {
				parse_mode?: string;
			};
			expect(options.parse_mode).toBe("HTML");
			expect(message.text).toContain("<code>other</code>");
		}
		expect(chunks.map(({ text }) => telegramBody(text)).join("")).toBe(
			longOutput,
		);
		const unicodeReply = `x${"🙂".repeat(2200)}`;
		emit(harnessEvent("other", "output", unicodeReply));
		emit(harnessEvent("other", "status", "agent_settled"));
		let unicodeParts: typeof bot.sent = [];
		await vi.waitFor(() => {
			unicodeParts = bot.sent.filter(
				({ chatId, text }) => chatId === 42 && text.includes("🙂"),
			);
			expect(unicodeParts).toHaveLength(2);
		});
		expect(
			unicodeParts.map(
				({ text }) => text.match(/<code>other<\/code> · (\d+\/\d+)$/)?.[1],
			),
		).toEqual(["1/2", "2/2"]);
		expect(unicodeParts.map(({ text }) => telegramBody(text)).join("")).toBe(
			unicodeReply,
		);
		for (const { text } of unicodeParts) {
			const body = telegramBody(text);
			expect(telegramVisibleText(text).length).toBeLessThanOrEqual(4096);
			for (let index = 0; index < body.length; index++) {
				const codePoint = body.charCodeAt(index);
				if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
					expect(body.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
					expect(body.charCodeAt(index + 1)).toBeLessThanOrEqual(0xdfff);
					index++;
				} else expect(codePoint < 0xdc00 || codePoint > 0xdfff).toBe(true);
			}
		}
		const fenced =
			"```ts\n" +
			"z".repeat(8500) +
			"\n``` [link](https://example.com/" +
			"q".repeat(800) +
			")";
		const beforeFence = bot.sent.length;
		emit(harnessEvent("other", "output", fenced));
		emit(harnessEvent("other", "status", "agent_settled"));
		let fenceParts: typeof bot.sent = [];
		await vi.waitFor(() => {
			fenceParts = bot.sent
				.slice(beforeFence)
				.filter(({ text }) => text.includes("<pre>"));
			expect(fenceParts.length).toBeGreaterThan(1);
		});
		expect(fenceParts.map(({ text }) => telegramBody(text)).join("")).toBe(
			`${"z".repeat(8500)}\n link`,
		);
		for (const { text } of fenceParts) {
			expect(telegramVisibleText(text).length).toBeLessThanOrEqual(4096);
			expect((text.match(/<pre>/g) ?? []).length).toBe(1);
			expect((text.match(/<\/pre>/g) ?? []).length).toBe(1);
			expect(text).not.toContain("HARNESSDMD");
		}
		await adapter.stop();
	});

	it("recovers the drain after it skips only events for the previously selected session", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "output", "stale A"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await bot.update(42, "/use other");
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(bot.sent.some(({ text }) => telegramBody(text) === "stale A")).toBe(
			false,
		);
		emit(harnessEvent("other", "output", "current B"));
		emit(harnessEvent("other", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => telegramBody(text) === "current B"),
			).toBe(true),
		);
		await adapter.stop();
	});

	it("bounds overflow and isolates a blocked recipient from another chat", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(43, "/use sid");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		bot.api.sendMessage.mockImplementation(async (chatId, text) => {
			if (chatId === 42 && hasSessionFooter(text, "sid")) await gate;
			bot.sent.push({ chatId, text });
		});
		for (let i = 0; i < 45; i++) emit(harnessEvent("sid", "status", "unknown"));
		await vi.waitFor(() =>
			expect(
				bot.api.sendMessage.mock.calls.some(
					([chatId, text]) =>
						chatId === 43 && telegramBody(text) === "Session status changed.",
				),
			).toBe(true),
		);
		release();
		await vi.waitFor(() =>
			expect(
				bot.sent.some(
					({ chatId, text }) =>
						chatId === 42 && text.includes("notifications were omitted"),
				),
			).toBe(true),
		);
		expect(bot.sent.filter(({ chatId }) => chatId === 42)).toHaveLength(26);
		await adapter.stop();
	});

	it("preserves uncertain input IDs when output saturates the notification queue", async () => {
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		bot.api.sendMessage.mockImplementation(async (chatId, text) => {
			if (telegramBody(text) === "first output") await gate;
			bot.sent.push({ chatId, text });
		});
		emit(harnessEvent("sid", "output", "first output"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.api.sendMessage.mock.calls.some(
					([, text]) => telegramBody(text) === "first output",
				),
			).toBe(true),
		);
		await new Promise((resolve) => setTimeout(resolve, 60));
		for (let index = 0; index < 40; index++) {
			emit(harnessEvent("sid", "output", `output ${index}`));
			emit(harnessEvent("sid", "status", "agent_settled"));
		}
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: {
				inputId: "uncertain-original-id" as never,
				state: "uncertain",
			},
		});
		release();
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) =>
					text.includes("uncertain-original-id: uncertain (not resent)"),
				),
			).toBe(true),
		);
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(0);
		await adapter.stop();
	});

	it("bounds stalled API sends by deadline and drops that recipient's later notifications", async () => {
		vi.useFakeTimers();
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		bot.api.sendMessage.mockClear();
		bot.api.sendMessage.mockImplementation(() => new Promise(() => {}));
		emit(harnessEvent("sid", "status", "custom"));
		await vi.advanceTimersByTimeAsync(40);
		expect(bot.api.sendMessage).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(5000);
		emit(harnessEvent("sid", "status", "agent_end"));
		await vi.advanceTimersByTimeAsync(100);
		expect(bot.api.sendMessage).toHaveBeenCalledOnce();
		await adapter.stop();
	});

	it("awaits async stop, joins polling, is idempotent, and releases lock only afterwards", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const { adapter } = await startAdapter(bot, dir);
		const lock = telegramLockPath("secret-token", dir);
		let finishStop!: () => void;
		bot.stopBehavior = () =>
			new Promise<void>((resolve) => {
				finishStop = () => {
					bot.finishStart();
					resolve();
				};
			});
		const stopping = adapter.stop();
		expect(adapter.stop()).toBe(stopping);
		await vi.waitFor(() => expect(bot.stopCalls).toBe(1));
		await expect(stat(lock)).resolves.toBeDefined();
		finishStop();
		await stopping;
		await expect(stat(lock)).rejects.toThrow();
	});

	it("cancels and drains a pending notification before releasing the lock", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const { adapter, emit } = await startAdapter(bot, dir);
		await bot.update(42, "/use sid");
		let sendSignal: AbortSignal | undefined;
		bot.api.sendMessage.mockImplementation((_chatId, _text, _other, signal) => {
			sendSignal = signal;
			return new Promise((_resolve, reject) =>
				signal?.addEventListener(
					"abort",
					() => reject(new Error("cancelled")),
					{ once: true },
				),
			);
		});
		emit(harnessEvent("sid", "status", "custom"));
		await vi.waitFor(() => expect(sendSignal).toBeDefined());
		await adapter.stop();
		expect(sendSignal?.aborted).toBe(true);
		await expect(stat(telegramLockPath("secret-token", dir))).rejects.toThrow();
	});

	it("retains the polling lock when async bot stop rejects", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const { adapter } = await startAdapter(bot, dir);
		const lock = telegramLockPath("secret-token", dir);
		bot.stopBehavior = async () => {
			throw new Error("raw API error");
		};
		await expect(adapter.stop()).rejects.toThrow("shutdown incomplete");
		await expect(stat(lock)).resolves.toBeDefined();
	});

	it("retains ownership if polling stop does not confirm before its deadline", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const { adapter } = await startAdapter(bot, dir);
		const lock = telegramLockPath("secret-token", dir);
		vi.useFakeTimers();
		bot.stopBehavior = () => new Promise<void>(() => {});
		const stopping = adapter.stop();
		const stopped = expect(stopping).rejects.toThrow("shutdown incomplete");
		await vi.advanceTimersByTimeAsync(6000);
		await stopped;
		await expect(stat(lock)).resolves.toBeDefined();
	});

	it("aborts grammY getMe initialization before polling and rolls back subscription and lock", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const controller = new AbortController();
		let subscribed = false;
		const adapter = new TelegramTransportAdapter({
			token: "secret-token",
			allowedUserIds: [42],
			stateDirectory: dir,
			initialCwd: "/work",
			signal: controller.signal,
			botFactory: () => bot as never,
		});
		let getMeAttempts = 0;
		bot.initBehavior = (signal) =>
			new Promise<void>((_resolve, reject) => {
				let retry: ReturnType<typeof setTimeout>;
				const attempt = () => {
					getMeAttempts++;
					retry = setTimeout(attempt, 10);
				};
				attempt();
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(retry);
						reject(new Error("aborted network retry"));
					},
					{ once: true },
				);
			});
		const starting = adapter.start(
			async (request) => result(request),
			() => {
				subscribed = true;
				return () => {
					subscribed = false;
				};
			},
		);
		await vi.waitFor(() => expect(getMeAttempts).toBeGreaterThan(1));
		expect(bot.startOptions).toBeUndefined();
		expect(bot.initSignal).toBeDefined();
		expect(subscribed).toBe(true);
		controller.abort();
		await expect(starting).rejects.toThrow("could not start");
		expect(bot.startOptions).toBeUndefined();
		expect(subscribed).toBe(false);
		await expect(stat(telegramLockPath("secret-token", dir))).rejects.toThrow();
	});

	it("rolls startup back on abort and monitors fatal polling failures", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const controller = new AbortController();
		const adapter = new TelegramTransportAdapter({
			token: "secret-token",
			allowedUserIds: [42],
			stateDirectory: dir,
			initialCwd: "/work",
			signal: controller.signal,
			botFactory: () => bot as never,
		});
		const starting = adapter.start(
			async (request) => result(request),
			() => () => {},
		);
		await vi.waitFor(() => expect(bot.startOptions).toBeDefined());
		let finishStop!: () => void;
		bot.stopBehavior = () =>
			new Promise<void>((resolve) => {
				finishStop = () => {
					bot.finishStart();
					resolve();
				};
			});
		controller.abort();
		await vi.waitFor(() => expect(bot.stopCalls).toBe(1));
		await expect(
			stat(telegramLockPath("secret-token", dir)),
		).resolves.toBeDefined();
		finishStop();
		await expect(starting).rejects.toThrow("could not start");
		await expect(stat(telegramLockPath("secret-token", dir))).rejects.toThrow();

		const nextBot = new MockBot();
		const fatal = vi.fn();
		const live = await startAdapter(nextBot, dir, { onFatal: fatal });
		nextBot.failStart();
		await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
		await live.adapter.stop();
	});

	it("claims a non-secret lock, recovers only demonstrably stale owners, and fails closed", async () => {
		const dir = await temp();
		const release = await acquireTelegramPollingLock("known-token", dir);
		const lock = telegramLockPath("known-token", dir);
		expect(lock).not.toContain("known-token");
		expect((await stat(lock)).mode & 0o777).toBe(0o600);
		expect((await readFile(lock, "utf8")).trim()).toBe(String(process.pid));
		await expect(
			acquireTelegramPollingLock("known-token", dir),
		).rejects.toThrow("already active");
		await expect(stat(`${lock}.recovery`)).rejects.toThrow();
		await release();
		await release();
		await expect(stat(lock)).rejects.toThrow();
		await writeFile(lock, "999999999");
		const recovered = await acquireTelegramPollingLock("known-token", dir);
		await recovered();
		await writeFile(lock, "unknown");
		await expect(
			acquireTelegramPollingLock("known-token", dir),
		).rejects.toThrow("ambiguous");
		const recoveryMarker = `${lock}.recovery`;
		await writeFile(recoveryMarker, "123");
		await expect(
			acquireTelegramPollingLock("known-token", dir),
		).rejects.toThrow("recovery is unavailable");
		expect(await readFile(recoveryMarker, "utf8")).toBe("123");
	});
});
