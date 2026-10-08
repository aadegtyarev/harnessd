import {
	chmod,
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
		reply_to_message?: {
			message_id: number;
			text?: string;
			from?: { id: number; is_bot?: boolean };
			entities?: readonly { type: string; offset: number; length: number }[];
		};
	};
	callbackQuery?: {
		id: string;
		data?: string;
		message?: { message_id: number };
	};
};
function replyPlainText(text?: string): string | undefined {
	return text?.replace(/<code>(.*?)<\/code>/g, "$1");
}
function replyCodeEntities(text?: string) {
	if (!text) return [];
	const match = /<code>(.*?)<\/code>/.exec(text);
	if (!match) return [];
	const offset = text.slice(0, match.index).replace(/<[^>]+>/g, "").length;
	return [{ type: "code", offset, length: (match[1] ?? "").length }];
}
class MockBot {
	botInfo = { id: 999 };
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
				if (telegramVisibleText(text).length > 4096)
					throw new Error("Telegram text limit exceeded");
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
				if (telegramVisibleText(text).length > 4096)
					throw new Error("Telegram text limit exceeded");
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
			replySenderIsBot?: boolean;
			replySenderId?: number;
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
								text: replyPlainText(options.replyToMessageText),
								from: {
									id:
										options.replySenderId ??
										(options.replySenderIsBot === false ? 42 : this.botInfo.id),
									is_bot: options.replySenderIsBot !== false,
								},
								entities: replyCodeEntities(options.replyToMessageText),
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
								text: replyPlainText(options.replyToMessageText),
								from: { id: this.botInfo.id, is_bot: true },
								entities: replyCodeEntities(options.replyToMessageText),
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
		case "resume": {
			const session = sessions.get(request.sessionId);
			if (!session) {
				value = undefined;
				break;
			}
			const resumed = { ...session, status: "running" as const };
			sessions.set(request.sessionId, resumed);
			value = resumed;
			break;
		}
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
		case "stop": {
			const session = sessions.get(request.sessionId);
			if (session)
				sessions.set(request.sessionId, { ...session, status: "stopped" });
			value = undefined;
			break;
		}
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
		activityClock?: () => Date;
		activityTimeFormatter?: (date: Date) => string;
		panelClock?: () => number;
		panelSleep?: (milliseconds: number) => Promise<void>;
	} = {},
) {
	let listener: ((event: HarnessEvent) => unknown) | undefined;
	let subscribed = false;
	let panelNow = Date.now();
	const requests: TransportEvent[] = [];
	const adapter = new TelegramTransportAdapter({
		token: "secret-token",
		allowedUserIds: [42],
		stateDirectory: dir,
		initialCwd: extras.initialCwd ?? "/work",
		botFactory: () => bot as never,
		panelClock: () => panelNow,
		panelSleep: async (milliseconds) => {
			panelNow += milliseconds;
		},
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
	it("spaces actual panel edit API calls by at least 500 ms", async () => {
		const bot = new MockBot();
		let now = 0;
		const editTimes: number[] = [];
		const originalEdit = bot.api.editMessageText.getMockImplementation();
		if (!originalEdit) throw new Error("Missing edit API mock");
		bot.api.editMessageText.mockImplementation(async (...args) => {
			editTimes.push(now);
			return originalEdit(...args);
		});
		const { adapter } = await startAdapter(bot, await temp(), {
			panelClock: () => now,
			panelSleep: async (milliseconds) => {
				now += milliseconds;
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		sessions.set("sid", sessionWith("sid", { name: "First change" }));
		await bot.update(42, "/menu");
		sessions.set("sid", sessionWith("sid", { name: "Second change" }));
		await bot.update(42, "/menu");
		expect(editTimes.length).toBeGreaterThanOrEqual(2);
		for (let index = 1; index < editTimes.length; index++)
			expect(editTimes[index] - editTimes[index - 1]).toBeGreaterThanOrEqual(
				500,
			);
		await adapter.stop();
	});

	it("refreshes live panel only for its preview on start and settlement", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		await bot.callback(42, "session:next", panelMessageId);
		const edits = bot.edited.length;
		emit(harnessEvent("sid", "status", "agent_start"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(bot.edited).toHaveLength(edits);
		emit(harnessEvent("other", "status", "agent_start"));
		await vi.waitFor(() => expect(bot.edited.length).toBeGreaterThan(edits));
		expect(bot.edited.at(-1)?.text).toContain("Просмотр: #other");
		expect(bot.edited.at(-1)?.text).toContain("Состояние Pi: занята");
		const afterStart = bot.edited.length;
		emit(harnessEvent("sid", "status", "agent_settled"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(bot.edited).toHaveLength(afterStart);
		emit(harnessEvent("other", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(bot.edited.length).toBeGreaterThan(afterStart),
		);
		expect(bot.edited.at(-1)?.text).toContain("Состояние Pi: ожидает");
		await adapter.stop();
	});

	it("shows stale unavailable live state and only advances update time on semantic changes", async () => {
		const bot = new MockBot();
		let time = 0;
		const { adapter } = await startAdapter(bot, await temp(), {
			activityClock: () => new Date(time * 1000),
			activityTimeFormatter: () => `00:00:0${time}`,
			dispatch: async (request) =>
				request.kind === "session_status"
					? {
							requestId: request.requestId,
							ok: true,
							value: {
								session: sessions.get(request.sessionId) as SessionSummary,
							},
						}
					: result(request),
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		expect(bot.sent.at(-1)?.text).toContain("Состояние Pi: состояние устарело");
		expect(bot.sent.at(-1)?.text).toContain("Живые данные недоступны");
		expect(bot.sent.at(-1)?.text).toContain("Обновлено: 00:00:00");
		time = 1;
		await bot.update(42, "/menu");
		expect(bot.edited).toHaveLength(0);
		await adapter.stop();
	});

	it("discards a slow older live-status render after a newer generation commits", async () => {
		const bot = new MockBot();
		let statusCount = 0;
		let releaseOld!: (result: TransportResult) => void;
		const oldStatus = new Promise<TransportResult>(
			(resolve) => (releaseOld = resolve),
		);
		const { adapter } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind !== "session_status") return result(request);
				statusCount++;
				if (statusCount === 2) return oldStatus;
				return {
					requestId: request.requestId,
					ok: true,
					value: {
						session: sessions.get(request.sessionId) as SessionSummary,
						live: {
							model: {
								provider: "test",
								id: `model-${statusCount}`,
								name: `model-${statusCount}`,
							},
						},
					},
				};
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		const olderRender = bot.update(42, "/menu");
		await vi.waitFor(() => expect(statusCount).toBe(2));
		await bot.update(42, "/menu");
		const committed = bot.edited.length;
		expect(bot.edited.at(-1)?.text).toContain("Модель: test/model-3");
		releaseOld({
			requestId: "old" as never,
			ok: true,
			value: {
				session: sessions.get("sid") as SessionSummary,
				live: {
					model: {
						provider: "test",
						id: "stale-model",
						name: "stale-model",
					},
				},
			},
		} as TransportResult);
		await olderRender;
		expect(bot.edited).toHaveLength(committed);
		expect(bot.edited.at(-1)?.text).not.toContain("stale-model");
		await adapter.stop();
	});

	it("advances panel update time for metric-only changes but not identical metrics", async () => {
		const bot = new MockBot();
		let tokens = 10;
		let time = 0;
		const { adapter } = await startAdapter(bot, await temp(), {
			activityClock: () => new Date(time * 1000),
			activityTimeFormatter: () => `00:00:0${time}`,
			dispatch: async (request) => {
				if (request.kind !== "session_status") return result(request);
				return {
					requestId: request.requestId,
					ok: true,
					value: {
						session: sessions.get(request.sessionId) as SessionSummary,
						live: { usage: { inputTokens: tokens } },
					},
				};
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		const before = bot.sent.at(-1)?.text ?? "";
		tokens = 11;
		time = 1;
		await bot.update(42, "/menu");
		const changed = bot.edited.at(-1)?.text ?? "";
		expect(changed).toContain("↑11");
		expect(changed).toContain("Обновлено: 00:00:01");
		time = 2;
		await bot.update(42, "/menu");
		expect(bot.edited.at(-1)?.text).toBe(changed);
		expect(before).toContain("Обновлено: 00:00:00");
		await adapter.stop();
	});

	it("refreshes the preview on recovery and fatal process-exit events", async () => {
		const bot = new MockBot();
		let statusQueries = 0;
		const { adapter, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "session_status") statusQueries++;
				return result(request);
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		for (const text of [
			"harness_restarting",
			"harness_recovered",
			"harness_recovery_failed",
		]) {
			const before = statusQueries;
			emit(harnessEvent("sid", "status", text));
			await vi.waitFor(() => expect(statusQueries).toBeGreaterThan(before));
		}
		const beforeFatal = statusQueries;
		emit({
			sessionId: "sid" as SessionId,
			kind: "error",
			message: "process exited",
			fatal: true,
		} as HarnessEvent);
		await vi.waitFor(() => expect(statusQueries).toBeGreaterThan(beforeFatal));
		await adapter.stop();
	});

	it("does not let a delayed startup session list replace a newer panel generation", async () => {
		const bot = new MockBot();
		let listCount = 0;
		let releaseOld!: (result: TransportResult) => void;
		const oldList = new Promise<TransportResult>(
			(resolve) => (releaseOld = resolve),
		);
		const { adapter } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind !== "list") return result(request);
				listCount++;
				if (listCount === 1) return oldList;
				return result(request);
			},
		});
		const startupRender = bot.update(42, "/menu");
		await vi.waitFor(() => expect(listCount).toBe(1));
		await bot.update(42, "/menu");
		releaseOld({
			requestId: "old" as never,
			ok: true,
			value: [sessions.get("other") as SessionSummary],
		} as TransportResult);
		await startupRender;
		await bot.update(42, "/menu");
		expect(bot.sent.at(-1)?.text).toContain("Просмотр: #sid");
		await adapter.stop();
	});

	it("does not let a slow main view overwrite newer folder navigation", async () => {
		const bot = new MockBot();
		const directory = await temp();
		let statusCount = 0;
		let releaseOld!: (result: TransportResult) => void;
		const oldStatus = new Promise<TransportResult>(
			(resolve) => (releaseOld = resolve),
		);
		const { adapter } = await startAdapter(bot, directory, {
			initialCwd: directory,
			dispatch: async (request) => {
				if (request.kind !== "session_status") return result(request);
				statusCount++;
				if (statusCount === 2) return oldStatus;
				return {
					requestId: request.requestId,
					ok: true,
					value: {
						session: sessions.get(request.sessionId) as SessionSummary,
						live: { model: { provider: "test", id: "fresh", name: "fresh" } },
					},
				};
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		const stale = bot.update(42, "/menu");
		await vi.waitFor(() => expect(statusCount).toBe(2));
		await bot.callback(42, "menu:folders", bot.lastMessageId);
		releaseOld({
			requestId: "old" as never,
			ok: true,
			value: {
				session: sessions.get("sid") as SessionSummary,
				live: { model: { provider: "test", id: "stale", name: "stale" } },
			},
		} as TransportResult);
		await stale;
		expect(bot.edited.at(-1)?.text).toContain("Папки");
		expect(bot.edited.at(-1)?.text).not.toContain("Модель: test/stale");
		await adapter.stop();
	});

	it("discards stale panel updates queued behind an in-flight Telegram edit", async () => {
		const bot = new MockBot();
		let tokens = 10;
		const { adapter } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind !== "session_status") return result(request);
				return {
					requestId: request.requestId,
					ok: true,
					value: {
						session: sessions.get(request.sessionId) as SessionSummary,
						live: { usage: { inputTokens: tokens } },
					},
				};
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		let releaseEdit!: () => void;
		let editStarted!: () => void;
		const started = new Promise<void>((resolve) => (editStarted = resolve));
		const blocked = new Promise<void>((resolve) => (releaseEdit = resolve));
		bot.editMessageBehavior = async () => {
			editStarted();
			await blocked;
		};
		tokens = 11;
		const firstEdit = bot.update(42, "/menu");
		await started;
		tokens = 12;
		const staleQueued = bot.update(42, "/menu");
		tokens = 13;
		const newestQueued = bot.update(42, "/menu");
		releaseEdit();
		await Promise.all([firstEdit, staleQueued, newestQueued]);
		expect(bot.edited).toHaveLength(2);
		expect(bot.edited.at(-1)?.text).toContain("↑13");
		expect(bot.edited.map((entry) => entry.text).join("\n")).not.toContain(
			"↑12",
		);
		await adapter.stop();
	});

	it("renders null live metrics unavailable and a transient status failure generically", async () => {
		const bot = new MockBot();
		let queryFails = false;
		const { adapter } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind !== "session_status") return result(request);
				if (queryFails)
					return {
						requestId: request.requestId,
						ok: false,
						error: { code: "TEMPORARY", message: "private transient detail" },
					};
				return {
					requestId: request.requestId,
					ok: true,
					value: {
						session: sessions.get(request.sessionId) as SessionSummary,
						live: {
							usage: {
								inputTokens: null,
								outputTokens: null,
								cacheReadTokens: null,
								cacheWriteTokens: null,
								costUsd: null,
								contextTokens: null,
								contextWindow: null,
								contextPercent: null,
							},
						},
					},
				} as unknown as TransportResult;
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "/menu");
		expect(bot.sent.at(-1)?.text).toContain("↑— ↓— R— CH— —");
		expect(bot.sent.at(-1)?.text).toContain("↑— ↓— R— CH— — ?/?/— (auto)");
		queryFails = true;
		await bot.update(42, "/menu");
		const text = bot.edited.at(-1)?.text ?? "";
		expect(text).toContain("Живые данные недоступны");
		expect(text).not.toContain("private transient detail");
		await adapter.stop();
	});

	it("shows session name and full identity with Pi-reported context in status", async () => {
		sessions.set("sid", sessionWith("sid", { name: "Focused task" }));
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/status");
		expect(
			bot.sent.some(({ text }) =>
				text.includes("Контекст: 53.3%/145k/272k (auto)"),
			),
		).toBe(true);
		expect(bot.sent.at(-1)?.text).toContain("Сессия: Focused task · sid");
		await adapter.stop();
	});

	it("reloads only the selected session and presents a fixed safe result", async () => {
		sessions.set("sid", sessionWith("sid", { name: "Focused task" }));
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/reload");
		const reload = requests.find((request) => request.kind === "reload");
		expect(reload).toMatchObject({ kind: "reload", sessionId: "sid" });
		if (reload?.kind === "reload") expect(reload.beforeDispatch()).toBe(true);
		expect(bot.sent.at(-1)?.text).toContain("Focused task · #sid");
		expect(bot.sent.at(-1)?.text).toContain("Выбор не изменился");
		await adapter.stop();

		const failedBot = new MockBot();
		const failed = await startAdapter(failedBot, await temp(), {
			dispatch: async (request) =>
				request.kind === "reload"
					? {
							requestId: request.requestId,
							ok: false,
							error: { code: "PI_CONTROL_FAILED", message: "secret detail" },
						}
					: result(request),
		});
		await failedBot.update(42, "/use sid");
		await failedBot.update(42, "/reload");
		expect(failedBot.sent.at(-1)?.text).toContain("Результат неизвестен");
		expect(failedBot.sent.at(-1)?.text).not.toContain("secret detail");
		await failed.adapter.stop();
	});

	it("reports the current message destination if selection changes during reload", async () => {
		sessions.set("sid", sessionWith("sid", { name: "Original" }));
		sessions.set("sid2", {
			...sessionWith("sid", { name: "New target" }),
			id: "sid2" as SessionSummary["id"],
		});
		const bot = new MockBot();
		let started!: () => void;
		let finish!: () => void;
		const reloadStarted = new Promise<void>((resolve) => (started = resolve));
		const reloadFinished = new Promise<void>((resolve) => (finish = resolve));
		const { adapter } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "reload") {
					started();
					await reloadFinished;
				}
				return result(request);
			},
		});
		await bot.update(42, "/use sid");
		const reload = bot.update(42, "/reload");
		await reloadStarted;
		await bot.update(42, "/use sid2");
		finish();
		await reload;
		const text = bot.sent.at(-1)?.text ?? "";
		expect(text).toContain("Перезагружена исходная сессия");
		expect(text).toContain(
			"Обычные сообщения направляются в New target · #sid2",
		);
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
				text.includes("Ввод input-1: uncertain (повторно не отправлялся)"),
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
				text.includes("Ввод input-180: uncertain (повторно не отправлялся)"),
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

	it("updates the local activity timestamp only for semantic tool-state changes", async () => {
		const bot = new MockBot();
		let ticks = 0;
		const { adapter, emit } = await startAdapter(bot, await temp(), {
			activityClock: () => new Date(ticks++ * 1000),
			activityTimeFormatter: (date) => `12:00:0${date.getSeconds()}`,
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "track activity time");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Обновлено: 12:00:00"),
		);
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "tool_start",
				toolCallId: "opaque",
				summary: "bash: test",
			},
		});
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Обновлено: 12:00:01"),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const changedTimestamp = bot.edited
			.at(-1)
			?.text?.match(/Обновлено: (\d{2}:\d{2}:\d{2})/)?.[1];
		expect(changedTimestamp).toBeDefined();
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "tool_start",
				toolCallId: "opaque",
				summary: "bash: test",
			},
		});
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: { type: "tool_end", toolCallId: "missing", failed: false },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(bot.edited.at(-1)?.text).toContain(`Обновлено: ${changedTimestamp}`);
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(bot.edited.at(-1)?.text).toContain(`Обновлено: ${changedTimestamp}`);
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: { type: "tool_end", toolCallId: "opaque", failed: false },
		});
		await vi.waitFor(() => {
			const terminalTimestamp = bot.edited
				.at(-1)
				?.text?.match(/Обновлено: (\d{2}:\d{2}:\d{2})/)?.[1];
			expect(terminalTimestamp).not.toBe(changedTimestamp);
		});
		await adapter.stop();
	});

	it("delivers a completed answer after switching away with a one-time session switch action", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "start background answer");
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "Finished after switch."));
		await bot.update(42, "/use other");
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => text.includes("Finished after switch.")),
			).toBe(true),
		);
		const answer = bot.sent.find(({ text }) =>
			text.includes("Finished after switch."),
		);
		expect(answer?.text).toContain("Фоновая сессия");
		expect(answer?.text).toContain("sid");
		expect(
			callbackData(
				bot.sendOptions[bot.sent.indexOf(answer as (typeof bot.sent)[number])],
				"action:select:",
			),
		).toMatch(/^action:select:/);
		await adapter.stop();
	});

	it("attributes only accepted submissions to a turn and retires recipients at settlement", async () => {
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) =>
				request.kind === "submit" && request.text.includes("reject me")
					? {
							requestId: request.requestId,
							ok: false,
							error: { code: "INVALID_INPUT", message: "rejected" },
						}
					: result(request),
		});
		await bot.update(42, "/use sid");
		await bot.update(43, "/use sid");
		await bot.update(42, "accepted message");
		await vi.waitFor(() =>
			expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(1),
		);
		await bot.update(42, "/use other");
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "pending" },
		});
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "accepted" },
		});
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "owned by chat 42"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "completed" },
		});
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => text.includes("owned by chat 42")),
			).toBe(true),
		);
		expect(
			bot.sent.filter(
				({ chatId, text }) =>
					chatId === 43 && text.includes("owned by chat 42"),
			),
		).toHaveLength(0);

		await bot.update(43, "reject me");
		await bot.update(43, "/use other");
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "rejected input has no ownership"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(
			bot.sent.some(({ text }) =>
				text.includes("rejected input has no ownership"),
			),
		).toBe(false);
		expect(
			[
				...(
					adapter as unknown as {
						inputAttributions: Map<string, { terminal: boolean }>;
					}
				).inputAttributions.values(),
			].filter((record) => !record.terminal),
		).toHaveLength(0);
		await adapter.stop();
	});

	it("retains run ownership when settlement races an accepted submission reply", async () => {
		let accept!: (value: TransportResult) => void;
		let submitRequest: TransportEvent | undefined;
		const gate = new Promise<TransportResult>((resolve) => (accept = resolve));
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "submit") {
					submitRequest = request;
					return gate;
				}
				return result(request);
			},
		});
		await bot.update(42, "/use sid");
		const sending = bot.update(42, "racing accepted input");
		await vi.waitFor(() => expect(submitRequest).toBeDefined());
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "pending" },
		});
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "answer settled before ack"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await bot.update(42, "/use other");
		if (!submitRequest) throw new Error("missing submit request");
		accept(result(submitRequest));
		await sending;
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "accepted" },
		});
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "completed" },
		});
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => text.includes("answer settled before ack")),
			).toBe(true),
		);
		expect(
			bot.sent.find(({ text }) => text.includes("answer settled before ack"))
				?.text,
		).toContain("Фоновая сессия");
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(1);
		await adapter.stop();
	});

	it("attributes uncertain submissions to the active queued turn", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) =>
				request.kind === "submit"
					? {
							requestId: request.requestId,
							ok: false,
							error: {
								code: "UNCERTAIN_INPUT_DELIVERY",
								message: "ack lost",
								inputId: "input-uncertain" as never,
							},
						}
					: result(request),
		});
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "status", "agent_start"));
		await bot.update(42, "queued uncertain message");
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-uncertain" as never, state: "pending" },
		});
		await bot.update(42, "/use other");
		emit(harnessEvent("sid", "output", "uncertain run answer"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => text.includes("uncertain run answer")),
			).toBe(true),
		);
		expect(
			bot.sent.find(({ text }) => text.includes("uncertain run answer"))?.text,
		).toContain("Фоновая сессия");
		await adapter.stop();
	});

	it("retires handled and canceled InputIds without inheriting later run output", async () => {
		let submission = 0;
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind !== "submit") return result(request);
				submission++;
				return { ...result(request), value: `input-${submission}` as never };
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "handled without a run");
		for (const state of ["pending", "accepted", "completed"] as const)
			emit({
				sessionId: "sid" as SessionId,
				kind: "input",
				inputEvent: { inputId: "input-1" as never, state },
			});
		await bot.update(42, "/use other");
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "unrelated later run"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await bot.update(42, "/use sid");
		await bot.update(42, "input canceled during its run");
		await bot.update(42, "/use other");
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-2" as never, state: "pending" },
		});
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "canceled run output"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: {
				inputId: "input-2" as never,
				state: "failed",
				detail: "Input canceled",
			},
		});
		const waitForEventQueue = (
			adapter as unknown as {
				waitForEventQueue: (chatId: number) => Promise<boolean>;
			}
		).waitForEventQueue.bind(adapter);
		await waitForEventQueue(42);
		expect(
			bot.sent.some(({ text }) => text.includes("unrelated later run")),
		).toBe(false);
		expect(
			bot.sent.some(({ text }) => text.includes("canceled run output")),
		).toBe(false);
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(2);
		await adapter.stop();
	});

	it("reassociates a steered pending input with the next run after settlement", async () => {
		let submission = 0;
		let releaseSecond!: (value: TransportResult) => void;
		let secondRequest: TransportEvent | undefined;
		const secondGate = new Promise<TransportResult>(
			(resolve) => (releaseSecond = resolve),
		);
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind !== "submit") return result(request);
				submission++;
				if (submission === 2) {
					secondRequest = request;
					return secondGate;
				}
				return { ...result(request), value: "input-first" as never };
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "first run input");
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-first" as never, state: "pending" },
		});
		emit(harnessEvent("sid", "status", "agent_start"));
		await bot.update(43, "/use sid");
		const secondSend = bot.update(43, "held until cancellation settles");
		await vi.waitFor(() => expect(secondRequest).toBeDefined());
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-second" as never, state: "pending" },
		});
		await bot.update(42, "/use other");
		await bot.update(43, "/use other");
		emit(harnessEvent("sid", "output", "preceding run output"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-first" as never, state: "completed" },
		});
		const waitForEventQueue = (
			adapter as unknown as {
				waitForEventQueue: (chatId: number) => Promise<boolean>;
			}
		).waitForEventQueue.bind(adapter);
		await Promise.all([waitForEventQueue(42), waitForEventQueue(43)]);
		if (!secondRequest) throw new Error("missing second submit request");
		const acceptedSecond = result(secondRequest);
		if (!acceptedSecond.ok) throw new Error("second submission was rejected");
		releaseSecond({ ...acceptedSecond, value: "input-second" as never });
		await secondSend;
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "following run output"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-second" as never, state: "completed" },
		});
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => text.includes("following run output")),
			).toBe(true),
		);
		await Promise.all([waitForEventQueue(42), waitForEventQueue(43)]);
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "unrelated subsequent run"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await Promise.all([waitForEventQueue(42), waitForEventQueue(43)]);
		expect(
			bot.sent.some(({ text }) => text.includes("unrelated subsequent run")),
		).toBe(false);
		expect(
			bot.sent.some(
				({ chatId, text }) =>
					chatId === 42 && text.includes("preceding run output"),
			),
		).toBe(true);
		expect(
			bot.sent.some(
				({ chatId, text }) =>
					chatId === 43 && text.includes("preceding run output"),
			),
		).toBe(false);
		expect(
			bot.sent.some(
				({ chatId, text }) =>
					chatId === 43 && text.includes("following run output"),
			),
		).toBe(true);
		expect(
			bot.sent.some(
				({ chatId, text }) =>
					chatId === 42 && text.includes("following run output"),
			),
		).toBe(false);
		expect(
			bot.sent.find(({ text }) => text.includes("following run output"))?.text,
		).toContain("Фоновая сессия");
		await adapter.stop();
	});

	it("keeps a canceling input on its old run while a later prompt waits for the abort gate", async () => {
		let submitCount = 0;
		let releaseCancel!: (value: TransportResult) => void;
		let releaseNext!: (value: TransportResult) => void;
		let nextRequest: TransportEvent | undefined;
		const cancelGate = new Promise<TransportResult>(
			(resolve) => (releaseCancel = resolve),
		);
		const nextGate = new Promise<TransportResult>(
			(resolve) => (releaseNext = resolve),
		);
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (request.kind === "cancel") return cancelGate;
				if (request.kind !== "submit") return result(request);
				submitCount++;
				if (submitCount === 2) {
					nextRequest = request;
					return nextGate;
				}
				return { ...result(request), value: "cancel-owner" as never };
			},
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "input that will be canceled");
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "cancel-owner" as never, state: "pending" },
		});
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "cancel-owner" as never, state: "accepted" },
		});
		emit(harnessEvent("sid", "status", "agent_start"));
		const cancel = bot.update(42, "/cancel cancel-owner");
		await vi.waitFor(() =>
			expect(requests.filter(({ kind }) => kind === "cancel")).toHaveLength(1),
		);
		const next = bot.update(42, "prompt after cancellation");
		await vi.waitFor(() => expect(nextRequest).toBeDefined());
		await bot.update(42, "/use other");
		emit(harnessEvent("sid", "output", "canceled run partial output"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		const canceled = result(
			requests.find(({ kind }) => kind === "cancel") as TransportEvent,
		);
		if (!canceled.ok) throw new Error("cancel fixture was rejected");
		releaseCancel(canceled);
		await cancel;
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: {
				inputId: "cancel-owner" as never,
				state: "failed",
				detail: "Input canceled",
			},
		});
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-after-cancel" as never, state: "pending" },
		});
		if (!nextRequest) throw new Error("missing queued submit request");
		const accepted = result(nextRequest);
		if (!accepted.ok) throw new Error("queued submission was rejected");
		releaseNext({ ...accepted, value: "input-after-cancel" as never });
		await next;
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", "post-cancel run answer"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: {
				inputId: "input-after-cancel" as never,
				state: "completed",
			},
		});
		const waitForEventQueue = (
			adapter as unknown as {
				waitForEventQueue: (chatId: number) => Promise<boolean>;
			}
		).waitForEventQueue.bind(adapter);
		await waitForEventQueue(42);
		expect(
			bot.sent.some(({ text }) => text.includes("canceled run partial output")),
		).toBe(false);
		expect(
			bot.sent.some(({ text }) => text.includes("post-cancel run answer")),
		).toBe(true);
		expect(
			bot.sent.find(({ text }) => text.includes("post-cancel run answer"))
				?.text,
		).toContain("Фоновая сессия");
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
		expect(bot.api.editMessageText).not.toHaveBeenCalled();
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
		expect(text).toContain("✓ Shared name · #sid · running (работает) · /work");
		expect(text).toContain(
			"Shared name · #other · running (работает) · /other",
		);
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
		sessions.set("other", sessionWith("other", { status: "running" }));
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
			`Новая сессия будет создана в ${directory}`,
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

	it("caps the folder panel independently and explains how to reach other paths", async () => {
		const directory = await temp();
		for (let index = 0; index < 105; index++) {
			await writeFile(path.join(directory, `a-file-${index}.txt`), "");
			await mkdir(path.join(directory, `z-folder-${index}`));
		}
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp(), {
			initialCwd: directory,
		});
		await bot.update(42, "/menu");
		await bot.callback(42, "menu:folders", bot.lastMessageId);
		expect(bot.edited.at(-1)?.text).toContain(
			"Показаны первые 100 папок из 105",
		);
		expect(bot.edited.at(-1)?.text).toContain("/cd <путь>");
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
			`Новая сессия будет создана в ${childDirectory}`,
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

	it("keeps slash resume unselected and offers an explicit Select action", async () => {
		sessions.set("other", {
			...sessionWith("sid", { status: "stopped" }),
			id: "other" as SessionId,
		});
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/resume other");
		const select = callbackData(bot.sendOptions.at(-1), "action:select:");
		const selectMessageId = bot.lastMessageId as number;
		expect(
			requests.findLast((request) => request.kind === "resume"),
		).toMatchObject({
			kind: "resume",
			sessionId: "other",
		});
		expect(bot.sent.at(-1)?.text).toContain("не выбрана");
		expect(bot.sendOptions.at(-1)).toMatchObject({
			reply_markup: {
				inline_keyboard: [
					[
						expect.objectContaining({
							text: "Выбрать",
							callback_data: expect.stringMatching(/^action:select:/),
						}),
					],
				],
			},
		});
		await bot.update(42, "still goes to sid");
		expect(
			requests.findLast((request) => request.kind === "submit"),
		).toMatchObject({
			kind: "submit",
			sessionId: "sid",
		});
		await bot.callback(42, select, selectMessageId + 1);
		await bot.update(42, "wrong-message callback changed nothing");
		expect(
			requests.findLast((request) => request.kind === "submit"),
		).toMatchObject({ sessionId: "sid" });
		await bot.callback(42, select, selectMessageId);
		await bot.update(42, "bound Select callback changed target");
		expect(
			requests.findLast((request) => request.kind === "submit"),
		).toMatchObject({ sessionId: "other" });
		await adapter.stop();
	});

	it("keeps slash resume selection unchanged and omits Select when target already matches", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/resume");
		expect(bot.sent.at(-1)?.text).toContain("Выбор не изменён");
		expect(bot.sent.at(-1)?.text).toContain(
			"обычные сообщения по-прежнему направляются в эту сессию",
		);
		expect(bot.sendOptions.at(-1)).toBeUndefined();
		await bot.update(42, "after selected resume");
		expect(
			requests.findLast((request) => request.kind === "submit"),
		).toMatchObject({
			kind: "submit",
			sessionId: "sid",
		});
		await adapter.stop();
	});

	it("panel Resume distinguishes an already-selected session from a different target", async () => {
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		sessions.set("sid", sessionWith("sid", { status: "stopped" }));
		await bot.update(42, "/menu");
		const panelId = bot.lastMessageId as number;
		await bot.callback(42, "session:resume:sid", panelId);
		expect(bot.sent.at(-1)?.text).toContain(
			"Выбор не изменён; обычные сообщения по-прежнему направляются в эту сессию.",
		);
		expect(bot.sent.at(-1)?.text).not.toContain("not selected");
		sessions.set("sid", sessionWith("sid", { status: "stopped" }));
		await bot.update(42, "/use other");
		await bot.callback(42, "session:resume:sid", panelId);
		expect(bot.sent.at(-1)?.text).toContain(
			"обычные сообщения направляются в #other",
		);
		expect(bot.sent.at(-1)?.text).toContain("не выбрана");
		await adapter.stop();
	});

	it("gates stopped controls and offers chat-scoped resume and select", async () => {
		sessions.set("sid", sessionWith("sid", { status: "stopped" }));
		sessions.set("other", {
			...sessionWith("sid", { status: "running" }),
			id: "other" as SessionId,
		});
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(43, "/use other");
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		await bot.callback(42, "menu:models", panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain("Pi is stopped");
		expect(requests.some((request) => request.kind === "model_list")).toBe(
			false,
		);
		await bot.update(42, "/use other");
		await bot.callback(42, "session:resume-select:sid", panelMessageId);
		expect(
			requests.findLast((request) => request.kind === "resume"),
		).toMatchObject({
			kind: "resume",
			sessionId: "sid",
		});
		await bot.update(42, "message routed to resumed session");
		await bot.update(43, "other chat remains selected");
		expect(requests.filter((request) => request.kind === "submit")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sessionId: "sid" }),
				expect.objectContaining({ sessionId: "other" }),
			]),
		);
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(2);
		await adapter.stop();
	});

	it("offers a one-time stopped-session resume-and-select action after slash stop", async () => {
		const bot = new MockBot();
		const directory = await temp();
		const { adapter, requests } = await startAdapter(bot, directory);
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId as number;
		await bot.update(42, "/use sid");
		await bot.update(42, "/stop");
		const action = callbackData(
			bot.sendOptions.at(-1),
			"action:resume-select:",
		);
		const actionMessageId = bot.lastMessageId as number;
		expect(bot.sent.at(-1)?.text).toContain(
			"Возобновите её кнопкой ниже с выбором",
		);
		await bot.callback(43, action, actionMessageId);
		expect(
			requests.filter((request) => request.kind === "resume"),
		).toHaveLength(0);
		const pinsBeforeAction = bot.pinned.length;
		await bot.callback(42, action, actionMessageId);
		expect(bot.sent.at(-1)?.text).toContain("возобновлена и выбрана");
		expect(bot.edited.at(-1)?.messageId).toBe(panelMessageId);
		expect(bot.pinned).toHaveLength(pinsBeforeAction);
		const stateFile = (await readdir(directory)).find((name) =>
			name.startsWith("telegram-panels-"),
		);
		if (!stateFile) throw new Error("Missing Telegram state file");
		const panelState = await readFile(path.join(directory, stateFile), "utf8");
		expect(panelState).toContain(String(panelMessageId));
		expect(panelState).not.toContain(String(actionMessageId));
		await bot.callback(42, action, actionMessageId);
		expect(
			requests.filter((request) => request.kind === "resume"),
		).toHaveLength(1);
		await bot.update(42, "message goes to resumed target");
		expect(
			requests.findLast((request) => request.kind === "submit"),
		).toMatchObject({
			kind: "submit",
			sessionId: "sid",
		});
		await adapter.stop();
	});

	it("warns when resume succeeds but saving the new selection fails", async () => {
		const directory = await temp();
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, directory);
		await bot.update(42, "/use other");
		await bot.update(42, "/stop sid");
		const action = callbackData(
			bot.sendOptions.at(-1),
			"action:resume-select:",
		);
		const stateFile = (await readdir(directory)).find((name) =>
			name.startsWith("telegram-panels-"),
		);
		if (!stateFile) throw new Error("Missing Telegram state file");
		const statePath = path.join(directory, stateFile);
		await rm(statePath);
		await mkdir(statePath);
		await writeFile(path.join(statePath, "occupied"), "x");
		await bot.callback(42, action, bot.lastMessageId as number);
		expect(bot.sent.at(-1)?.text).toContain("возобновлена и выбрана");
		expect(bot.sent.at(-1)?.text).toContain(
			"сохранить выбор для следующего запуска не удалось",
		);
		await bot.update(42, "still targets resumed session");
		expect(
			requests.findLast((request) => request.kind === "submit"),
		).toMatchObject({
			kind: "submit",
			sessionId: "sid",
		});
		await adapter.stop();
	});

	it("offers callback Stop a one-time bound Resume-and-select action", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/menu");
		const panelId = bot.lastMessageId as number;
		await bot.callback(42, "menu:sessions", panelId);
		await bot.callback(42, "session:details:sid", panelId);
		await bot.callback(42, "session:stop:sid", panelId);
		const confirm = callbackData(bot.edited.at(-1)?.options, "action:confirm:");
		await bot.callback(42, confirm, panelId);
		const resume = callbackData(
			bot.sendOptions.at(-1),
			"action:resume-select:",
		);
		const actionMessageId = bot.lastMessageId as number;
		await bot.callback(43, resume, actionMessageId);
		await bot.callback(42, resume, actionMessageId);
		expect(bot.sent.at(-1)?.text).toContain("возобновлена и выбрана");
		expect(
			requests.filter((request) => request.kind === "resume"),
		).toHaveLength(1);
		expect(bot.sent.at(-1)?.text).toContain("возобновлена и выбрана");
		await adapter.stop();
	});

	it("does not select or claim success when resume-select resume fails", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: (request) =>
				request.kind === "resume"
					? Promise.resolve({
							requestId: request.requestId,
							ok: false,
							error: { code: "FAILED", message: "resume failed" },
						})
					: Promise.resolve(result(request)),
		});
		await bot.update(42, "/use other");
		await bot.update(42, "/stop sid");
		const action = callbackData(
			bot.sendOptions.at(-1),
			"action:resume-select:",
		);
		await bot.callback(42, action, bot.lastMessageId as number);
		expect(bot.sent.at(-1)?.text).toContain("resume failed");
		expect(bot.sent.at(-1)?.text).toContain("Selection is unchanged");
		expect(bot.sent.at(-1)?.text).not.toContain("resumed and selected");
		await bot.update(42, "still targets other");
		expect(
			requests.findLast((request) => request.kind === "submit"),
		).toMatchObject({ sessionId: "other" });
		await adapter.stop();
	});

	it("keeps resume-select epoch alive while inspect is in flight", async () => {
		let releaseInspect: ((value: TransportResult) => void) | undefined;
		let deferInspect = false;
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: (request) => {
				if (deferInspect && request.kind === "inspect")
					return new Promise((resolve) => {
						releaseInspect = resolve;
					});
				return Promise.resolve(result(request));
			},
		});
		await bot.update(42, "/use other");
		await bot.update(42, "/stop sid");
		const action = callbackData(
			bot.sendOptions.at(-1),
			"action:resume-select:",
		);
		deferInspect = true;
		const callback = bot.callback(42, action, bot.lastMessageId as number);
		await vi.waitFor(() => expect(releaseInspect).toBeDefined());
		deferInspect = false;
		await bot.update(42, "/resume sid");
		const inspected = sessions.get("sid");
		if (!inspected) throw new Error("Missing session fixture");
		releaseInspect?.({
			requestId: "deferred",
			ok: true,
			value: { ...inspected, status: "stopped" },
		});
		await callback;
		expect(
			requests.filter((request) => request.kind === "resume"),
		).toHaveLength(1);
		await bot.update(42, "selection remains other");
		expect(
			requests.findLast((request) => request.kind === "submit"),
		).toMatchObject({ sessionId: "other" });
		await adapter.stop();
	});

	it("does not dispatch resume when stop invalidates it while waiting for the inbox lock", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use other");
		await bot.update(42, "/stop sid");
		const action = callbackData(
			bot.sendOptions.at(-1),
			"action:resume-select:",
		);
		const inspectBaseline = requests.filter(
			(request) => request.kind === "inspect",
		).length;
		let releaseLock!: () => void;
		let announceLock!: () => void;
		let announceCallbackQueued!: () => void;
		let lockHeld = false;
		const lockStarted = new Promise<void>(
			(resolve) => (announceLock = resolve),
		);
		const callbackQueued = new Promise<void>(
			(resolve) => (announceCallbackQueued = resolve),
		);
		const lockGate = new Promise<void>((resolve) => (releaseLock = resolve));
		const inbox = (
			adapter as unknown as {
				inbox: {
					withSessionLock: (
						id: SessionId,
						fn: () => Promise<void>,
					) => Promise<void>;
				};
			}
		).inbox;
		const withSessionLock = inbox.withSessionLock.bind(inbox);
		inbox.withSessionLock = (id, operation) => {
			const queued = withSessionLock(id, operation);
			if (lockHeld && id === ("sid" as SessionId)) announceCallbackQueued();
			return queued;
		};
		const heldLock = inbox.withSessionLock("sid" as SessionId, async () => {
			lockHeld = true;
			announceLock();
			await lockGate;
		});
		await lockStarted;
		const callback = bot.callback(42, action, bot.lastMessageId as number);
		await vi.waitFor(() =>
			expect(
				requests.filter((request) => request.kind === "inspect"),
			).toHaveLength(inspectBaseline + 1),
		);
		await callbackQueued;
		expect(
			requests.filter((request) => request.kind === "inspect"),
		).toHaveLength(inspectBaseline + 1);
		await bot.update(42, "/stop sid");
		releaseLock();
		await Promise.all([heldLock, callback]);
		expect(
			requests.filter((request) => request.kind === "resume"),
		).toHaveLength(0);
		await bot.update(42, "still targets other");
		expect(
			requests.findLast((request) => request.kind === "submit"),
		).toMatchObject({
			sessionId: "other",
		});
		await adapter.stop();
	});

	it("does not dispatch resume if lifecycle state changes while waiting for the inbox lock", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use other");
		await bot.update(42, "/stop sid");
		const action = callbackData(
			bot.sendOptions.at(-1),
			"action:resume-select:",
		);
		const inspectBaseline = requests.filter(
			(request) => request.kind === "inspect",
		).length;
		let releaseLock!: () => void;
		let announceLock!: () => void;
		let announceCallbackQueued!: () => void;
		let lockHeld = false;
		const lockStarted = new Promise<void>(
			(resolve) => (announceLock = resolve),
		);
		const callbackQueued = new Promise<void>(
			(resolve) => (announceCallbackQueued = resolve),
		);
		const lockGate = new Promise<void>((resolve) => (releaseLock = resolve));
		const inbox = (
			adapter as unknown as {
				inbox: {
					withSessionLock: (
						id: SessionId,
						fn: () => Promise<void>,
					) => Promise<void>;
				};
			}
		).inbox;
		const withSessionLock = inbox.withSessionLock.bind(inbox);
		inbox.withSessionLock = (id, operation) => {
			const queued = withSessionLock(id, operation);
			if (lockHeld && id === ("sid" as SessionId)) announceCallbackQueued();
			return queued;
		};
		const heldLock = inbox.withSessionLock("sid" as SessionId, async () => {
			lockHeld = true;
			announceLock();
			await lockGate;
		});
		await lockStarted;
		const callback = bot.callback(42, action, bot.lastMessageId as number);
		await vi.waitFor(() =>
			expect(
				requests.filter((request) => request.kind === "inspect"),
			).toHaveLength(inspectBaseline + 1),
		);
		await callbackQueued;
		expect(
			requests.filter((request) => request.kind === "inspect"),
		).toHaveLength(inspectBaseline + 1);
		const current = sessions.get("sid");
		if (!current) throw new Error("Missing session fixture");
		sessions.set("sid", { ...current, status: "running" });
		releaseLock();
		await Promise.all([heldLock, callback]);
		expect(
			requests.filter((request) => request.kind === "resume"),
		).toHaveLength(0);
		await bot.update(42, "still targets other");
		expect(
			requests.findLast((request) => request.kind === "submit"),
		).toMatchObject({
			sessionId: "other",
		});
		await adapter.stop();
	});

	it("rejects a stopped-session resume action after the session state changes", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "/stop");
		const action = callbackData(
			bot.sendOptions.at(-1),
			"action:resume-select:",
		);
		const current = sessions.get("sid");
		if (!current) throw new Error("Missing session fixture");
		sessions.set("sid", { ...current, status: "running" });
		await bot.callback(42, action, bot.lastMessageId as number);
		expect(
			requests.filter((request) => request.kind === "resume"),
		).toHaveLength(0);
		expect(bot.sent.at(-1)?.text).toContain("no longer stopped");
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
		expect(bot.sent.at(-1)?.text).toContain("not stopped");
		expect(requests.some((request) => request.kind === "delete")).toBe(false);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		await bot.callback(42, "session:stop:sid", panelMessageId);
		const stopToken = callbackData(
			bot.edited.at(-1)?.options,
			"action:confirm:",
		);
		await bot.callback(42, stopToken, panelMessageId);
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
		sessions.set("sid", sessionWith("sid", { status: "stopped" }));
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

	it("retires volatile turn and confirmation state during lifecycle churn", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		for (let index = 0; index < 200; index++) {
			emit(harnessEvent(`churn-${index}`, "status", "agent_start"));
			emit(harnessEvent(`churn-${index}`, "status", "agent_settled"));
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			(adapter as unknown as { confirmationEpochs: Map<SessionId, number> })
				.confirmationEpochs.size,
		).toBe(0);
		expect(
			(adapter as unknown as { turnBuffers: Map<SessionId, unknown> })
				.turnBuffers.size,
		).toBe(0);
		expect(
			(adapter as unknown as { inputAttributions: Map<string, unknown> })
				.inputAttributions.size,
		).toBe(0);
		await adapter.stop();
	});

	it("does not resend after an uncertain panel edit and recovers a known-deleted panel", async () => {
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/menu");
		const sendsAfterCreate = bot.api.sendMessage.mock.calls.length;
		sessions.set("sid", sessionWith("sid", { name: "changed before failure" }));
		bot.api.editMessageText.mockRejectedValueOnce(
			new Error("temporary API failure"),
		);
		await bot.update(42, "/menu");
		expect(bot.api.sendMessage).toHaveBeenCalledTimes(sendsAfterCreate + 1);
		expect(bot.sent.at(-1)?.text).toContain("Не удалось обновить панель");
		expect(callbackData(bot.sendOptions.at(-1), "panel:refresh")).toBe(
			"panel:refresh",
		);

		bot.api.editMessageText.mockRejectedValueOnce(
			Object.assign(new Error("Telegram rejected edit"), {
				description: "Bad Request: message to edit not found",
			}),
		);
		await bot.update(42, "/menu");
		expect(bot.api.sendMessage).toHaveBeenCalledTimes(sendsAfterCreate + 2);
		expect(bot.api.pinChatMessage).toHaveBeenCalledTimes(2);
		await bot.update(42, "/sessions");
		expect(bot.sent.at(-1)?.text).toContain("#sid");
		await adapter.stop();
	});

	it("refreshes a stale panel from its notice without adopting or repinning the notice", async () => {
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/menu");
		const panelId = (
			adapter as unknown as { panelMessageIds: Map<number, number> }
		).panelMessageIds.get(42);
		const pinCount = bot.pinned.length;
		sessions.set("sid", sessionWith("sid", { name: "changed before failure" }));
		bot.api.editMessageText.mockRejectedValueOnce(
			new Error("temporary failure"),
		);
		await bot.update(42, "/menu");
		const noticeId = bot.lastMessageId;
		expect(noticeId).not.toBe(panelId);
		const sentBeforeRefresh = bot.api.sendMessage.mock.calls.length;
		await bot.callback(42, "panel:refresh", noticeId);
		expect(bot.edited.at(-1)?.messageId).toBe(panelId);
		expect(bot.pinned).toHaveLength(pinCount);
		expect(bot.api.sendMessage).toHaveBeenCalledTimes(sentBeforeRefresh);
		expect(JSON.stringify(bot.edited.at(-1)?.options)).not.toContain(
			"panel:refresh",
		);
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
		sessions.set("sid", sessionWith("sid", { status: "stopped" }));
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
		await firstBot.update(42, "/menu");
		await firstBot.update(43, "/use other");
		await first.adapter.stop();

		const sidAfterStop = sessions.get("sid");
		const other = sessions.get("other");
		if (!sidAfterStop || !other) throw new Error("Missing session fixture");
		sessions.set("sid", { ...sidAfterStop, status: "stopped" });
		sessions.set("other", { ...other, status: "stopped" });

		const secondBot = new MockBot();
		const second = await startAdapter(secondBot, directory);
		expect(secondBot.edited.at(-1)?.text).toContain(
			"устарело после перезапуска",
		);
		expect(second.requests).toEqual([]);
		await secondBot.update(42, "/use");
		expect(secondBot.sent.at(-1)?.text).toContain("Выбрана");
		expect(secondBot.sent.at(-1)?.text).toContain(
			"Новое сообщение возобновит её",
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
		sessions.set("other", {
			...sessionWith("sid", { status: "stopped" }),
			id: "other" as SessionId,
		});
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
		await bot.update(42, "text reply routes directly to source", {
			replyToMessageId: sourceId,
		});
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(4);
		expect(
			requests.filter(({ kind }) => kind === "submit").at(-1),
		).toMatchObject({
			sessionId: "sid",
		});
		await bot.update(42, "/use other");
		fetchFile.mockClear();

		await bot.updatePhoto(42, undefined, 42, sourceId);
		await vi.waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(1));
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(5);
		expect(
			requests.filter(({ kind }) => kind === "submit").at(-1),
		).toMatchObject({
			sessionId: "sid",
		});

		await bot.updateDocument(42, { replyToMessageId: 999999 });
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(5);
		const unknownReply = bot.sent.at(-1);
		const selectedTarget = callbackData(
			bot.sendOptions.at(-1),
			"reply:",
		).replace(/:[sx]$/, ":c");
		await bot.callback(42, selectedTarget, unknownReply?.message_id);
		await vi.waitFor(() =>
			expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(6),
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
		await restartedBot.update(42, "spoofed text", {
			replyToMessageId: output?.message_id,
			replyToMessageText: output?.text,
			replySenderIsBot: false,
		});
		expect(restarted.requests.some(({ kind }) => kind === "submit")).toBe(
			false,
		);
		expect(restartedBot.sent.at(-1)?.text).toContain(
			"Источник ответа неизвестен",
		);
		await restartedBot.update(42, "spoofed bot text", {
			replyToMessageId: output?.message_id,
			replyToMessageText: output?.text,
			replySenderId: 998,
		});
		expect(restarted.requests.some(({ kind }) => kind === "submit")).toBe(
			false,
		);
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

	it.each([undefined, "Named session"])(
		"routes %s multipart assistant footers after restart",
		async (name) => {
			const previous = sessions.get("sid");
			if (!previous) throw new Error("missing session fixture");
			sessions.set("sid", {
				...previous,
				...(name ? { name } : { name: undefined }),
			});
			const stateDirectory = await temp();
			const firstBot = new MockBot();
			const first = await startAdapter(firstBot, stateDirectory);
			await firstBot.update(42, "/use sid");
			first.emit(harnessEvent("sid", "status", "agent_start"));
			first.emit(
				harnessEvent("sid", "output", `Large answer ${"x".repeat(10_000)}`),
			);
			first.emit(harnessEvent("sid", "status", "agent_settled"));
			await vi.waitFor(() =>
				expect(firstBot.sent.some(({ text }) => / · 1\/\d+$/.test(text))).toBe(
					true,
				),
			);
			const part = firstBot.sent.find(({ text }) => / · 1\/\d+$/.test(text));
			expect(part).toBeDefined();
			await first.adapter.stop();

			const restartedBot = new MockBot();
			const restarted = await startAdapter(restartedBot, stateDirectory);
			await restartedBot.update(42, "reply to first part", {
				replyToMessageId: part?.message_id,
				replyToMessageText: part?.text,
			});
			expect(
				restarted.requests.filter(({ kind }) => kind === "submit"),
			).toHaveLength(1);
			await restarted.adapter.stop();
			sessions.set("sid", previous);
		},
	);

	it.each([
		{ oldName: "Previous name", currentName: "Renamed session" },
		{ oldName: undefined, currentName: "Named after reply" },
	])(
		"routes historical footer after name changes from $oldName",
		async ({ oldName, currentName }) => {
			const previous = sessions.get("sid");
			if (!previous) throw new Error("missing session fixture");
			sessions.set("sid", {
				...previous,
				...(oldName ? { name: oldName } : { name: undefined }),
			});
			const stateDirectory = await temp();
			const firstBot = new MockBot();
			const first = await startAdapter(firstBot, stateDirectory);
			await firstBot.update(42, "/use sid");
			first.emit(harnessEvent("sid", "status", "agent_start"));
			first.emit(harnessEvent("sid", "output", "historical name answer"));
			first.emit(harnessEvent("sid", "status", "agent_settled"));
			await vi.waitFor(() =>
				expect(
					firstBot.sent.some(({ text }) =>
						text.includes("historical name answer"),
					),
				).toBe(true),
			);
			const answer = firstBot.sent.find(({ text }) =>
				text.includes("historical name answer"),
			);
			await first.adapter.stop();
			sessions.set("sid", { ...previous, name: currentName });
			const restartedBot = new MockBot();
			const restarted = await startAdapter(restartedBot, stateDirectory);
			await restartedBot.update(42, "reply to old generated footer", {
				replyToMessageId: answer?.message_id,
				replyToMessageText: answer?.text,
			});
			expect(
				restarted.requests.filter(({ kind }) => kind === "submit"),
			).toHaveLength(1);
			if (oldName && answer?.text) {
				await restartedBot.update(42, "reject malformed historical name", {
					replyToMessageId: answer.message_id,
					replyToMessageText: answer.text.replace(
						oldName,
						"Previous\u0085name",
					),
				});
				expect(
					restarted.requests.filter(({ kind }) => kind === "submit"),
				).toHaveLength(1);
			}
			await restarted.adapter.stop();
			sessions.set("sid", previous);
		},
	);

	it("rejects restarted text and media replies to the generated long-path create prompt", async () => {
		const cwd = `/workspace/${"long".repeat(1100)}`;
		const stateDirectory = await temp();
		const fetchFile = stubFileDownload();
		const firstBot = new MockBot();
		const first = await startAdapter(firstBot, stateDirectory, {
			initialCwd: cwd,
		});
		await firstBot.update(42, "/menu");
		await firstBot.callback(42, "menu:new", firstBot.lastMessageId);
		const promptId = firstBot.lastForceReplyMessageId;
		const prompt = firstBot.sent.find(
			({ message_id }) => message_id === promptId,
		);
		expect(cwd.length).toBeGreaterThan(4096);
		expect(prompt?.text).toBe(
			"Назовите сессию (запрос имени harnessd):\nТочная папка указана в предыдущих сообщениях. Ответьте названием. Ниже есть кнопки «Создать без имени» и «Отмена».",
		);
		await first.adapter.stop();

		const restartedBot = new MockBot();
		const restarted = await startAdapter(restartedBot, stateDirectory);
		await restartedBot.update(42, "stale text", {
			replyToMessageId: promptId,
			replyToMessageText: prompt?.text,
		});
		await restartedBot.updateDocument(42, {
			replyToMessageId: promptId,
			replyToMessageText: prompt?.text,
		});
		expect(restarted.requests.some(({ kind }) => kind === "submit")).toBe(
			false,
		);
		expect(fetchFile).not.toHaveBeenCalled();
		expect(
			restartedBot.sent.some(({ text }) =>
				text.includes("Запрос имени устарел"),
			),
		).toBe(true);
		await restarted.adapter.stop();
	});

	it.each([
		{ label: "unnamed", name: undefined },
		{ label: "named", name: "A named session" },
	])(
		"rejects restarted replies to generated $label rename prompts",
		async ({ name }) => {
			for (const [cwdCase, cwd] of [
				["Unicode separators", `/workspace\u2028subdir\u2029end`],
				["long fallback", `/workspace/${"long".repeat(1000)}`],
			] as const) {
				const fetchFile = stubFileDownload();
				const stateDirectory = await temp();
				const previousSession = sessions.get("sid");
				sessions.set("sid", sessionWith("sid", { cwd, name }));
				const firstBot = new MockBot();
				const first = await startAdapter(firstBot, stateDirectory);
				await firstBot.update(42, "/use sid");
				await firstBot.update(42, "/menu");
				await firstBot.callback(
					42,
					"session:rename:sid",
					firstBot.lastMessageId,
				);
				const promptId = firstBot.lastForceReplyMessageId;
				const prompt = firstBot.sent.find(
					({ message_id }) => message_id === promptId,
				);
				const label = name ? `${name} · #sid` : "#sid";
				expect(prompt?.text).toContain(`Переименовать ${label} (#sid)`);
				if (cwdCase === "long fallback")
					expect(prompt?.text).toContain(
						"точной папке из предыдущих сообщений",
					);
				else expect(prompt?.text).toContain(cwd);
				await first.adapter.stop();

				const restartedBot = new MockBot();
				const restarted = await startAdapter(restartedBot, stateDirectory);
				await restartedBot.update(42, "stale text", {
					replyToMessageId: promptId,
					replyToMessageText: prompt?.text,
				});
				await restartedBot.updateDocument(42, {
					replyToMessageId: promptId,
					replyToMessageText: prompt?.text,
				});
				expect(restarted.requests.some(({ kind }) => kind === "submit")).toBe(
					false,
				);
				expect(fetchFile).not.toHaveBeenCalled();
				expect(
					restartedBot.sent.some(({ text }) =>
						text.includes("Запрос имени устарел"),
					),
				).toBe(true);
				await restarted.adapter.stop();
				if (previousSession) sessions.set("sid", previousSession);
			}
		},
	);

	it.each([
		{
			label: "create exact path",
			body: "New session will be created in /work/project. Reply with a name. Create unnamed and Cancel buttons are below.",
		},
		{
			label: "create multipart fallback",
			body: "The exact folder is shown in the preceding messages. Reply with a name. Create unnamed and Cancel buttons are below.",
		},
		{
			label: "unnamed rename exact path",
			body: "Rename #sid (#sid) in /work/project. Reply with a name; use Cancel below.",
		},
		{
			label: "named rename exact path",
			body: "Rename A named session · #sid (#sid) in /work/project. Reply with a name; use Cancel below.",
		},
		{
			label: "named rename multipart fallback",
			body: "Rename A named session · #sid (#sid) in the exact folder shown in the preceding messages. Reply with a name; use Cancel below.",
		},
	])(
		"rejects stale text and media for legacy English $label prompts after restart",
		async ({ body }) => {
			const fetchFile = stubFileDownload();
			const bot = new MockBot();
			const { adapter, requests } = await startAdapter(bot, await temp());
			await bot.update(42, "/use sid");
			const envelope = `Name this session (harnessd name prompt):\n${body}`;
			await bot.update(42, "stale name", {
				replyToMessageId: 9876,
				replyToMessageText: envelope,
			});
			await bot.updateDocument(42, {
				replyToMessageId: 9876,
				replyToMessageText: envelope,
			});
			expect(fetchFile).not.toHaveBeenCalled();
			expect(
				requests.some(({ kind }) =>
					["submit", "create", "rename"].includes(kind),
				),
			).toBe(false);
			expect(bot.sent.at(-2)?.text).toBe(
				"Запрос имени устарел. Начните действие заново.",
			);
			expect(bot.sent.at(-1)?.text).toBe(
				"Запрос имени устарел или требует текстового ответа; вложение не отправлено.",
			);
			expect(
				bot.sent.some(({ text }) => text.includes("Выберите, куда отправить")),
			).toBe(false);
			await adapter.stop();
		},
	);

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
		expect(requests.some((request) => request.kind === "submit")).toBe(false);
		const unknownSourceChoice = bot.sent.at(-1);
		const targetChoice = callbackData(bot.sendOptions.at(-1), "reply:").replace(
			/:[sx]$/,
			":c",
		);
		await bot.callback(42, targetChoice, unknownSourceChoice?.message_id);
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(1);
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

	it("rechecks confirmed-current media selection after inspection before saving", async () => {
		stubFileDownload();
		const previousSession = sessions.get("sid");
		if (!previousSession) throw new Error("missing session fixture");
		sessions.set("sid", { ...previousSession, cwd: await temp() });
		let releaseInspect!: () => void;
		let signalInspect!: () => void;
		let deferInspect = false;
		const inspectGate = new Promise<void>(
			(resolve) => (releaseInspect = resolve),
		);
		const inspectStarted = new Promise<void>(
			(resolve) => (signalInspect = resolve),
		);
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp(), {
			dispatch: async (request) => {
				if (
					deferInspect &&
					request.kind === "inspect" &&
					request.sessionId === "sid"
				) {
					signalInspect();
					await inspectGate;
				}
				return result(request);
			},
		});
		await bot.update(42, "/use sid");
		deferInspect = true;
		const upload = bot.updateDocument(42);
		await inspectStarted;
		await bot.update(42, "/use other");
		releaseInspect();
		await upload;
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(0);
		const inbox = (adapter as unknown as { inbox: { rootDirectory: string } })
			.inbox;
		await expect(
			readdir(path.join(inbox.rootDirectory, "sid")),
		).rejects.toThrow();
		await adapter.stop();
		if (previousSession) sessions.set("sid", previousSession);
	});

	it("removes a just-saved attachment if current selection changes during save", async () => {
		stubFileDownload();
		const previousSession = sessions.get("sid");
		if (!previousSession) throw new Error("missing session fixture");
		sessions.set("sid", { ...previousSession, cwd: await temp() });
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		const inbox = (
			adapter as unknown as {
				inbox: {
					rootDirectory: string;
					saveUnderLock: (
						id: SessionId,
						name: string,
						data: Buffer,
						removeExpired: boolean,
						workspacePath: string,
					) => Promise<{ path: string }>;
				};
			}
		).inbox;
		let savedDuringUpload = false;
		const save = inbox.saveUnderLock.bind(inbox);
		inbox.saveUnderLock = async (
			id,
			name,
			data,
			removeExpired,
			workspacePath,
		) => {
			const saved = await save(id, name, data, removeExpired, workspacePath);
			savedDuringUpload = true;
			await bot.update(42, "/use other");
			return saved;
		};
		await bot.updateDocument(42);
		expect(savedDuringUpload).toBe(true);
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(0);
		const files = await readdir(path.join(inbox.rootDirectory, "sid")).catch(
			(error: unknown) => {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return [];
				throw error;
			},
		);
		expect(files).toEqual([]);
		await adapter.stop();
		sessions.set("sid", previousSession);
	});

	it("revalidates a confirmed-current media route after its download", async () => {
		let finishDownload!: (response: Response) => void;
		const fetchGate = new Promise<Response>(
			(resolve) => (finishDownload = resolve),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => fetchGate),
		);
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.updateDocument(42, {
			replyToMessageId: 777,
			replyToMessageText: "unknown user-authored message",
		});
		const notice = bot.sent.at(-1);
		const currentChoice = callbackData(
			bot.sendOptions.at(-1),
			"reply:",
		).replace(/:[sx]$/, ":c");
		const choice = bot.callback(42, currentChoice, notice?.message_id);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
		await bot.update(42, "/use other");
		finishDownload(new Response(Buffer.from("media")));
		await choice;
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(0);
		expect(
			bot.sent.some(({ text }) =>
				text.includes(
					"Выбранная сессия изменилась во время получения вложения",
				),
			),
		).toBe(true);
		await adapter.stop();
	});

	it("keeps a reliable media reply on its source session after selection changes", async () => {
		let finishDownload!: (response: Response) => void;
		const fetchGate = new Promise<Response>(
			(resolve) => (finishDownload = resolve),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => fetchGate),
		);
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "create reply route");
		await vi.waitFor(() =>
			expect(bot.sent.some(({ text }) => text.includes("Pi activity"))).toBe(
				true,
			),
		);
		const source = bot.sent.find(({ text }) => text.includes("Pi activity"));
		await bot.update(42, "/use other");
		const upload = bot.updateDocument(42, {
			replyToMessageId: source?.message_id,
			replyToMessageText: source?.text,
		});
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
		finishDownload(new Response(Buffer.from("media")));
		await upload;
		expect(requests.findLast(({ kind }) => kind === "submit")).toMatchObject({
			sessionId: "sid",
		});
		await adapter.stop();
	});

	it("rechecks a disabled event channel at text dispatch after waiting for the inbox lock", async () => {
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "status", "initialize queue"));
		await vi.waitFor(() =>
			expect(
				(adapter as unknown as { queues: Map<number, unknown> }).queues.has(42),
			).toBe(true),
		);
		const inbox = (
			adapter as unknown as {
				inbox: {
					withSessionLock: (
						id: SessionId,
						fn: () => Promise<void>,
					) => Promise<void>;
				};
			}
		).inbox;
		const withSessionLock = inbox.withSessionLock.bind(inbox);
		let release!: () => void;
		let announce!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const started = new Promise<void>((resolve) => (announce = resolve));
		const lock = withSessionLock("sid" as SessionId, async () => {
			announce();
			await gate;
		});
		await started;
		let queued!: () => void;
		const queuedWait = new Promise<void>((resolve) => (queued = resolve));
		inbox.withSessionLock = (id, operation) => {
			const result = withSessionLock(id, operation);
			if (id === "sid") queued();
			return result;
		};
		const message = bot.update(42, "wait behind lock");
		await queuedWait;
		const queues = (
			adapter as unknown as { queues: Map<number, { failed: boolean }> }
		).queues;
		const queue = queues.get(42);
		if (!queue) throw new Error("missing chat event queue");
		queue.failed = true;
		await bot.update(42, "/menu");
		const reset = callbackData(bot.sendOptions.at(-1), "events:enable");
		await bot.callback(42, reset, bot.lastMessageId);
		release();
		await Promise.all([lock, message]);
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(1);
		await adapter.stop();
	});

	it("blocks text dispatch when the event channel stays disabled through the lock boundary", async () => {
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "status", "initialize queue"));
		await vi.waitFor(() =>
			expect(
				(adapter as unknown as { queues: Map<number, unknown> }).queues.has(42),
			).toBe(true),
		);
		const inbox = (
			adapter as unknown as {
				inbox: {
					withSessionLock: (
						id: SessionId,
						fn: () => Promise<void>,
					) => Promise<void>;
				};
			}
		).inbox;
		const withSessionLock = inbox.withSessionLock.bind(inbox);
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const heldStarted = new Promise<void>((resolve) => (started = resolve));
		const held = withSessionLock("sid" as SessionId, async () => {
			started();
			await gate;
		});
		await heldStarted;
		let queued!: () => void;
		const queuedWait = new Promise<void>((resolve) => (queued = resolve));
		inbox.withSessionLock = (id, operation) => {
			const pending = withSessionLock(id, operation);
			if (id === "sid") queued();
			return pending;
		};
		const submission = bot.update(42, "blocked at final boundary");
		await queuedWait;
		const queues = (
			adapter as unknown as { queues: Map<number, { failed: boolean }> }
		).queues;
		const queue = queues.get(42);
		if (!queue) throw new Error("missing event queue");
		queue.failed = true;
		release();
		await Promise.all([held, submission]);
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(0);
		await adapter.stop();
	});

	it("blocks media dispatch when the channel is disabled during download", async () => {
		let finishDownload!: (response: Response) => void;
		const fetchGate = new Promise<Response>(
			(resolve) => (finishDownload = resolve),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => fetchGate),
		);
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "status", "initialize queue"));
		await vi.waitFor(() =>
			expect(
				(adapter as unknown as { queues: Map<number, unknown> }).queues.has(42),
			).toBe(true),
		);
		const upload = bot.updateDocument(42);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
		const queues = (
			adapter as unknown as { queues: Map<number, { failed: boolean }> }
		).queues;
		const queue = queues.get(42);
		if (!queue) throw new Error("missing chat event queue");
		queue.failed = true;
		finishDownload(new Response(Buffer.from("media")));
		await upload;
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(0);
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
		sessions.set("other", {
			...sessionWith("sid", { status: "stopped" }),
			id: "other" as SessionId,
		});
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
			"start",
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
			"reload",
			"model",
			"effort",
			"stop",
			"delete",
			"cancel",
		]);

		await bot.update(100, "/start");
		expect(bot.sent.at(-1)?.text).toContain("Добро пожаловать");
		expect(bot.sendOptions.at(-1)).toMatchObject({
			reply_markup: {
				inline_keyboard: expect.arrayContaining([
					expect.arrayContaining([
						expect.objectContaining({ text: "Открыть панель" }),
					]),
				]),
			},
		});
		await bot.update(100, "/help");
		expect(bot.sent.at(-1)?.text).toContain("Как начать:");
		expect(bot.sent.at(-1)?.text).toContain("/delete <sessionId> —");
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
		await bot.update(100, "/stop other");
		await bot.update(100, "/delete other");
		expect(requests.at(-1)).toMatchObject({
			kind: "delete",
			sessionId: "other",
		});
		expect(bot.sent.at(-1)?.text).toContain(
			"Запись остановленной сессии #other удалена из harnessd",
		);
		const submitsBeforeDeletedText = requests.filter(
			({ kind }) => kind === "submit",
		).length;
		await bot.update(100, "plain text after deletion");
		expect(requests.filter(({ kind }) => kind === "submit")).toHaveLength(
			submitsBeforeDeletedText,
		);
		await bot.update(100, "/delete");
		expect(bot.sent.at(-1)?.text).toBe("Использование: /delete <sessionId>");
		await adapter.stop();
	});

	for (const action of ["panel", "sessions", "new"] as const) {
		for (const hasExistingPanel of [false, true]) {
			it(`/start ${action} action is bound and preserves the stored panel (${hasExistingPanel ? "existing panel" : "no panel"})`, async () => {
				const bot = new MockBot();
				const stateDirectory = await temp();
				const { adapter } = await startAdapter(bot, stateDirectory);
				if (hasExistingPanel) await bot.update(42, "/menu");
				const store = await TelegramPanelStore.open(
					stateDirectory,
					"secret-token",
				);
				const initialPanelId = store.get(42);
				const initialPins = bot.pinned.length;
				await bot.update(42, "/start");
				const welcomeId = bot.lastMessageId;
				const markup = bot.sendOptions.at(-1) as {
					reply_markup: {
						inline_keyboard: readonly (readonly {
							text: string;
							callback_data: string;
						}[])[];
					};
				};
				expect(bot.sendOptions.at(-1)).toHaveProperty("reply_markup");
				const label =
					action === "panel"
						? "Открыть панель"
						: action === "sessions"
							? "Сессии"
							: "Новая сессия";
				const data = markup.reply_markup.inline_keyboard
					.flat()
					.find((button) => button.text === label)?.callback_data;
				if (!data) throw new Error(`Missing /start ${label} callback`);
				const sentBeforeStale = bot.sent.length;
				const editedBeforeStale = bot.edited.length;
				await bot.callback(42, data, (welcomeId ?? 0) + 1);
				await bot.callback(43, data, welcomeId);
				expect(bot.sent).toHaveLength(sentBeforeStale);
				expect(bot.edited).toHaveLength(editedBeforeStale);
				await bot.callback(42, data, welcomeId);
				const panelId = (
					await TelegramPanelStore.open(stateDirectory, "secret-token")
				).get(42);
				if (action === "new") {
					expect(bot.sent.at(-1)?.text).toContain("Новая сессия будет создана");
					expect(panelId).toBe(initialPanelId);
					expect(bot.pinned).toHaveLength(initialPins);
				} else {
					expect(panelId).toBeDefined();
					expect(panelId).not.toBe(welcomeId);
					expect(bot.pinned.at(-1)?.messageId).toBe(panelId);
					if (action === "sessions")
						expect(bot.edited.at(-1)?.text).toContain("Сессии ·");
				}
				const sentAfterAction = bot.sent.length;
				const editedAfterAction = bot.edited.length;
				const pinsAfterAction = bot.pinned.length;
				await bot.callback(42, data, welcomeId);
				expect(bot.sent).toHaveLength(sentAfterAction);
				expect(bot.edited).toHaveLength(editedAfterAction);
				expect(bot.pinned).toHaveLength(pinsAfterAction);
				await adapter.stop();
			});
		}
	}

	it("creates and selects a named session from the bound welcome New session action", async () => {
		const bot = new MockBot();
		const stateDirectory = await temp();
		const cwd = "/welcome workspace/project";
		const created: SessionSummary = {
			id: "welcome-created" as SessionId,
			harnessId: "pi-rpc" as never,
			cwd,
			name: "Welcome task",
			status: "stopped",
		};
		const { adapter, requests } = await startAdapter(bot, stateDirectory, {
			initialCwd: cwd,
			dispatch: async (request) =>
				request.kind === "create"
					? { requestId: request.requestId, ok: true, value: created }
					: result(request),
		});
		await bot.update(42, "/start");
		const welcomeId = bot.lastMessageId as number;
		const welcomeMarkup = bot.sendOptions.at(-1) as {
			reply_markup: {
				inline_keyboard: readonly (readonly {
					text: string;
					callback_data: string;
				}[])[];
			};
		};
		const action = welcomeMarkup.reply_markup.inline_keyboard
			.flat()
			.find(({ text }) => text === "Новая сессия")?.callback_data;
		if (!action) throw new Error("Missing welcome new-session callback");
		await bot.callback(42, action, welcomeId);
		const promptId = bot.lastForceReplyMessageId;
		const prompt = bot.sent.find(({ message_id }) => message_id === promptId);
		expect(prompt?.text).toContain("Назовите сессию (запрос имени harnessd):");
		expect(prompt?.text).toContain(`Новая сессия будет создана в ${cwd}`);
		if (!promptId) throw new Error("Missing welcome name prompt");
		await bot.update(42, "Welcome task", { replyToMessageId: promptId });
		expect(requests.at(-1)).toMatchObject({
			kind: "create",
			cwd,
			name: "Welcome task",
		});
		expect(bot.sent.at(-1)?.text).toContain(
			"Сессия Welcome task · #welcome-created создана и выбрана.",
		);
		const store = await TelegramPanelStore.open(stateDirectory, "secret-token");
		expect(store.getSelected(42)).toBe("welcome-created");
		expect(store.get(42)).toBeUndefined();
		expect(bot.pinned).toEqual([]);
		await bot.update(42, "continue in created session");
		expect(requests.at(-1)).toMatchObject({
			kind: "submit",
			sessionId: "welcome-created",
		});
		await adapter.stop();
	});

	it("selects a nonselected session from the welcome Sessions panel without adopting the welcome message", async () => {
		const bot = new MockBot();
		const stateDirectory = await temp();
		const { adapter, requests } = await startAdapter(bot, stateDirectory);
		await bot.update(42, "/use sid");
		const welcomePins = bot.pinned.length;
		await bot.update(42, "/start");
		const welcomeId = bot.lastMessageId as number;
		const welcomeMarkup = bot.sendOptions.at(-1) as {
			reply_markup: {
				inline_keyboard: readonly (readonly {
					text: string;
					callback_data: string;
				}[])[];
			};
		};
		const action = welcomeMarkup.reply_markup.inline_keyboard
			.flat()
			.find(({ text }) => text === "Сессии")?.callback_data;
		if (!action) throw new Error("Missing welcome sessions callback");
		await bot.callback(42, action, welcomeId);
		const store = await TelegramPanelStore.open(stateDirectory, "secret-token");
		const panelId = store.get(42);
		expect(panelId).toBeDefined();
		expect(panelId).not.toBe(welcomeId);
		expect(bot.pinned).toHaveLength(welcomePins + 1);
		expect(bot.pinned.at(-1)?.messageId).toBe(panelId);
		const selectOther = callbackData(
			bot.edited.at(-1)?.options,
			"session:select:other",
		);
		await bot.callback(42, selectOther, panelId as number);
		const selectedStore = await TelegramPanelStore.open(
			stateDirectory,
			"secret-token",
		);
		expect(selectedStore.getSelected(42)).toBe("other");
		expect(bot.sent.at(-1)?.text).toContain(
			"Выбрана #other. Обычные сообщения направляются в эту сессию.",
		);
		await bot.update(42, "route to newly selected session");
		expect(requests.at(-1)).toMatchObject({
			kind: "submit",
			sessionId: "other",
		});
		expect(store.get(42)).toBe(panelId);
		expect(bot.pinned.at(-1)?.messageId).toBe(panelId);
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
		expect(bot.sent.at(-2)?.text).toContain(
			"Selection is unchanged; messages still target #sid",
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
			"inspect",
			"model_list",
			"inspect",
			"model_set",
			"inspect",
			"effort_list",
			"inspect",
			"effort_set",
			"session_status",
			"submit",
		]);
		expect(requests[2]).toMatchObject({
			kind: "session_status",
			sessionId: "sid",
		});
		expect(requests[4]).toMatchObject({ kind: "model_list", sessionId: "sid" });
		expect(requests[6]).toMatchObject({
			kind: "model_set",
			sessionId: "other",
			provider: "openai",
			modelId: "gpt-next",
			effort: "high",
		});
		expect(requests[8]).toMatchObject({
			kind: "effort_list",
			sessionId: "sid",
		});
		expect(requests[10]).toMatchObject({
			kind: "effort_set",
			sessionId: "other",
			effort: "high",
		});
		expect(requests[12]).toMatchObject({ kind: "submit", sessionId: "other" });
		expect(
			bot.sent.some(
				({ chatId, text }) => chatId === 100 && text.includes("Токены: 1,234"),
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
					text.includes("Уровни effort (текущий: medium): low, medium, high"),
			),
		).toBe(true);
		expect(
			bot.sent.some(
				({ chatId, text }) =>
					chatId === 101 &&
					text.includes(
						"Выбрана модель openai/gpt-next; effort установлен: high.",
					),
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
				text.includes("Pi не подтвердил effort high"),
			),
		).toBe(true);
		expect(
			bot.sent.some(
				({ text }) =>
					text.includes("Рабочая папка: /work") &&
					text.includes("Статус: остановлена (stopped)") &&
					text.includes("Модель: недоступно") &&
					text.includes("Данные Pi в реальном времени недоступны"),
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
			"Возьмите весь путь в парные кавычки или уберите кавычки.",
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
		expect(firstListing).toContain(`Папка: ${initial}`);
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
			bot.sent.some(({ text }) => text === `Рабочая папка: ${outside}`),
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
		expect(bot.sent[0]?.text).toContain("текущая папка не изменена");
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
					text.includes("Pi мог принять ввод, но подтверждение не получено") &&
					text.includes(`InputId ${inputId}`) &&
					text.startsWith("<pre><code>"),
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
				"Pi мог принять ввод, но подтверждение не получено; автоматической повторной отправки не было";
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
				bot.edited.some(({ text }) => text.includes("отменён пользователем")),
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
		expect(recoveryMessages).toContain("Супервизор перезапускается.");
		expect(recoveryMessages).toContain("Супервизор восстановлен.");
		expect(recoveryMessages).toContain("Не удалось восстановить супервизор.");
		expect(
			recoveryMessages.indexOf("Супервизор перезапускается."),
		).toBeLessThan(recoveryMessages.indexOf("Супервизор восстановлен."));
		expect(recoveryMessages.indexOf("Супервизор восстановлен.")).toBeLessThan(
			recoveryMessages.indexOf("Не удалось восстановить супервизор."),
		);
		expect(recoveryMessages).toContain("Статус сессии изменился.");
		expect(
			sidMessages.some(({ text }) => text.includes("raw-secret-error")),
		).toBe(true);
		expect(
			sidMessages.some(({ text }) =>
				text.includes("input-uncertain: uncertain (повторно не отправлялся)"),
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
					"Pi мог принять ввод, но подтверждение не получено; автоматической повторной отправки не было",
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
		expect(bot.api.getFile).toHaveBeenCalledWith(
			"largest-photo-id",
			expect.any(AbortSignal),
		);
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

	it("reports an unavailable incoming-file session before downloading", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.updateDocument(42);
		expect(bot.sent.at(-1)?.text).toContain("Нет выбранной сессии");
		expect(bot.api.getFile).not.toHaveBeenCalled();
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(0);
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
		expect(
			[...bot.sent, ...bot.edited].some(({ text }) =>
				text.includes("Вложение сохранено и отправлено"),
			),
		).toBe(true);

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

	it("acknowledges a stalled attachment and times out without submitting it", async () => {
		vi.useFakeTimers();
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		bot.api.getFile = vi.fn(() => new Promise(() => {}));
		const update = bot.updateDocument(42);
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => text.includes("Получаю вложение")),
			).toBe(true),
		);
		await vi.advanceTimersByTimeAsync(60_000);
		await update;
		expect(requests.some((request) => request.kind === "submit")).toBe(false);
		expect(bot.sent.at(-1)?.text).toContain("превысила 60 секунд");
		expect(bot.sent.at(-1)?.text).toContain(
			"Автоматической повторной загрузки нет",
		);
		await adapter.stop();
		vi.useRealTimers();
	});

	it("does not save an incoming attachment when its selected session disappeared", async () => {
		stubFileDownload();
		const bot = new MockBot();
		const stateDirectory = await temp();
		const { adapter, requests } = await startAdapter(bot, stateDirectory);
		await bot.update(42, "/use sid");
		sessions.delete("sid");
		await bot.updateDocument(42);
		expect(bot.sent.at(-1)?.text).toContain(
			"Сессия недоступна; вложение не отправлено. Выберите другую сессию",
		);
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
		expect(bot.sent.at(-1)?.text).toContain("лимит загрузки Telegram 20 MB");

		bot.api.getFile = vi.fn(async () => {
			throw new Error("secret download failure");
		});
		await bot.updateDocument(42);
		expect(submissions()).toHaveLength(0);
		expect(bot.sent.at(-1)?.text).toContain(
			"Не удалось загрузить вложение из Telegram",
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
			"Не удалось загрузить вложение из Telegram",
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
			"Не удалось загрузить вложение из Telegram",
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

	it("reports incoming inbox quota without submitting or automatic retry", async () => {
		stubFileDownload();
		const bot = new MockBot();
		const stateDirectory = await temp();
		const workspace = await temp();
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: workspace,
		});
		const inboxDirectory = path.join(stateDirectory, "inbox", "sid");
		await mkdir(inboxDirectory, { recursive: true, mode: 0o700 });
		for (let index = 0; index < 10; index++) {
			await writeFile(
				path.join(
					inboxDirectory,
					`${Date.now() + index}-aaaaaaaaaaaaaaaa-file-${index}.txt`,
				),
				"retained",
				{ mode: 0o600 },
			);
		}
		const { adapter, requests } = await startAdapter(bot, stateDirectory);
		await bot.update(42, "/use sid");
		await bot.updateDocument(42);
		expect(bot.sent.at(-1)?.text).toContain("Достигнут лимит хранилища сессии");
		expect(bot.sent.at(-1)?.text).toContain(
			"очистка пропускает работающие сессии",
		);
		expect(bot.sent.at(-1)?.text).not.toContain("повтор");
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(0);
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
		expect(bot.sent.at(-1)?.text).toContain(
			"Папка вложений находится внутри рабочей папки сессии; вложение не сохранено.",
		);
		expect(bot.sent.at(-1)?.text).not.toContain("повтор");
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
			"Не удалось записать вложение в хранилище сессии; оно не отправлено.",
		);
		expect(bot.sent.at(-1)?.text).toContain(
			"Проверьте свободное место и доступ к хранилищу",
		);
		expect(bot.sent.at(-1)?.text).not.toContain("повтор");
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
		const insideAliasDirectory = await temp();
		let aliasAvailable = false;
		try {
			await symlink(file, path.join(insideAliasDirectory, "alias.txt"));
			aliasAvailable = true;
		} catch (error) {
			if (process.platform !== "win32") throw error;
		}
		if (aliasAvailable) {
			const aliasResult = await adapter.sendAgentFile({
				sessionId: "sid" as SessionId,
				path: path.join(insideAliasDirectory, "alias.txt"),
			});
			expect(aliasResult).toMatchObject({ delivered: 2, recipients: 2 });
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
		let escapeAvailable = false;
		try {
			await symlink(
				path.join(outside, "private.txt"),
				path.join(directory, "agent-escape.txt"),
			);
			escapeAvailable = true;
		} catch (error) {
			if (process.platform !== "win32") throw error;
		}
		if (escapeAvailable) {
			const escapeResult = await adapter.sendAgentFile({
				sessionId: "sid" as SessionId,
				path: "agent-escape.txt",
			});
			expect(escapeResult).toMatchObject({ delivered: 0, recipients: 2 });
			expect(bot.api.sendDocument).toHaveBeenCalledTimes(beforeOutside);
		}
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
		const aliasDirectory = await temp();
		let internalAliasAvailable = false;
		try {
			await symlink(file, path.join(aliasDirectory, "inside-alias.txt"));
			internalAliasAvailable = true;
		} catch (error) {
			if (process.platform !== "win32") throw error;
		}
		if (internalAliasAvailable)
			await bot.update(
				42,
				`/send ${path.join(aliasDirectory, "inside-alias.txt")}`,
			);
		await bot.update(42, "/send large.txt");
		await bot.update(42, "/send folder");
		expect(bot.api.sendDocument).toHaveBeenCalledTimes(
			internalAliasAvailable ? 2 : 1,
		);
		await adapter.stop();
	});

	it("reports distinct /send file failures without retrying", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const outside = await temp();
		const oversized = path.join(dir, "oversized.bin");
		await writeFile(oversized, "");
		await truncate(oversized, 20 * 1024 * 1024 + 1);
		await mkdir(path.join(dir, "folder"));
		await writeFile(path.join(outside, "outside.txt"), "outside");
		sessions.set("sid", {
			...(sessions.get("sid") as SessionSummary),
			cwd: dir,
		});
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		const deliver = bot.api.sendDocument;
		await bot.update(42, "/send missing.txt");
		expect(bot.sent.at(-1)?.text).toContain("Файл не найден");
		await bot.update(42, `/send ${path.join(outside, "outside.txt")}`);
		expect(bot.sent.at(-1)?.text).toContain(
			"должен находиться внутри рабочей папки",
		);
		await bot.update(42, "/send folder");
		expect(bot.sent.at(-1)?.text).toContain("только обычный файл");
		await bot.update(42, "/send oversized.bin");
		expect(bot.sent.at(-1)?.text).toContain("превышает лимит Telegram 20 MiB");
		expect(deliver).not.toHaveBeenCalled();
		await adapter.stop();
	});

	it.skipIf(process.getuid?.() === 0)(
		"reports an inaccessible /send file without retrying",
		async () => {
			const bot = new MockBot();
			const dir = await temp();
			const file = path.join(dir, "private.txt");
			await writeFile(file, "private", { mode: 0o000 });
			sessions.set("sid", {
				...(sessions.get("sid") as SessionSummary),
				cwd: dir,
			});
			const { adapter } = await startAdapter(bot, await temp());
			await bot.update(42, "/use sid");
			await bot.update(42, "/send private.txt");
			expect(bot.sent.at(-1)?.text).toContain(
				"Файл недоступен для чтения. Проверьте права доступа к файлу в рабочей папке.",
			);
			expect(bot.sent.at(-1)?.text).not.toContain("повтор");
			expect(bot.api.sendDocument).not.toHaveBeenCalled();
			await chmod(file, 0o600);
			await adapter.stop();
		},
	);

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
			"Сессия не выбрана. Найдите её через /sessions и выберите командой /use <sessionId> или откройте /menu.",
		);

		await bot.update(100, "/use sid");
		await bot.update(100, '/send "report file.txt"');
		expect(bot.api.sendDocument).toHaveBeenCalledOnce();
		expect(bot.sent.at(-1)?.text).toBe("Файл отправлен.");

		bot.api.sendDocument = vi.fn(async () => {
			throw new Error("telegram unavailable");
		});
		await bot.update(100, '/send "report file.txt"');
		expect(bot.sent.at(-1)?.text).toContain("Telegram не доставил файл");
		expect(bot.sent.at(-1)?.text).toContain(
			"Автоматической повторной отправки не будет",
		);

		await bot.update(100, "/send ../outside.txt");
		expect(bot.api.sendDocument).toHaveBeenCalledOnce();
		expect(bot.sent.at(-1)?.text).toContain("Файл не найден");
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
		await bot.update(43, "/stop sid");
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

	it("redacts streamed subagent envelopes and coalesces identical activity status", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "run subagent work");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		const bubbleId = bot.lastMessageId;
		emit(harnessEvent("sid", "status", "agent_start"));
		const widget = `Pi: PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
			kind: "pi-subagents.async-status-snapshot",
			runs: [
				{
					kind: "subagent",
					label: "scout",
					state: "running",
					id: "SENTINEL_PAYLOAD_ID",
				},
			],
			generatedAt: "SENTINEL_TIMESTAMP",
		})}`;
		const fencedWidget =
			'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[],"id":"fenced-example"}';
		emit(harnessEvent("sid", "output", "```json"));
		emit(harnessEvent("sid", "output", "\n"));
		emit(harnessEvent("sid", "output", fencedWidget));
		emit(harnessEvent("sid", "output", "\n```"));
		emit(harnessEvent("sid", "output", "\n"));
		emit(harnessEvent("sid", "output", widget.slice(0, 24)));
		emit(harnessEvent("sid", "output", widget.slice(24)));
		await vi.waitFor(() =>
			expect(
				bot.edited.some(({ text }) =>
					text.includes("Задача Scout: выполняется"),
				),
			).toBe(true),
		);
		emit(
			harnessEvent("sid", "output", "\nVisible answer.\n\nNext paragraph.\n"),
		);
		for (let index = 0; index < 100; index++)
			emit(harnessEvent("sid", "output", `${widget}\n`));
		const paddedEnvelope = `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
			kind: "pi-subagents.async-status-snapshot",
			runs: [{ kind: "subagent", label: "scout", state: "running" }],
			ignored: "x".repeat(33_000),
			id: "WHITESPACE_SENTINEL",
		})}`;
		emit(
			harnessEvent(
				"sid",
				"output",
				`${" ".repeat(129)}Pi: ${paddedEnvelope}\\n`,
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
				bot.sent.some(({ text }) => text.includes("Visible answer.")),
			).toBe(true),
		);
		const payloads = [
			...bot.api.sendMessage.mock.calls.map(([, text]) => String(text)),
			...bot.api.editMessageText.mock.calls.map(([, , text]) => String(text)),
		];
		expect(payloads.join("\n")).not.toContain("SENTINEL_PAYLOAD_ID");
		expect(payloads.join("\n")).not.toContain("SENTINEL_TIMESTAMP");
		expect(payloads.join("\n")).not.toContain("WHITESPACE_SENTINEL");
		expect(payloads.join("\n")).not.toContain("Additional output omitted");
		expect(bot.sent.some(({ text }) => text.includes("fenced-example"))).toBe(
			true,
		);
		expect(
			bot.api.editMessageText.mock.calls.filter(
				([, messageId]) => messageId === bubbleId,
			).length,
		).toBeLessThan(10);
		expect(
			bot.sent.some(({ text }) =>
				text.includes("Visible answer.\n\nNext paragraph."),
			),
		).toBe(true);
		await adapter.stop();
	});

	it("keeps the transport operation projection to six rows", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "track bounded tools");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		for (let index = 0; index < 8; index++) {
			emit({
				sessionId: "sid" as SessionId,
				kind: "activity",
				activityEvent: {
					type: "tool_start",
					toolCallId: `bounded-${index}`,
					summary: `read: ${index}`,
				},
			});
		}
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Ещё выполняется: 2"),
		);
		const text = bot.edited.at(-1)?.text ?? "";
		expect(text.match(/^• read:/gm) ?? []).toHaveLength(6);
		expect(text).toContain("Ещё выполняется: 2");
		await adapter.stop();
	});

	it("keeps coalesced Worker tool events out of visible status and update time", async () => {
		const bot = new MockBot();
		let ticks = 0;
		const { adapter, emit } = await startAdapter(bot, await temp(), {
			activityClock: () => new Date(ticks++ * 1000),
			activityTimeFormatter: (date) => `12:00:0${date.getSeconds()}`,
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "track coalesced worker");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(
			harnessEvent(
				"sid",
				"output",
				'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[{"kind":"subagent","label":"worker","state":"running"}]}',
			),
		);
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Задача Worker: выполняется"),
		);
		const before = bot.edited.at(-1)?.text;
		for (const event of [
			{
				type: "tool_start" as const,
				toolCallId: "worker-tool",
				summary: "subagent · worker · task",
			},
			{ type: "tool_end" as const, toolCallId: "worker-tool", failed: false },
		]) {
			emit({
				sessionId: "sid" as SessionId,
				kind: "activity",
				activityEvent: event,
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(bot.edited.at(-1)?.text).toBe(before);
		await adapter.stop();
	});

	it("renders child-role overflow immediately without changing activity status or time", async () => {
		const bot = new MockBot();
		let ticks = 0;
		const { adapter, emit } = await startAdapter(bot, await temp(), {
			activityClock: () => new Date(ticks++ * 1000),
			activityTimeFormatter: (date) => `12:00:0${date.getSeconds()}`,
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "track child overflow");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(
			harnessEvent(
				"sid",
				"output",
				'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[{"kind":"subagent","label":"worker","state":"running"}]}',
			),
		);
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Задача Worker: выполняется"),
		);
		for (let index = 0; index < 256; index++)
			emit({
				sessionId: "sid" as SessionId,
				kind: "activity",
				activityEvent: {
					type: "tool_start",
					toolCallId: `child-cap-${index}`,
					summary: `read: ${index}`,
				},
			});
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Ещё выполняется: 251"),
		);
		const before = bot.edited.at(-1)?.text ?? "";
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "tool_start",
				toolCallId: "worker-over-cap",
				summary: "subagent · worker · task",
			},
		});
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain(
				"Дополнительные операции не отслеживаются",
			),
		);
		const after = bot.edited.at(-1)?.text ?? "";
		expect(after.split("\n")[0]).toBe(before.split("\n")[0]);
		expect(after.match(/^⏳ .*$/m)?.[0]).toBe(before.match(/^⏳ .*$/m)?.[0]);
		expect(after.match(/^Обновлено: .*$/m)?.[0]).toBe(
			before.match(/^Обновлено: .*$/m)?.[0],
		);
		const edits = bot.edited.length;
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "tool_start",
				toolCallId: "worker-over-cap-duplicate",
				summary: "subagent · worker · task",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(bot.edited).toHaveLength(edits);
		await adapter.stop();
	});

	it("advances activity time when thinking joins a queued child overflow warning", async () => {
		const bot = new MockBot();
		let ticks = 0;
		const { adapter, emit } = await startAdapter(bot, await temp(), {
			activityClock: () => new Date(ticks++ * 1000),
			activityTimeFormatter: (date) => `t${date.getTime()}`,
		});
		await bot.update(42, "/use sid");
		await bot.update(42, "track coalesced worker thinking");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(
			harnessEvent(
				"sid",
				"output",
				'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[{"kind":"subagent","label":"worker","state":"running"}]}',
			),
		);
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Задача Worker: выполняется"),
		);
		for (let index = 0; index < 256; index++)
			emit({
				sessionId: "sid" as SessionId,
				kind: "activity",
				activityEvent: {
					type: "tool_start",
					toolCallId: `thinking-cap-${index}`,
					summary: `read: ${index}`,
				},
			});
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Ещё выполняется: 251"),
		);
		const beforeTime = bot.edited.at(-1)?.text?.match(/^Обновлено: .*$/m)?.[0];
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "tool_start",
				toolCallId: "thinking-over-cap",
				summary: "subagent · worker · task",
			},
		});
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: { type: "thinking", active: true },
		});
		await vi.waitFor(() => {
			const text = bot.edited.at(-1)?.text ?? "";
			expect(text).toContain("Дополнительные операции не отслеживаются");
			expect(text).toContain("• Думаю…");
		});
		const afterTime = bot.edited.at(-1)?.text?.match(/^Обновлено: .*$/m)?.[0];
		expect(afterTime).not.toBe(beforeTime);
		await adapter.stop();
	});

	it("publishes the activity overflow warning on its first over-cap tool", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "track activity overflow");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		for (let index = 0; index < 256; index++)
			emit({
				sessionId: "sid" as SessionId,
				kind: "activity",
				activityEvent: {
					type: "tool_start",
					toolCallId: `cap-${index}`,
					summary: `read: ${index}`,
				},
			});
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Ещё выполняется: 250"),
		);
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "tool_start",
				toolCallId: "cap-over",
				summary: "read: overflow",
			},
		});
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain(
				"Дополнительные операции не отслеживаются",
			),
		);
		const edits = bot.edited.length;
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "tool_start",
				toolCallId: "cap-over-2",
				summary: "read: overflow again",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(bot.edited).toHaveLength(edits);
		await adapter.stop();
	});

	it("coalesces sequential Worker and Reviewer status without workflow spam", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "track status");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(
			harnessEvent(
				"sid",
				"output",
				'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[{"kind":"subagent","label":"worker","state":"running"}]}',
			),
		);
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Задача Worker: выполняется"),
		);
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "notification",
				text: 'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[{"kind":"subagent","label":"worker","state":"completed"},{"kind":"subagent","label":"reviewer","state":"running","id":"PRIVATE_REVIEW_ID"}]}',
			},
		});
		await vi.waitFor(() =>
			expect(bot.edited.at(-1)?.text).toContain("Задача Reviewer: выполняется"),
		);
		const visible = bot.edited.at(-1)?.text ?? "";
		expect(visible).toContain("Задача Worker: завершён ✓");
		expect(visible).toContain("Задача Reviewer: выполняется …");
		expect(visible.match(/Задача Worker: завершён/g)).toHaveLength(1);
		expect(visible.match(/Задача Reviewer: выполняется/g)).toHaveLength(1);
		expect(
			visible.match(
				/^• (?!Задача Worker|Задача Reviewer|Input|Ещё|Pi activity|⏳)/gm,
			) ?? [],
		).toEqual([]);
		expect(visible).not.toContain("workflow");
		expect(visible).not.toContain("PRIVATE_REVIEW_ID");
		expect(visible).not.toContain("subagent ·");
		await adapter.stop();
	});

	it("redacts subagent status notifications into the attributed bubble only", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "attribute notification");
		await vi.waitFor(() =>
			expect(bot.sent.at(-1)?.text).toContain("Pi activity"),
		);
		const bubbleId = bot.lastMessageId;
		emit(harnessEvent("sid", "status", "agent_start"));
		const secret = "NOTIFICATION_SENTINEL_9274";
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "notification",
				text: `Pi: PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
					kind: "pi-subagents.async-status-snapshot",
					runs: [
						{ kind: "subagent", label: "worker", state: "queued", id: secret },
					],
				})}`,
			},
		});
		await vi.waitFor(() =>
			expect(
				bot.edited.some(({ text }) => text.includes("Задача Worker: ожидает")),
			).toBe(true),
		);
		const payloads = [
			...bot.api.sendMessage.mock.calls.map(([, text]) => String(text)),
			...bot.api.editMessageText.mock.calls.map(([, , text]) => String(text)),
		];
		expect(payloads.join("\n")).not.toContain(secret);
		expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
		expect(
			bot.api.sendMessage.mock.calls.some(([, text]) =>
				String(text).startsWith("Pi: "),
			),
		).toBe(false);
		expect(
			bot.api.editMessageText.mock.calls.some(([, id]) => id !== bubbleId),
		).toBe(false);
		await adapter.stop();
		log.mockRestore();
	});

	it("hides an un-attributed status notification without creating a message or bubble", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		const sends = bot.api.sendMessage.mock.calls.length;
		emit(harnessEvent("sid", "status", "agent_start"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "activity",
			activityEvent: {
				type: "notification",
				text: 'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[{"kind":"subagent","label":"scout","state":"running","id":"BACKGROUND_SENTINEL"}]}',
			},
		});
		expect(bot.api.sendMessage.mock.calls).toHaveLength(sends);
		expect(bot.api.editMessageText).not.toHaveBeenCalled();
		expect(
			bot.sent.some(({ text }) => text.includes("BACKGROUND_SENTINEL")),
		).toBe(false);
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
		emit(harnessEvent("sid", "output", "   \n"));
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

	it("reports overflow when padded prose diverges from a streamed widget prefix", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "output", " ".repeat(33_000)));
		emit(harnessEvent("sid", "output", "P"));
		emit(harnessEvent("sid", "output", "rose\nVisible\n"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.sent.filter(({ text }) =>
					text.includes(
						"Additional output omitted because the response reached the queue limit",
					),
				),
			).toHaveLength(1),
		);
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
			text.startsWith("Выбрана"),
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
		expect(eventMessages()).toEqual(["answer", "Ввод input-X: completed"]);
		expect(eventMessages()).not.toContain("Ввод input-X: accepted");
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
						chatId === 43 && telegramBody(text) === "Статус сессии изменился.",
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

	it("delivers an overflow notice to a switched background recipient", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(42, "run that will overflow");
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "pending" },
		});
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "accepted" },
		});
		emit(harnessEvent("sid", "status", "agent_start"));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		bot.api.sendMessage.mockImplementation(async (chatId, text, options) => {
			if (chatId === 42 && telegramBody(text) === "Session status changed.")
				await gate;
			bot.sent.push({ chatId, text });
			bot.sendOptions.push(options);
		});
		emit(harnessEvent("sid", "status", "unknown"));
		await vi.waitFor(() =>
			expect(
				bot.api.sendMessage.mock.calls.some(
					([chatId, text]) =>
						chatId === 42 && telegramBody(text) === "Статус сессии изменился.",
				),
			).toBe(true),
		);
		for (let index = 0; index < 45; index++)
			emit(harnessEvent("sid", "status", "unknown"));
		const queues = (
			adapter as unknown as {
				queues: Map<number, { overflowNotices: Set<string> }>;
			}
		).queues;
		await vi.waitFor(() =>
			expect(queues.get(42)?.overflowNotices.size).toBe(1),
		);
		await bot.update(42, "/use other");
		emit(harnessEvent("sid", "output", "x".repeat(33_000)));
		emit(harnessEvent("sid", "status", "agent_settled"));
		emit({
			sessionId: "sid" as SessionId,
			kind: "input",
			inputEvent: { inputId: "input-1" as never, state: "completed" },
		});
		release();
		const waitForEventQueue = (
			adapter as unknown as {
				waitForEventQueue: (chatId: number) => Promise<boolean>;
			}
		).waitForEventQueue.bind(adapter);
		await waitForEventQueue(42);
		const noticeIndex = bot.sent.findIndex(({ text }) =>
			text.includes("Additional notifications were omitted"),
		);
		expect(noticeIndex).toBeGreaterThanOrEqual(0);
		expect(bot.sendOptions[noticeIndex]).toMatchObject({
			reply_markup: {
				inline_keyboard: [[{ text: "Переключиться на эту сессию" }]],
			},
		});
		await adapter.stop();
	});

	it("keeps congestion notices scoped to each omitted session and delivery context", async () => {
		const bot = new MockBot();
		const { adapter } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		const enqueue = (
			adapter as unknown as {
				enqueue: (
					chatId: number,
					sessionId: SessionId,
					text: string,
					input:
						| { readonly inputId: string; readonly state: string }
						| undefined,
					output: boolean,
					background: boolean,
				) => void;
			}
		).enqueue.bind(adapter);
		for (let index = 0; index < 25; index++)
			enqueue(
				42,
				"sid" as SessionId,
				`A output ${index}`,
				undefined,
				true,
				false,
			);
		for (let index = 0; index < 8; index++)
			enqueue(
				42,
				"sid" as SessionId,
				`A input ${index}`,
				{ inputId: `A-${index}`, state: "accepted" },
				false,
				false,
			);
		enqueue(
			42,
			"other" as SessionId,
			"B input",
			{ inputId: "B-0", state: "accepted" },
			false,
			false,
		);
		for (let index = 0; index < 23; index++)
			enqueue(
				42,
				"sid" as SessionId,
				`A refill ${index}`,
				undefined,
				true,
				false,
			);
		enqueue(
			42,
			"other" as SessionId,
			"B background output",
			undefined,
			true,
			true,
		);
		const waitForEventQueue = (
			adapter as unknown as {
				waitForEventQueue: (chatId: number) => Promise<boolean>;
			}
		).waitForEventQueue.bind(adapter);
		await waitForEventQueue(42);
		const notices = bot.sent
			.map((message, index) => ({ message, options: bot.sendOptions[index] }))
			.filter(({ message }) =>
				message.text.includes("Additional notifications were omitted"),
			);
		expect(notices).toHaveLength(2);
		const noticeA = notices.find(({ message }) => message.text.includes("sid"));
		const noticeB = notices.find(({ message }) =>
			message.text.includes("other"),
		);
		expect(noticeA?.message.text).toContain("sid");
		expect(noticeB?.message.text).toContain("other");
		expect(noticeA?.options).not.toHaveProperty("reply_markup");
		expect(noticeB?.options).toMatchObject({
			reply_markup: {
				inline_keyboard: [[{ text: "Переключиться на эту сессию" }]],
			},
		});
		const selectIntents = (
			adapter as unknown as {
				selectIntents: Map<string, { sessionId: SessionId }>;
			}
		).selectIntents;
		expect(
			[...selectIntents.values()].map(({ sessionId }) => sessionId),
		).toContain("other");
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
					text.includes(
						"uncertain-original-id: uncertain (повторно не отправлялся)",
					),
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

	it("blocks new submissions after event-channel failure and resets only future events", async () => {
		const bot = new MockBot();
		const { adapter, requests, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		bot.api.sendMessage.mockRejectedValueOnce(new Error("network unavailable"));
		emit(harnessEvent("sid", "status", "custom event"));
		await vi.waitFor(() =>
			expect(
				(
					adapter as unknown as { queues: Map<number, { failed: boolean }> }
				).queues.get(42)?.failed,
			).toBe(true),
		);
		const submissionsBefore = requests.filter(
			(request) => request.kind === "submit",
		).length;
		await bot.update(42, "must not submit");
		expect(
			requests.filter((request) => request.kind === "submit"),
		).toHaveLength(submissionsBefore);
		await bot.update(42, "/menu");
		const reset = callbackData(bot.sendOptions.at(-1), "events:enable");
		expect(reset).toBe("events:enable");
		await bot.callback(42, reset);
		expect(
			(
				adapter as unknown as { queues: Map<number, { failed: boolean }> }
			).queues.get(42)?.failed,
		).toBe(false);
		bot.api.sendMessage.mockClear();
		emit(harnessEvent("sid", "status", "future event"));
		await vi.waitFor(() => expect(bot.api.sendMessage).toHaveBeenCalled());
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
