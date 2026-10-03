import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportEvent, TransportResult } from "../src/core/ports.js";
import type {
	HarnessEvent,
	SessionId,
	SessionSummary,
} from "../src/core/types.js";
import {
	acquireTelegramPollingLock,
	TelegramTransportAdapter,
	telegramLockPath,
} from "../src/telegram-transport.js";

const roots: string[] = [];
function telegramBody(text: string): string {
	const footerStart = text.lastIndexOf("\n\n");
	return footerStart < 0 ? text : text.slice(0, footerStart);
}
function hasSessionFooter(text: string, sessionId: string): boolean {
	const footerStart = text.lastIndexOf("\n\n");
	if (footerStart < 0) return false;
	const footer = text.slice(footerStart + 2).replace(/ · \d+\/\d+$/, "");
	return footer === sessionId || footer.endsWith(` · ${sessionId}`);
}
async function temp() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "telegram-adapter-"));
	roots.push(dir);
	return dir;
}
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

type Context = {
	from?: { id: number };
	chat?: { id: number; type: string };
	message?: {
		text?: string;
		message_id?: number;
		reply_to_message?: { message_id: number };
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
	callbackHandler?: (ctx: Context) => Promise<void>;
	sent: { chatId: number; text: string }[] = [];
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
				this.sent.push({ chatId, text });
				this.sendOptions.push(_other);
				const message_id = this.nextMessageId++;
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
				this.edited.push({ chatId, messageId, text, options });
				return { message_id: messageId };
			},
		),
		pinChatMessage: vi.fn(async (chatId: number, messageId: number) => {
			this.pinned.push({ chatId, messageId });
			return true;
		}),
		answerCallbackQuery: vi.fn(async () => true),
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
					: { reply_to_message: { message_id: options.replyToMessageId } }),
			},
		};
		await this.middleware?.(ctx, async () => this.handler?.(ctx));
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
					usage: { totalTokens: 1234, costUsd: 0.125 },
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

describe("Telegram transport", () => {
	it("creates one pinned panel, browses sessions, selects explicitly, and guards callbacks", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/menu");
		const panelMessageId = bot.lastMessageId;
		expect(panelMessageId).toBeDefined();
		expect(bot.pinned).toEqual([{ chatId: 42, messageId: panelMessageId }]);
		expect(bot.sent.at(-1)?.text).toContain("Выбрана: не выбрана");
		await bot.update(42, "/menu");
		expect(bot.api.editMessageText).toHaveBeenCalledOnce();
		expect(bot.api.pinChatMessage).toHaveBeenCalledOnce();

		await bot.callback(42, "session:next", panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain("Просмотр: #other");
		await bot.callback(42, "session:choose", panelMessageId);
		await bot.update(42, "/model");
		expect(requests.at(-1)).toMatchObject({
			kind: "model_list",
			sessionId: "other",
		});
		await bot.callback(42, "menu:models", panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain("Модель · #other");
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
		await bot.callback(42, "folder:open:0", panelMessageId);
		expect(bot.edited.at(-1)?.text).toContain(childDirectory);
		await bot.update(42, "/inspect");
		expect(requests.at(-1)).toMatchObject({
			kind: "inspect",
			sessionId: "sid",
		});
		expect(bot.sent.at(-1)?.text).toContain("/work");
		await bot.callback(42, "folder:new", panelMessageId);
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

	it("requires confirmation before callback stop and delete operations", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
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
		expect(requests.some((request) => request.kind === "delete")).toBe(false);
		await bot.callback(42, "action:confirm-delete:sid", panelMessageId);
		expect(requests.some((request) => request.kind === "delete")).toBe(true);
		const requestsAfterDelete = requests.length;
		await bot.callback(42, "action:confirm-delete:sid", panelMessageId);
		await bot.callback(42, "session:details:sid", panelMessageId);
		expect(requests).toHaveLength(requestsAfterDelete);
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
		expect(bot.sent.at(-1)?.text).toBe("Usage: /delete <sessionId>");
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
		expect(bot.sent.at(-2)?.text).toBe("Session cannot be resumed safely.");
		await adapter.stop();
	});

	it("keeps polling if Telegram command registration fails without logging raw errors", async () => {
		const bot = new MockBot();
		bot.setMyCommandsBehavior = async () => {
			throw new Error("PRIVATE Telegram API failure");
		};
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const { adapter } = await startAdapter(bot, await temp());
		expect(bot.api.setMyCommands).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(
			"harnessd: Telegram command menu registration failed",
		);
		expect(log.mock.calls.flat().join(" ")).not.toContain("PRIVATE");
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
					text.includes("Session: stopped") &&
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
		expect(bot.sent.some(({ text }) => text === "Session was not found")).toBe(
			true,
		);
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
		expect(requests.filter(({ kind }) => kind !== "create")).toEqual([]);
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

	it("contains dispatch rejections with a safe message and no prompt echo", async () => {
		const bot = new MockBot();
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
			bot.sent.some(
				({ text }) =>
					text ===
					"Request failed unexpectedly. Check the harnessd service journal.",
			),
		).toBe(true);
		expect(
			bot.sent.some(({ text }) => text.includes("private dispatch detail")),
		).toBe(false);
		expect(
			bot.sent.some(({ text }) => text.includes("private prompt text")),
		).toBe(false);
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
					text ===
					`Input delivery is uncertain (InputId ${inputId}; not resent)`,
			),
		).toBe(true);
		expect(bot.sent.some(({ text }) => text.includes("private prompt"))).toBe(
			false,
		);
		await adapter.stop();
	});

	it("routes to each selected chat and presents only safe, session-labelled statuses/errors", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		await bot.update(43, "/use other");
		emit(harnessEvent("sid", "status", "agent_start"));
		emit(harnessEvent("sid", "status", "harness_restarting"));
		emit(harnessEvent("sid", "status", "harness_recovered"));
		emit(harnessEvent("sid", "status", "harness_recovery_failed"));
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
		).toBe(false);
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

	it("sends one accepted-input confirmation and marks only the footer ID monospace", async () => {
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
		emit(harnessEvent("sid", "output", "literal <b>markup</b> & text"));
		emit(harnessEvent("sid", "status", "agent_settled"));
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => text.includes("literal <b>markup</b>")),
			).toBe(true),
		);
		const acceptanceMessages = bot.sent.filter(({ text }) =>
			text.includes("input-1"),
		);
		expect(acceptanceMessages.map(({ text }) => text)).toEqual([
			"Input accepted: input-1",
		]);
		const outputIndex = bot.sent.findIndex(({ text }) =>
			text.includes("literal <b>markup</b>"),
		);
		const output = bot.sent[outputIndex];
		const options = bot.sendOptions[outputIndex] as {
			entities?: readonly { type: string; offset: number; length: number }[];
			parse_mode?: string;
		};
		expect(output?.text).toContain("literal <b>markup</b> & text");
		expect(options.parse_mode).toBeUndefined();
		expect(options.entities).toHaveLength(1);
		const entity = options.entities?.[0];
		expect(entity?.type).toBe("code");
		expect(
			output?.text.slice(
				entity?.offset,
				(entity?.offset ?? 0) + (entity?.length ?? 0),
			),
		).toBe("sid");
		expect(hasSessionFooter(output?.text ?? "", "sid")).toBe(true);
		await adapter.stop();
	});

	it("deduplicates identical session errors until successful recovery", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		for (let index = 0; index < 3; index++)
			emit(harnessEvent("sid", "error", `failure ${index}`));
		emit(harnessEvent("sid", "status", "harness_recovered"));
		for (let index = 0; index < 2; index++)
			emit(harnessEvent("sid", "error", `failure after recovery ${index}`));
		await vi.waitFor(() =>
			expect(
				bot.sent.filter(
					({ text }) => telegramBody(text) === "Session reported an error.",
				).length,
			).toBe(2),
		);
		expect(
			bot.sent.filter(
				({ text }) => telegramBody(text) === "Session reported an error.",
			),
		).toHaveLength(2);
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
				({ text }) => text.length <= 4096 && hasSessionFooter(text, "other"),
			),
		).toBe(true);
		for (const message of chunks) {
			const options = bot.sendOptions[bot.sent.indexOf(message)] as {
				entities?: readonly { type: string; offset: number; length: number }[];
			};
			const entity = options?.entities?.find(({ type }) => type === "code");
			expect(
				message.text.slice(
					entity?.offset,
					(entity?.offset ?? 0) + (entity?.length ?? 0),
				),
			).toBe("other");
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
			unicodeParts.map(({ text }) => text.match(/other · (\d+\/\d+)$/)?.[1]),
		).toEqual(["1/2", "2/2"]);
		expect(unicodeParts.map(({ text }) => telegramBody(text)).join("")).toBe(
			unicodeReply,
		);
		for (const { text } of unicodeParts) {
			const body = telegramBody(text);
			expect(text.length).toBeLessThanOrEqual(4096);
			for (let index = 0; index < body.length; index++) {
				const codePoint = body.charCodeAt(index);
				if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
					expect(body.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
					expect(body.charCodeAt(index + 1)).toBeLessThanOrEqual(0xdfff);
					index++;
				} else expect(codePoint < 0xdc00 || codePoint > 0xdfff).toBe(true);
			}
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
