import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Capability } from "../src/core/errors.js";
import type { TransportEvent, TransportResult } from "../src/core/ports.js";
import type {
	HarnessEvent,
	SessionId,
	SessionSummary,
} from "../src/core/types.js";
import {
	TelegramTransportAdapter,
	telegramLockPath,
} from "../src/telegram-transport.js";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Uses real grammY start -> getUpdates -> handleUpdates -> handleUpdate, not handler invocation. */
async function fixture() {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "telegram-cancel-ingress-"),
	);
	const cwd = path.join(root, "workspace");
	await mkdir(cwd);
	await writeFile(path.join(cwd, "out.txt"), "outgoing file");
	const session: SessionSummary = {
		id: "session-1" as SessionId,
		harnessId: "pi-rpc" as never,
		cwd,
		status: "running",
	};
	const requests: TransportEvent[] = [];
	const calls: {
		method: string;
		payload: Record<string, unknown>;
		result?: Record<string, unknown>;
	}[] = [];
	const gates: ReturnType<typeof deferred<void>>[] = [];
	let block: (
		method: string,
		payload: Record<string, unknown>,
	) => Promise<void> = async () => {};
	let capabilities: () => Promise<readonly Capability[]> = async () => [
		"harness.cancel",
		"harness.reload",
	];
	let dispatch:
		| ((request: TransportEvent) => Promise<TransportResult> | undefined)
		| undefined;
	let listener: ((event: HarnessEvent) => unknown) | undefined;
	let pendingPoll: ((updates: Update[]) => void) | undefined;
	let polls = 0;
	let messageId = 1000;
	let updateId = 0;
	const bot = new Bot("123456:TEST_ONLY", {
		botInfo: {
			id: 999,
			is_bot: true,
			first_name: "Test",
			username: "test_bot",
			can_join_groups: false,
			can_read_all_group_messages: false,
			supports_inline_queries: false,
			can_connect_to_business: false,
			has_main_web_app: false,
			has_topics_enabled: false,
			allows_users_to_create_topics: false,
			can_manage_bots: false,
			supports_join_request_queries: false,
		},
	});
	bot.api.config.use(async (_previous, method, payload, signal) => {
		const data = payload as Record<string, unknown>;
		if (method === "getUpdates") {
			if (!signal || signal.aborted) return { ok: true, result: [] } as never;
			polls++;
			const updates = await new Promise<Update[]>((resolve) => {
				const abort = () => {
					pendingPoll = undefined;
					resolve([]);
				};
				signal.addEventListener("abort", abort, { once: true });
				pendingPoll = (batch) => {
					signal.removeEventListener("abort", abort);
					pendingPoll = undefined;
					resolve(batch);
				};
			});
			return { ok: true, result: updates } as never;
		}
		const call: (typeof calls)[number] = { method, payload: data };
		calls.push(call);
		await block(method, data);
		let result: unknown = true;
		if (method === "sendMessage" || method === "editMessageText") {
			result = {
				message_id: method === "sendMessage" ? messageId++ : data.message_id,
				date: 0,
				from: bot.botInfo,
				chat: { id: data.chat_id, type: "private" },
				text: data.text,
			};
			call.result = result as Record<string, unknown>;
		} else if (method === "getFile")
			result = {
				file_id: "file-1",
				file_unique_id: "unique-1",
				file_path: "docs/file.txt",
				file_size: 5,
			};
		return { ok: true, result } as never;
	});
	const fatal = vi.fn();
	let expectedStopFailure = false;
	const adapter = new TelegramTransportAdapter({
		token: "123456:TEST_ONLY",
		allowedUserIds: [42],
		initialCwd: cwd,
		stateDirectory: root,
		botFactory: () => bot as never,
		onFatal: fatal,
	});
	await adapter.start(
		async (request) => {
			requests.push(request);
			const custom = dispatch?.(request);
			if (custom) return custom;
			let value: unknown;
			if (request.kind === "inspect")
				value = { ...session, id: request.sessionId };
			else if (request.kind === "list") value = [session];
			else if (request.kind === "rename")
				value = { ...session, name: request.name };
			else if (request.kind === "submit") value = `input-${requests.length}`;
			else if (request.kind === "session_status") value = { session, live: {} };
			else if (request.kind === "command_list") value = [];
			return {
				requestId: request.requestId,
				ok: true,
				value,
			} as TransportResult;
		},
		(callback) => {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
		async () => [session],
		() => capabilities(),
	);
	await vi.waitFor(() => expect(pendingPoll).toBeDefined());
	const text = (body: string, sender = 42, chatType = "private"): Update =>
		({
			update_id: ++updateId,
			message: {
				message_id: updateId,
				date: 0,
				from: { id: sender, is_bot: false, first_name: "Operator" },
				chat: { id: 42, type: chatType },
				text: body,
			},
		}) as Update;
	const callback = (data: string, id: number, sender = 42): Update =>
		({
			update_id: ++updateId,
			callback_query: {
				id: `callback-${updateId}`,
				chat_instance: "test",
				from: { id: sender, is_bot: false, first_name: "Operator" },
				data,
				message: { message_id: id, date: 0, chat: { id: 42, type: "private" } },
			},
		}) as Update;
	const batch = async (...updates: Update[]) => {
		await vi.waitFor(() => expect(pendingPoll).toBeDefined());
		const next = polls + 1;
		if (!pendingPoll) throw new Error("No pending getUpdates request");
		pendingPoll(updates);
		await vi.waitFor(() => expect(polls).toBe(next));
	};
	const selected = async () => {
		await batch(text("/use session-1"));
		await vi.waitFor(() =>
			expect(
				calls.some(
					(call) =>
						call.method === "sendMessage" &&
						String(call.payload.text).includes("session-1"),
				),
			).toBe(true),
		);
	};
	const cancels = () =>
		requests.filter(
			(request) =>
				request.kind === "cancel" || request.kind === "cancel_current",
		);
	const gate = () => {
		const pending = deferred();
		gates.push(pending);
		return pending;
	};
	cleanups.push(async () => {
		for (const pending of gates) pending.resolve();
		await adapter.stop().catch((error: unknown) => {
			if (!expectedStopFailure) throw error;
		});
		await rm(root, { recursive: true, force: true });
	});
	return {
		adapter,
		bot,
		calls,
		requests,
		fatal,
		root,
		session,
		text,
		callback,
		batch,
		selected,
		cancels,
		gate,
		expectIncompleteStop: () => {
			expectedStopFailure = true;
		},
		setBlock: (fn: typeof block) => {
			block = fn;
		},
		setCapabilities: (fn: typeof capabilities) => {
			capabilities = fn;
		},
		setDispatch: (fn: typeof dispatch) => {
			dispatch = fn;
		},
		emit: (kind: HarnessEvent["kind"], text?: string) =>
			listener?.({
				sessionId: session.id,
				kind,
				...(text === undefined ? {} : { text }),
			} as HarnessEvent),
	};
}
function callWithButton(
	f: Awaited<ReturnType<typeof fixture>>,
	prefix: string,
) {
	const call = f.calls.findLast(
		(call) => call.result && buttonData(call, prefix),
	);
	if (!call?.result)
		throw new Error(`No confirmed message with button ${prefix}`);
	return { ...call, result: call.result };
}
function buttonData(
	call: { payload: Record<string, unknown> },
	prefix: string,
): string {
	const keyboard = (
		call.payload.reply_markup as {
			inline_keyboard: { callback_data?: string }[][];
		}
	)?.inline_keyboard;
	return (
		keyboard?.flat().find((button) => button.callback_data?.startsWith(prefix))
			?.callback_data ?? ""
	);
}

describe("Telegram cancellation at the real polling-batch boundary", () => {
	it.each([
		"sendMessage",
		"sendDocument",
		"getFile",
		"download",
		"editMessageText",
	])(
		"dispatches later /cancel while prior %s stays blocked",
		async (method) => {
			const f = await fixture();
			await f.selected();
			let panelId = 0;
			if (method === "editMessageText") {
				await f.batch(f.text("/menu"));
				await vi.waitFor(() =>
					expect(
						f.calls.some((call) => call.result && buttonData(call, "menu:")),
					).toBe(true),
				);
				panelId = Number(callWithButton(f, "menu:").result.message_id);
			}
			const blocked = f.gate();
			let reached = false;
			f.setBlock(async (apiMethod) => {
				if (apiMethod === method) {
					reached = true;
					await blocked.promise;
				}
			});
			if (method === "download")
				vi.stubGlobal(
					"fetch",
					vi.fn(async () => {
						reached = true;
						await blocked.promise;
						return new Response("hello");
					}),
				);
			if (method === "sendMessage") await f.batch(f.text("/help"));
			else if (method === "sendDocument")
				await f.batch(f.text("/send out.txt"));
			else if (method === "editMessageText")
				await f.batch(f.callback("menu:sessions", panelId));
			else {
				const incoming = f.text("");
				if ("message" in incoming && incoming.message) {
					delete incoming.message.text;
					incoming.message.document = {
						file_id: "file-1",
						file_unique_id: "unique-1",
						file_name: "file.txt",
						file_size: 5,
					};
				}
				await f.batch(incoming);
			}
			await vi.waitFor(() => expect(reached).toBe(true));
			await f.batch(f.text("/cancel"));
			await vi.waitFor(() => expect(f.cancels()).toHaveLength(1));
			expect(f.cancels()[0]).toMatchObject({
				kind: "cancel_current",
				sessionId: f.session.id,
				principalId: "42",
			});
			expect(f.fatal).not.toHaveBeenCalled();
			blocked.resolve();
		},
	);

	it("passes a same-batch cancel around a blocked reply and keeps ordinary input FIFO", async () => {
		const f = await fixture();
		await f.selected();
		const blocked = f.gate();
		f.setBlock(async (method) => {
			if (method === "sendMessage") await blocked.promise;
		});
		await f.batch(
			f.text("/help"),
			f.text("first"),
			f.text("/cancel exact-input"),
			f.text("second"),
		);
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(1));
		expect(f.cancels()[0]).toMatchObject({
			kind: "cancel",
			inputId: "exact-input",
		});
		expect(f.requests.filter((r) => r.kind === "submit")).toHaveLength(0);
		blocked.resolve();
		await vi.waitFor(() =>
			expect(f.requests.filter((r) => r.kind === "submit")).toHaveLength(2),
		);
		expect(
			f.requests
				.filter((r) => r.kind === "submit")
				.map((r) => r.kind === "submit" && r.text),
		).toEqual(["first", "second"]);
	});

	it("bounds admission, rejects overflow without submission, coalesces feedback, and leaves cancellation available", async () => {
		const f = await fixture();
		await f.selected();
		const blocked = f.gate();
		let reached = false;
		f.setBlock(async (method) => {
			if (method === "sendMessage") {
				reached = true;
				await blocked.promise;
			}
		});
		await f.batch(f.text("/help"));
		await vi.waitFor(() => expect(reached).toBe(true));
		await f.batch(
			...Array.from({ length: 99 }, (_, i) => f.text(`retained-${i}`)),
		);
		for (let i = 0; i < 3; i++)
			await f.batch(...Array.from({ length: 100 }, () => f.text("refused")));
		await f.batch(f.text("/cancel"));
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(1));
		expect(
			f.calls.filter((call) => String(call.payload.text).includes("Бот занят")),
		).toHaveLength(1);
		blocked.resolve();
		await vi.waitFor(() =>
			expect(f.requests.filter((r) => r.kind === "submit")).toHaveLength(99),
		);
		expect(
			f.requests
				.filter((r) => r.kind === "submit")
				.map((r) => r.kind === "submit" && r.text),
		).toEqual(Array.from({ length: 99 }, (_, i) => `retained-${i}`));
	});

	it("does not let blocked or failing cancellation acknowledgements gate later abort dispatch", async () => {
		const f = await fixture();
		await f.selected();
		const blocked = f.gate();
		f.setBlock(async (method) => {
			if (method === "sendMessage") await blocked.promise;
		});
		for (let i = 0; i < 3; i++)
			await f.batch(...Array.from({ length: 100 }, () => f.text("/cancel")));
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(300));
		expect(
			f.calls.filter((call) =>
				String(call.payload.text).includes("Запрошена отмена"),
			),
		).toHaveLength(8);
		blocked.resolve();
		await vi.waitFor(() =>
			expect(
				f.calls.filter(
					(call) =>
						call.result &&
						String(call.payload.text).includes("Запрошена отмена"),
				),
			).toHaveLength(8),
		);
		f.setBlock(async (method) => {
			if (method === "sendMessage")
				throw new Error("simulated unavailable Telegram");
		});
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		await f.batch(f.text("/cancel"));
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(301));
		await vi.waitFor(() => expect(diagnostic).toHaveBeenCalled());
		expect(
			f.calls.filter((call) =>
				String(call.payload.text).includes("Запрошена отмена"),
			),
		).toHaveLength(9);
		expect(f.fatal).not.toHaveBeenCalled();
	});

	it("rejects unauthorized/missing/non-private cancellation and preserves unsupported refusal", async () => {
		const f = await fixture();
		await f.selected();
		const missing = f.text("/cancel");
		if ("message" in missing && missing.message)
			Reflect.deleteProperty(missing.message, "from");
		await f.batch(
			f.text("/cancel", 7),
			f.text("/cancel", -1),
			f.text("/cancel", 1.5),
			f.text("/cancel", Number.NaN),
			f.text("/cancel", 42, "group"),
			missing,
			f.callback("card:stop:stale", 1000, 7),
		);
		expect(f.cancels()).toHaveLength(0);
		f.setCapabilities(async () => []);
		await f.batch(f.text("/cancel"), f.callback("card:stop:stale", 1000));
		expect(f.cancels()).toHaveLength(0);
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) =>
					String(call.payload.text).includes("не поддерживается"),
				),
			).toBe(true),
		);
	});

	it("rechecks selected-session currency after capability lookup", async () => {
		const f = await fixture();
		await f.selected();
		const capability = deferred<readonly Capability[]>();
		let entered = false;
		f.setCapabilities(async () => {
			entered = true;
			return capability.promise;
		});
		await f.batch(f.text("/cancel"));
		await vi.waitFor(() => expect(entered).toBe(true));
		await f.batch(f.text("/use session-2"));
		await vi.waitFor(() =>
			expect(
				f.requests.some(
					(r) => r.kind === "inspect" && r.sessionId === "session-2",
				),
			).toBe(true),
		);
		capability.resolve(["harness.cancel"]);
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) =>
					String(call.payload.text).includes("отмена не выполнялась"),
				),
			).toBe(true),
		);
		expect(f.cancels()).toHaveLength(0);
	});

	it("invalidates queued updates during shutdown and never submits them after the active wait releases", async () => {
		const f = await fixture();
		await f.selected();
		const blocked = f.gate();
		let reached = false;
		f.setBlock(async (method) => {
			if (method === "sendMessage") {
				reached = true;
				await blocked.promise;
			}
		});
		await f.batch(f.text("/help"));
		await vi.waitFor(() => expect(reached).toBe(true));
		await f.batch(f.text("must-not-submit"));
		const stopped = f.adapter.stop();
		blocked.resolve();
		await stopped;
		expect(f.requests.filter((r) => r.kind === "submit")).toHaveLength(0);
		expect(
			await import("node:fs/promises").then((fs) =>
				fs
					.stat(telegramLockPath("123456:TEST_ONLY", f.root))
					.catch(() => undefined),
			),
		).toBeUndefined();
	});

	it("bounds shutdown drain and refuses a late cancellation dispatch after capability lookup", async () => {
		const f = await fixture();
		await f.selected();
		const capability = deferred<readonly Capability[]>();
		let entered = false;
		f.setCapabilities(async () => {
			entered = true;
			return capability.promise;
		});
		await f.batch(f.text("/cancel"));
		await vi.waitFor(() => expect(entered).toBe(true));
		f.expectIncompleteStop();
		vi.useFakeTimers();
		try {
			const rejected = expect(f.adapter.stop()).rejects.toThrow(
				"polling lock retained",
			);
			await vi.advanceTimersByTimeAsync(30_000);
			await rejected;
			expect(
				await import("node:fs/promises").then((fs) =>
					fs.stat(telegramLockPath("123456:TEST_ONLY", f.root)),
				),
			).toBeDefined();
			capability.resolve(["harness.cancel"]);
			await vi.advanceTimersByTimeAsync(0);
			expect(f.cancels()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["settled", "new-turn", "steered-input"])(
		"revalidates live-card run currency when capability lookup races %s",
		async (race) => {
			const f = await fixture();
			await f.selected();
			await f.batch(f.text("start"));
			f.emit("status", "agent_start");
			await vi.waitFor(() =>
				expect(
					f.calls.some((call) => call.result && buttonData(call, "card:stop:")),
				).toBe(true),
			);
			const card = callWithButton(f, "card:stop:");
			const token = buttonData(card, "card:stop:");
			const id = Number(card.result.message_id);
			const capability = deferred<readonly Capability[]>();
			let entered = false;
			f.setCapabilities(async () => {
				entered = true;
				return capability.promise;
			});
			const tap = f.callback(token, id);
			await f.batch(tap);
			await vi.waitFor(() => expect(entered).toBe(true));
			if (race === "steered-input") {
				await f.batch(f.text("steered"));
				await vi.waitFor(() =>
					expect(
						f.requests.filter((request) => request.kind === "submit"),
					).toHaveLength(2),
				);
			} else {
				f.emit("status", "agent_settled");
				if (race === "new-turn") f.emit("status", "agent_start");
			}
			capability.resolve(["harness.cancel"]);
			await vi.waitFor(() =>
				expect(
					f.calls.some(
						(call) =>
							call.method === "answerCallbackQuery" &&
							call.payload.callback_query_id === tap.callback_query?.id,
					),
				).toBe(true),
			);
			expect(f.cancels()).toHaveLength(race === "steered-input" ? 1 : 0);
		},
	);

	it("keeps a /cancel reply to a naming prompt in the ordinary FIFO rather than running it as cancellation", async () => {
		const f = await fixture();
		await f.selected();
		await f.batch(f.text("/menu"));
		await vi.waitFor(() =>
			expect(
				f.calls.some(
					(call) => call.result && buttonData(call, "session:rename:"),
				),
			).toBe(true),
		);
		const panel = callWithButton(f, "session:rename:");
		await f.batch(
			f.callback(
				buttonData(panel, "session:rename:"),
				Number(panel.result.message_id),
			),
		);
		await vi.waitFor(() =>
			expect(
				f.calls.some(
					(call) =>
						call.result &&
						(call.payload.reply_markup as { force_reply?: boolean })
							?.force_reply,
				),
			).toBe(true),
		);
		const prompt = f.calls.findLast(
			(call) =>
				call.result &&
				(call.payload.reply_markup as { force_reply?: boolean })?.force_reply,
		);
		if (!prompt?.result) throw new Error("No naming prompt");
		const blocked = f.gate();
		f.setBlock(async (method) => {
			if (method === "sendMessage") await blocked.promise;
		});
		await f.batch(f.text("/help"));
		const reply = f.text("/cancel");
		if (reply.message)
			reply.message.reply_to_message = {
				...prompt.result,
				message_id: Number(prompt.result.message_id),
			} as never;
		await f.batch(reply, f.text("/cancel"));
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(1));
		expect(f.requests.filter((r) => r.kind === "rename")).toHaveLength(0);
		expect(
			f.calls.some((call) =>
				String(call.payload.text).includes("Name operation cancelled"),
			),
		).toBe(false);
		blocked.resolve();
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) =>
					String(call.payload.text).includes("Name operation cancelled"),
				),
			).toBe(true),
		);
		expect(f.requests.filter((r) => r.kind === "rename")).toHaveLength(0);
		expect(f.cancels()).toHaveLength(1);
	});

	it("refuses an expired one-shot keyboard cancellation", async () => {
		const f = await fixture();
		await f.selected();
		await f.batch(f.text("✋ Прервать"));
		await vi.waitFor(() =>
			expect(
				f.calls.some(
					(call) => call.result && buttonData(call, "run-cancel:yes:"),
				),
			).toBe(true),
		);
		const confirmation = callWithButton(f, "run-cancel:yes:");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
		await f.batch(
			f.callback(
				buttonData(confirmation, "run-cancel:yes:"),
				Number(confirmation.result.message_id),
			),
		);
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) =>
					String(call.payload.text).includes("Подтверждение устарело"),
				),
			).toBe(true),
		);
		expect(f.cancels()).toHaveLength(0);
	});

	it("serializes and bounds cancellation operations even during a polling flood", async () => {
		const f = await fixture();
		await f.selected();
		const response = deferred<TransportResult>();
		let active = 0;
		let maximum = 0;
		f.setDispatch((request) => {
			if (request.kind !== "cancel_current") return undefined;
			active++;
			maximum = Math.max(maximum, active);
			return response.promise.then(() => {
				active--;
				return { requestId: request.requestId, ok: true, value: undefined };
			});
		});
		await f.batch(f.text("/cancel"));
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(1));
		for (let i = 0; i < 3; i++)
			await f.batch(...Array.from({ length: 100 }, () => f.text("/cancel")));
		expect(f.cancels()).toHaveLength(1);
		response.resolve({ requestId: "ignored", ok: true, value: undefined });
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(100));
		expect(maximum).toBe(1);
		expect(
			f.calls.filter((call) => String(call.payload.text).includes("Бот занят")),
		).toHaveLength(1);
	});

	it("refuses a queued card tap when an earlier cancellation operation spans a new turn", async () => {
		const f = await fixture();
		await f.selected();
		await f.batch(f.text("start"));
		f.emit("status", "agent_start");
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) => call.result && buttonData(call, "card:stop:")),
			).toBe(true),
		);
		const card = callWithButton(f, "card:stop:");
		const response = deferred<TransportResult>();
		f.setDispatch((request) =>
			request.kind === "cancel_current" ? response.promise : undefined,
		);
		await f.batch(f.text("/cancel"));
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(1));
		await f.batch(
			f.callback(
				buttonData(card, "card:stop:"),
				Number(card.result.message_id),
			),
		);
		f.emit("status", "agent_settled");
		f.emit("status", "agent_start");
		response.resolve({ requestId: "ignored", ok: true, value: undefined });
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) =>
					String(call.payload.text).includes("ход изменились"),
				),
			).toBe(true),
		);
		expect(f.cancels()).toHaveLength(1);
	});

	it("refuses unsupported live-card cancellation and stale keyboard selection", async () => {
		const f = await fixture();
		await f.selected();
		await f.batch(f.text("start"));
		f.emit("status", "agent_start");
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) => call.result && buttonData(call, "card:stop:")),
			).toBe(true),
		);
		const card = callWithButton(f, "card:stop:");
		f.setCapabilities(async () => []);
		const tap = f.callback(
			buttonData(card, "card:stop:"),
			Number(card.result.message_id),
		);
		await f.batch(tap);
		await vi.waitFor(() =>
			expect(
				f.calls.some(
					(call) =>
						call.method === "answerCallbackQuery" &&
						call.payload.callback_query_id === tap.callback_query?.id,
				),
			).toBe(true),
		);
		expect(f.cancels()).toHaveLength(0);
		f.setCapabilities(async () => ["harness.cancel"]);
		await f.batch(f.text("✋ Прервать"));
		await vi.waitFor(() =>
			expect(
				f.calls.some(
					(call) => call.result && buttonData(call, "run-cancel:yes:"),
				),
			).toBe(true),
		);
		const confirmation = callWithButton(f, "run-cancel:yes:");
		await f.batch(f.text("/use session-2"));
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) => String(call.payload.text).includes("session-2")),
			).toBe(true),
		);
		await f.batch(
			f.callback(
				buttonData(confirmation, "run-cancel:yes:"),
				Number(confirmation.result.message_id),
			),
		);
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) =>
					String(call.payload.text).includes("Выбор сессии изменился"),
				),
			).toBe(true),
		);
		expect(f.cancels()).toHaveLength(0);
	});

	it("dispatches live-card and one-shot confirmed keyboard cancels without waiting for earlier replies or acknowledgements", async () => {
		const f = await fixture();
		await f.selected();
		await f.batch(f.text("start"));
		f.emit("status", "agent_start");
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) => call.result && buttonData(call, "card:stop:")),
			).toBe(true),
		);
		const card = callWithButton(f, "card:stop:");
		await f.batch(f.text("✋ Прервать"));
		await vi.waitFor(() =>
			expect(
				f.calls.some(
					(call) => call.result && buttonData(call, "run-cancel:yes:"),
				),
			).toBe(true),
		);
		const confirmation = callWithButton(f, "run-cancel:yes:");
		const yes = buttonData(confirmation, "run-cancel:yes:");
		const id = Number(confirmation.result.message_id);
		const blocked = f.gate();
		let reached = false;
		f.setBlock(async (method) => {
			if (
				["sendMessage", "answerCallbackQuery", "editMessageText"].includes(
					method,
				)
			) {
				reached = true;
				await blocked.promise;
			}
		});
		await f.batch(f.text("/help"));
		await vi.waitFor(() => expect(reached).toBe(true));
		await f.batch(
			f.callback(
				buttonData(card, "card:stop:"),
				Number(card.result.message_id),
			),
			f.callback(yes, id, 7),
			f.callback(yes, id + 1),
			f.callback(yes, id),
			f.callback(yes, id),
		);
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(2));
		await f.batch(f.callback("run-cancel:yes:stale", id));
		expect(f.cancels()).toHaveLength(2);
		blocked.resolve();
	});
});

function cancelPhaseLines(sink: {
	mock: { calls: readonly (readonly unknown[])[] };
}): string[] {
	return sink.mock.calls.flatMap((call) =>
		typeof call[0] === "string" &&
		call[0].startsWith("harnessd: telegram_cancel ")
			? [call[0]]
			: [],
	);
}
function cancelPhaseFields(line: string): Record<string, string> {
	return Object.fromEntries(
		line
			.split(" ")
			.slice(2)
			.map((field) => field.split("=")),
	);
}
async function cancellationAction(
	f: Awaited<ReturnType<typeof fixture>>,
	source: "slash" | "card" | "keyboard",
) {
	if (source === "slash") return f.text("/cancel private-input-id-do-not-log");
	if (source === "card") {
		await f.batch(f.text("private prompt body do not log"));
		f.emit("status", "agent_start");
		await vi.waitFor(() =>
			expect(
				f.calls.some((call) => call.result && buttonData(call, "card:stop:")),
			).toBe(true),
		);
		const card = callWithButton(f, "card:stop:");
		return f.callback(
			buttonData(card, "card:stop:"),
			Number(card.result.message_id),
		);
	}
	await f.batch(f.text("✋ Прервать"));
	await vi.waitFor(() =>
		expect(
			f.calls.some(
				(call) => call.result && buttonData(call, "run-cancel:yes:"),
			),
		).toBe(true),
	);
	const confirmation = callWithButton(f, "run-cancel:yes:");
	return f.callback(
		buttonData(confirmation, "run-cancel:yes:"),
		Number(confirmation.result.message_id),
	);
}

describe("Telegram cancellation phase diagnostics", () => {
	it.each(["slash", "card", "keyboard"] as const)(
		"correlates authorized %s admission, dispatch, runtime result and independent acknowledgements",
		async (source) => {
			const sink = vi.spyOn(console, "error").mockImplementation(() => {});
			const f = await fixture();
			await f.selected();
			const action = await cancellationAction(f, source);
			const held = f.gate();
			f.setBlock(async (method) => {
				if (
					["sendMessage", "answerCallbackQuery", "editMessageText"].includes(
						method,
					)
				)
					await held.promise;
			});
			await f.batch(action);
			await vi.waitFor(() => expect(f.cancels()).toHaveLength(1));
			const initial = cancelPhaseLines(sink).map(cancelPhaseFields);
			expect(initial.map((event) => [event.phase, event.outcome])).toEqual([
				["observed", "adapter_ingress"],
				["admission", "admitted"],
				["dispatch", "started"],
				["result", "confirmed"],
			]);
			const ref = initial[0]?.ref;
			expect(ref).toMatch(/^[a-f0-9]{8}$/);
			expect(
				initial.every((event) => event.ref === ref && event.source === source),
			).toBe(true);
			held.resolve();
			const channels =
				source === "slash"
					? ["reply"]
					: source === "card"
						? ["reply", "callback"]
						: ["confirmation", "reply", "callback"];
			await vi.waitFor(() =>
				expect(
					cancelPhaseLines(sink)
						.map(cancelPhaseFields)
						.filter((event) => event.phase === "ack"),
				).toHaveLength(channels.length),
			);
			const entries = cancelPhaseLines(sink).map(cancelPhaseFields);
			expect(
				entries
					.filter((event) => event.phase === "ack")
					.map((event) => event.channel)
					.sort(),
			).toEqual(channels.sort());
			expect(
				entries
					.filter((event) => event.phase === "ack")
					.every((event) => event.outcome === "confirmed" && event.ref === ref),
			).toBe(true);
			const serialized = cancelPhaseLines(sink).join("\n");
			for (const forbidden of [
				"private-input-id-do-not-log",
				"private prompt body",
				"session-1",
				"123456:TEST_ONLY",
				action.callback_query?.data ?? "never-present-callback-token",
			])
				expect(serialized).not.toContain(forbidden);
			expect(
				entries.every((event) =>
					Object.keys(event).every((key) =>
						[
							"ref",
							"source",
							"phase",
							"outcome",
							"channel",
							"suppressed",
						].includes(key),
					),
				),
			).toBe(true);
		},
	);

	it.each(["slash", "card", "keyboard"] as const)(
		"records failed %s acknowledgement without undoing cancellation or logging error details",
		async (source) => {
			const sink = vi.spyOn(console, "error").mockImplementation(() => {});
			const f = await fixture();
			await f.selected();
			const action = await cancellationAction(f, source);
			const method =
				source === "slash"
					? "sendMessage"
					: source === "card"
						? "answerCallbackQuery"
						: "editMessageText";
			const channel =
				source === "slash"
					? "reply"
					: source === "card"
						? "callback"
						: "confirmation";
			f.setBlock(async (called) => {
				if (called === method)
					throw new Error(
						"https://secret.invalid/?token=credential private prompt stderr ENV=secret",
					);
			});
			await f.batch(action);
			await vi.waitFor(() =>
				expect(
					cancelPhaseLines(sink).some((line) =>
						line.includes(`phase=ack outcome=unconfirmed channel=${channel}`),
					),
				).toBe(true),
			);
			expect(f.cancels()).toHaveLength(1);
			expect(
				cancelPhaseLines(sink).some((line) =>
					line.includes("phase=result outcome=confirmed"),
				),
			).toBe(true);
			expect(cancelPhaseLines(sink).join("\n")).not.toMatch(
				/secret|credential|stderr|ENV=|https:/,
			);
		},
	);

	it.each([
		["confirmed", undefined],
		["refused", "UNSUPPORTED_CAPABILITY"],
		["uncertain", "PI_CONTROL_FAILED"],
		["error", "OPERATION_FAILED"],
		["error", "raw-code-token-env-stderr"],
	] as const)(
		"records runtime %s with safe classification for %s",
		async (outcome, code) => {
			const sink = vi.spyOn(console, "error").mockImplementation(() => {});
			const f = await fixture();
			await f.selected();
			f.setDispatch((request) =>
				request.kind === "cancel"
					? Promise.resolve(
							code
								? {
										requestId: request.requestId,
										ok: false,
										error: {
											code,
											message:
												"private prompt https://secret.invalid/?token=credential stderr ENV=secret",
										},
									}
								: { requestId: request.requestId, ok: true, value: undefined },
						)
					: undefined,
			);
			await f.batch(f.text("/cancel private-exact-input"));
			await vi.waitFor(() =>
				expect(
					cancelPhaseLines(sink).some((line) =>
						line.includes(`phase=result outcome=${outcome}`),
					),
				).toBe(true),
			);
			const result = cancelPhaseLines(sink)
				.map(cancelPhaseFields)
				.filter((event) => event.phase === "result");
			expect(result).toHaveLength(1);
			expect(
				cancelPhaseLines(sink).some(
					(line) =>
						line.includes(`ref=${result[0]?.ref}`) &&
						line.includes("phase=dispatch outcome=started"),
				),
			).toBe(true);
			expect(cancelPhaseLines(sink).join("\n")).not.toMatch(
				/private|secret|credential|stderr|ENV=|https:|raw-code/,
			);
		},
	);

	it("records a thrown runtime error and its existing error-reply outcome without inventing a refusal", async () => {
		const sink = vi.spyOn(console, "error").mockImplementation(() => {});
		const f = await fixture();
		await f.selected();
		f.setDispatch((request) =>
			request.kind === "cancel_current"
				? Promise.reject(new Error("private runtime detail"))
				: undefined,
		);
		await f.batch(f.text("/cancel"));
		await vi.waitFor(() =>
			expect(
				cancelPhaseLines(sink).some((line) =>
					line.includes("phase=ack outcome=confirmed channel=reply"),
				),
			).toBe(true),
		);
		expect(
			cancelPhaseLines(sink).filter((line) => line.includes("phase=result")),
		).toHaveLength(1);
		expect(
			cancelPhaseLines(sink).some((line) =>
				line.includes("phase=result outcome=error"),
			),
		).toBe(true);
		expect(f.fatal).not.toHaveBeenCalled();
	});

	it("logs neither unauthorized cancellation details nor a runtime dispatch for unsupported or stale requests", async () => {
		const sink = vi.spyOn(console, "error").mockImplementation(() => {});
		const f = await fixture();
		await f.selected();
		await f.batch(
			f.text("/cancel unauthorized-secret", 7),
			f.text("/cancel", 42, "group"),
		);
		expect(cancelPhaseLines(sink)).toEqual([]);
		f.setCapabilities(async () => []);
		await f.batch(f.text("/cancel"));
		await vi.waitFor(() =>
			expect(
				cancelPhaseLines(sink).some((line) =>
					line.includes("phase=result outcome=refused"),
				),
			).toBe(true),
		);
		await f.batch(f.callback("card:stop:stale-private-token", 555));
		await vi.waitFor(() =>
			expect(
				cancelPhaseLines(sink).some((line) =>
					line.includes("source=card phase=result outcome=refused"),
				),
			).toBe(true),
		);
		expect(
			cancelPhaseLines(sink).some((line) => line.includes("phase=dispatch")),
		).toBe(false);
		expect(f.cancels()).toHaveLength(0);
		expect(cancelPhaseLines(sink).join("\n")).not.toMatch(
			/unauthorized-secret|stale-private-token/,
		);
	});

	it("bounds flooding logs and state while observing ingress refusal and dropped feedback without gating aborts", async () => {
		const sink = vi.spyOn(console, "error").mockImplementation(() => {});
		const f = await fixture();
		await f.selected();
		const runtime = f.gate();
		const acknowledgement = f.gate();
		f.setDispatch((request) =>
			request.kind === "cancel_current"
				? runtime.promise.then(() => ({
						requestId: request.requestId,
						ok: true,
						value: undefined,
					}))
				: undefined,
		);
		f.setBlock(async (method) => {
			if (method === "sendMessage") await acknowledgement.promise;
		});
		await f.batch(f.text("/cancel"));
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(1));
		for (let batch = 0; batch < 3; batch++)
			await f.batch(...Array.from({ length: 100 }, () => f.text("/cancel")));
		expect(
			cancelPhaseLines(sink).some((line) =>
				line.includes("phase=admission outcome=refused"),
			),
		).toBe(true);
		runtime.resolve();
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(100));
		await vi.waitFor(() =>
			expect(
				cancelPhaseLines(sink).some((line) =>
					line.includes("phase=ack outcome=dropped channel=reply"),
				),
			).toBe(true),
		);
		expect(cancelPhaseLines(sink).length).toBeLessThanOrEqual(10);
		expect(
			(
				f.adapter as unknown as {
					cancelDiagnostics: { buckets: Map<string, unknown> };
				}
			).cancelDiagnostics.buckets.size,
		).toBeLessThanOrEqual(10);
		acknowledgement.resolve();
		await vi.waitFor(() =>
			expect(
				f.calls
					.filter((call) => call.method === "sendMessage")
					.every((call) => call.result),
			).toBe(true),
		);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
		await f.batch(f.text("/cancel"));
		await vi.waitFor(() => expect(f.cancels()).toHaveLength(101));
		expect(
			cancelPhaseLines(sink).some((line) =>
				line.includes("phase=observed outcome=adapter_ingress suppressed=300"),
			),
		).toBe(true);
	});

	it.each(["slash", "card", "keyboard"] as const)(
		"keeps %s operation and acknowledgements working when the diagnostic sink throws",
		async (source) => {
			const f = await fixture();
			await f.selected();
			const action = await cancellationAction(f, source);
			const sink = vi.spyOn(console, "error").mockImplementation(() => {
				throw new Error("diagnostic sink unavailable");
			});
			try {
				await f.batch(action);
				await vi.waitFor(() => expect(f.cancels()).toHaveLength(1));
				await vi.waitFor(() =>
					expect(
						f.calls.some(
							(call) =>
								call.result &&
								String(call.payload.text).includes("Запрошена отмена ввода"),
						),
					).toBe(true),
				);
				expect(f.fatal).not.toHaveBeenCalled();
			} finally {
				sink.mockRestore();
			}
		},
	);
});
