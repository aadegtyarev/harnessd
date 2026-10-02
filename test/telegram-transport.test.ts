import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	message?: { text?: string };
};
class MockBot {
	middleware?: (ctx: Context, next: () => Promise<void>) => Promise<void>;
	handler?: (ctx: Context) => Promise<void>;
	sent: { chatId: number; text: string }[] = [];
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
			) => {
				this.sent.push({ chatId, text });
			},
		),
	};
	use(handler: (ctx: Context, next: () => Promise<void>) => Promise<void>) {
		this.middleware = handler;
	}
	on(_filter: string, handler: (ctx: Context) => Promise<void>) {
		this.handler = handler;
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
			message: { text },
		};
		await this.middleware?.(ctx, async () => this.handler?.(ctx));
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
		defaultCwd: "/work",
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
	it("rejects unauthorized, malformed sender, group, and channel updates before dispatch", async () => {
		const bot = new MockBot();
		const dir = await temp();
		const { adapter, requests } = await startAdapter(bot, dir);
		await bot.update(42, "/sessions", { userId: 7 });
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

	it("accepts unquoted and matching quoted cwd paths without shell parsing", async () => {
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

	it("uses the configured default cwd when /new has no explicit path", async () => {
		const bot = new MockBot();
		const { adapter, requests } = await startAdapter(bot, await temp());
		await bot.update(42, "/new");
		expect(requests[0]).toMatchObject({ kind: "create", cwd: "/work" });
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
			({ chatId, text }) => chatId === 42 && text.startsWith("[sid]"),
		);
		const otherMessages = bot.sent.filter(
			({ chatId, text }) => chatId === 43 && text.startsWith("[other]"),
		);
		expect(sidMessages.map(({ text }) => text)).toContain(
			"[sid] Agent started.",
		);
		expect(sidMessages.map(({ text }) => text)).toContain(
			"[sid] Harness is restarting.",
		);
		expect(sidMessages.map(({ text }) => text)).toContain(
			"[sid] Harness recovered.",
		);
		expect(sidMessages.map(({ text }) => text)).toContain(
			"[sid] Harness recovery failed.",
		);
		const recoveryMessages = sidMessages.map(({ text }) => text);
		expect(
			recoveryMessages.indexOf("[sid] Harness is restarting."),
		).toBeLessThan(recoveryMessages.indexOf("[sid] Harness recovered."));
		expect(recoveryMessages.indexOf("[sid] Harness recovered.")).toBeLessThan(
			recoveryMessages.indexOf("[sid] Harness recovery failed."),
		);
		expect(sidMessages.map(({ text }) => text)).toContain(
			"[sid] Agent finished.",
		);
		expect(sidMessages.map(({ text }) => text)).toContain(
			"[sid] Session status changed.",
		);
		expect(
			sidMessages.some(({ text }) => text.includes("raw-secret-error")),
		).toBe(false);
		expect(
			sidMessages.some(({ text }) =>
				text.includes("input-uncertain: uncertain (not resent)"),
			),
		).toBe(true);
		expect(otherMessages).toHaveLength(1);
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
		const eventMessages = () =>
			bot.sent
				.filter(({ chatId, text }) => chatId === 42 && text.startsWith("[sid]"))
				.map(({ text }) => text);
		await vi.waitFor(() => expect(eventMessages()).toHaveLength(3));
		expect(eventMessages()).toEqual([
			"[sid] answer",
			"[sid] Agent is waiting for input.",
			"[sid] Input input-X: completed",
		]);
		expect(eventMessages()).not.toContain("[sid] Input input-X: accepted");
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
		bot.api.sendMessage.mockImplementation(async (chatId, text) => {
			if (text === "[sid] in-flight") await gate;
			bot.sent.push({ chatId, text });
		});
		emit(harnessEvent("sid", "output", "in-flight"));
		await vi.waitFor(() =>
			expect(
				bot.api.sendMessage.mock.calls.some(
					([chatId, text]) => chatId === 42 && text === "[sid] in-flight",
				),
			).toBe(true),
		);
		emit(harnessEvent("sid", "output", "stale queued"));
		await bot.update(42, "/use other");
		release();
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(bot.sent.some(({ text }) => text === "[sid] stale queued")).toBe(
			false,
		);
		emit(harnessEvent("other", "output", "delta-a"));
		emit(harnessEvent("other", "output", "delta-b"));
		await vi.waitFor(() =>
			expect(
				bot.sent.some(({ text }) => text === "[other] delta-adelta-b"),
			).toBe(true),
		);
		const longOutput = `${"y".repeat(4080)}\n${"y".repeat(4920)}`;
		emit(harnessEvent("other", "output", longOutput));
		await vi.waitFor(() =>
			expect(
				bot.sent.filter(
					({ chatId, text }) => chatId === 42 && text.includes("y"),
				),
			).toHaveLength(3),
		);
		const chunks = bot.sent.filter(
			({ chatId, text }) => chatId === 42 && text.includes("y"),
		);
		expect(
			chunks.every(
				({ text }) => text.length <= 4096 && text.startsWith("[other] "),
			),
		).toBe(true);
		expect(
			chunks.map(({ text }) => text.slice("[other] ".length)).join(""),
		).toBe(longOutput);
		await adapter.stop();
	});

	it("recovers the drain after it skips only events for the previously selected session", async () => {
		const bot = new MockBot();
		const { adapter, emit } = await startAdapter(bot, await temp());
		await bot.update(42, "/use sid");
		emit(harnessEvent("sid", "output", "stale A"));
		await bot.update(42, "/use other");
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(bot.sent.some(({ text }) => text === "[sid] stale A")).toBe(false);
		emit(harnessEvent("other", "output", "current B"));
		await vi.waitFor(() =>
			expect(bot.sent.some(({ text }) => text === "[other] current B")).toBe(
				true,
			),
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
			if (chatId === 42 && text.startsWith("[sid]")) await gate;
			bot.sent.push({ chatId, text });
		});
		for (let i = 0; i < 45; i++) emit(harnessEvent("sid", "status", "unknown"));
		await vi.waitFor(() =>
			expect(
				bot.api.sendMessage.mock.calls.some(
					([chatId, text]) =>
						chatId === 43 && text === "[sid] Session status changed.",
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
			if (text === "[sid] first output") await gate;
			bot.sent.push({ chatId, text });
		});
		emit(harnessEvent("sid", "output", "first output"));
		await vi.waitFor(() =>
			expect(
				bot.api.sendMessage.mock.calls.some(
					([, text]) => text === "[sid] first output",
				),
			).toBe(true),
		);
		await new Promise((resolve) => setTimeout(resolve, 60));
		for (let index = 0; index < 40; index++) {
			emit(harnessEvent("sid", "output", `output ${index}`));
			emit(harnessEvent("sid", "status", "unknown"));
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
		emit(harnessEvent("sid", "status", "agent_start"));
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
		emit(harnessEvent("sid", "status", "agent_start"));
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
			defaultCwd: "/work",
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
			defaultCwd: "/work",
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
