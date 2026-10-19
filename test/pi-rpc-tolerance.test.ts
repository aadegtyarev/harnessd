import { describe, expect, it, vi } from "vitest";
import type { HarnessEvent, InputId } from "../src/core/types.js";
import {
	InputNotDeliveredError,
	PiRpcHarnessAdapter,
	UncertainInputDeliveryError,
} from "../src/harness/index.js";
import {
	type FakeOptions,
	fakeProvider,
	input,
	request,
} from "./pi-rpc-fake.js";

/** Internal stream state, read only to prove the oversized-line memory bound. */
interface StreamState {
	buffer: string;
	oversized?: { head: string; bytes: number };
}

async function launch(options: FakeOptions = {}, maxRecordBytes?: number) {
	const fake = fakeProvider({ exitOnTerm: false, ...options });
	const instance = await new PiRpcHarnessAdapter(fake.provider, {
		executable: "pi",
		startupTimeoutMs: 200,
		shutdownTimeoutMs: 20,
		exitDrainTimeoutMs: 100,
		...(maxRecordBytes ? { maxRecordBytes } : {}),
	}).launch(request);
	const events: HarnessEvent[] = [];
	let done = false;
	void (async () => {
		for await (const event of instance.events) events.push(event);
		done = true;
	})();
	return { fake, instance, events, isDone: () => done };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const anomalies = (events: readonly HarnessEvent[]) =>
	events.flatMap((event) => (event.anomalyEvent ? [event.anomalyEvent] : []));
const statuses = (events: readonly HarnessEvent[]) =>
	events.filter((event) => event.kind === "status").map((event) => event.text);

async function stillRunning(fake: ReturnType<typeof fakeProvider>) {
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(fake.signals).toEqual([]);
}

describe("Pi RPC oversized records", () => {
	it("ends a run normally after a 5 MiB agent_end streamed in chunks with bounded memory", async () => {
		const { fake, instance, events } = await launch({
			promptDisposition: "started",
		});
		await instance.send(input("long run", "run"));
		fake.stdout.write(
			`${[
				{ type: "agent_start" },
				{
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "answer" },
				},
				{ type: "message_end", message: { role: "assistant" } },
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const body = JSON.stringify({
			type: "agent_end",
			messages: [{ role: "assistant", content: "x".repeat(5 * 1024 * 1024) }],
		});
		const line = `${body}\n`;
		const state = instance as unknown as StreamState;
		let peakBuffer = 0;
		let peakHead = 0;
		const chunk = 64 * 1024;
		for (let offset = 0; offset < line.length; offset += chunk) {
			fake.stdout.write(line.slice(offset, offset + chunk));
			await tick();
			peakBuffer = Math.max(peakBuffer, state.buffer.length);
			peakHead = Math.max(peakHead, state.oversized?.head.length ?? 0);
			if (offset > 2 * 1024 * 1024) expect(state.buffer).toBe("");
		}
		// Never more than the record limit is buffered, and only a 16 KiB head once over it.
		expect(peakBuffer).toBeLessThanOrEqual(1024 * 1024);
		expect(peakHead).toBeLessThanOrEqual(16 * 1024);
		expect(state.oversized).toBeUndefined();
		fake.stdout.write('{"type":"agent_settled"}\n');
		await vi.waitFor(() =>
			expect(
				events.some((event) => event.inputEvent?.state === "completed"),
			).toBe(true),
		);
		expect(statuses(events)).toEqual([
			"agent_start",
			"message_end",
			"agent_end",
			"agent_settled",
		]);
		expect(events.find((event) => event.kind === "output")?.text).toBe(
			"answer",
		);
		expect(anomalies(events)).toEqual([
			expect.objectContaining({
				kind: "oversized_record",
				action: "handled",
				harnessRunning: true,
				recordType: "agent_end",
				bytes: Buffer.byteLength(body),
			}),
		]);
		expect(anomalies(events)[0]).not.toHaveProperty("head");
		expect(events.some((event) => event.kind === "error")).toBe(false);
		await stillRunning(fake);
		await instance.shutdown();
	});

	it("emits tool-finished activity with unknown outcome for a large tool_execution_end", async () => {
		const { fake, instance, events } = await launch({}, 4096);
		fake.stdout.write(
			`${JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "cat big.log" },
			})}\n${JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "y".repeat(20_000) }] },
				isError: false,
			})}\n`,
		);
		await vi.waitFor(() => expect(anomalies(events)).toHaveLength(1));
		expect(
			events.find((event) => event.activityEvent?.type === "tool_end")
				?.activityEvent,
			// Pi writes isError after the result, so the outcome is not claimed.
		).toEqual({ type: "tool_end", toolCallId: "call-1" });
		expect(anomalies(events)[0]).toMatchObject({
			kind: "oversized_record",
			action: "handled",
			recordType: "tool_execution_end",
		});
		await stillRunning(fake);
		await instance.shutdown();
	});

	it("emits the message boundary for a large assistant message_end and skips unknown types", async () => {
		const { fake, instance, events } = await launch({}, 4096);
		fake.stdout.write(
			`${JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: "z".repeat(10_000) },
			})}\n${JSON.stringify({ type: "mystery", data: "q".repeat(10_000) })}\n${"w".repeat(10_000)}\n`,
		);
		await vi.waitFor(() => expect(anomalies(events)).toHaveLength(3));
		expect(statuses(events)).toEqual(["message_end"]);
		expect(anomalies(events).map((item) => item.action)).toEqual([
			"handled",
			"skipped",
			"skipped",
		]);
		expect(anomalies(events)[1]?.recordType).toBe("mystery");
		expect(anomalies(events)[2]?.recordType).toBeUndefined();
		await stillRunning(fake);
		await instance.shutdown();
	});

	it("fails a pending command on an oversized response without killing Pi", async () => {
		const { fake, instance, events } = await launch({ holdPrompt: true }, 4096);
		const sending = instance.send(input("question", "big-ack"));
		await vi.waitFor(() =>
			expect(fake.commands.some((item) => item.type === "prompt")).toBe(true),
		);
		const prompt = fake.commands.find((item) => item.type === "prompt");
		fake.stdout.write(
			`${JSON.stringify({
				id: prompt?.id,
				type: "response",
				command: "prompt",
				success: true,
				data: { padding: "p".repeat(10_000) },
			})}\n`,
		);
		await expect(sending).rejects.toBeInstanceOf(UncertainInputDeliveryError);
		expect(anomalies(events)).toEqual([
			expect.objectContaining({
				kind: "oversized_record",
				action: "failed_command",
				recordType: "response",
				command: "prompt",
				harnessRunning: true,
			}),
		]);
		await stillRunning(fake);
		fake.stdout.write('{"type":"agent_start"}\n');
		await vi.waitFor(() => expect(statuses(events)).toContain("agent_start"));
		await instance.shutdown();
	});
});

describe("Pi RPC protocol anomalies", () => {
	it.each([
		["non-JSON line", "Warning: plain text on stdout", "invalid_json"],
		["record without type", '{"kind":"agent_start"}', "missing_type"],
		[
			"id-less parse error response",
			'{"type":"response","command":"parse","success":false,"error":"Failed to parse command"}',
			"response_without_id",
		],
	] as const)("skips a %s and keeps Pi running", async (_name, line, kind) => {
		const { fake, instance, events } = await launch();
		fake.stdout.write(`${line}\n{"type":"agent_start"}\n`);
		await vi.waitFor(() => expect(statuses(events)).toContain("agent_start"));
		expect(anomalies(events)).toEqual([
			expect.objectContaining({
				kind,
				action: "skipped",
				harnessRunning: true,
				bytes: Buffer.byteLength(line),
				head: line,
				ref: expect.stringMatching(/^[0-9a-f]{8}$/),
			}),
		]);
		expect(events.some((event) => event.kind === "error")).toBe(false);
		await stillRunning(fake);
		await instance.shutdown();
	});

	it("redacts and bounds the journaled head of a skipped line", async () => {
		const { fake, instance, events } = await launch();
		fake.stdout.write(`token=hunter2secret ${"n".repeat(2000)}\n`);
		await vi.waitFor(() => expect(anomalies(events)).toHaveLength(1));
		const head = anomalies(events)[0]?.head ?? "";
		expect(head).not.toContain("hunter2secret");
		expect(head).toContain("[REDACTED]");
		expect(head.length).toBeLessThanOrEqual(300);
		await instance.shutdown();
	});

	it("fails the pending command on a response for another command", async () => {
		const { fake, instance, events } = await launch({ holdPrompt: true });
		const sending = instance.send(input("question", "mismatch"));
		await vi.waitFor(() =>
			expect(fake.commands.some((item) => item.type === "prompt")).toBe(true),
		);
		const prompt = fake.commands.find((item) => item.type === "prompt");
		fake.stdout.write(
			`${JSON.stringify({ id: prompt?.id, type: "response", command: "abort", success: true })}\n{"type":"agent_start"}\n`,
		);
		await expect(sending).rejects.toBeInstanceOf(UncertainInputDeliveryError);
		await vi.waitFor(() => expect(statuses(events)).toContain("agent_start"));
		expect(anomalies(events)).toEqual([
			expect.objectContaining({
				kind: "response_mismatch",
				action: "failed_command",
				command: "prompt",
				harnessRunning: true,
			}),
		]);
		await stillRunning(fake);
		await instance.shutdown();
	});

	it("reports a throwing record handler as an internal error naming the record type", async () => {
		const { fake, instance, events } = await launch();
		const target = instance as unknown as {
			event(record: Record<string, unknown>): void;
		};
		const original = target.event.bind(instance);
		target.event = (record) => {
			if (record.type === "turn_start") throw new Error("handler bug");
			original(record);
		};
		fake.stdout.write('{"type":"turn_start"}\n{"type":"agent_start"}\n');
		await vi.waitFor(() => expect(statuses(events)).toContain("agent_start"));
		expect(anomalies(events)).toEqual([
			expect.objectContaining({
				kind: "handler_error",
				recordType: "turn_start",
				detail: "Error: handler bug",
				harnessRunning: true,
			}),
		]);
		await stillRunning(fake);
		await instance.shutdown();
	});

	it("does not count harnessd handler errors towards the corrupted-stream threshold", async () => {
		const { fake, instance, events } = await launch();
		const target = instance as unknown as {
			event(record: Record<string, unknown>): void;
		};
		target.event = () => {
			throw new Error("handler bug");
		};
		fake.stdout.write(
			`${"bad\n".repeat(15)}${'{"type":"turn_start"}\n'.repeat(25)}${"bad\n".repeat(15)}`,
		);
		await vi.waitFor(() => expect(anomalies(events)).toHaveLength(55));
		expect(
			anomalies(events).some((item) => item.kind === "corrupted_stream"),
		).toBe(false);
		await stillRunning(fake);
		await instance.shutdown();
	});

	it("stops Pi after more than 20 consecutive anomalies", async () => {
		const { fake, instance, events, isDone } = await launch();
		fake.stdout.write("bad\n".repeat(21));
		await vi.waitFor(() => expect(isDone()).toBe(true));
		expect(fake.signals).toContain("SIGTERM");
		expect(anomalies(events).at(-1)).toMatchObject({
			kind: "corrupted_stream",
			action: "stopped",
			harnessRunning: false,
		});
		// 21 skipped lines plus the corrupted-stream report.
		expect(anomalies(events)).toHaveLength(22);
		expect(events.find((event) => event.kind === "error")).toMatchObject({
			fatal: true,
			text: expect.stringContaining("more than 20 consecutive"),
			stop: { reason: "stream_corrupted" },
		});
		await instance.shutdown();
	});

	it("does not count anomalies separated by valid records as a burst", async () => {
		const { fake, instance, events } = await launch();
		fake.stdout.write(
			`${"bad\n".repeat(20)}{"type":"turn_start"}\n${"bad\n".repeat(20)}`,
		);
		await vi.waitFor(() => expect(anomalies(events)).toHaveLength(40));
		await stillRunning(fake);
		await instance.shutdown();
	});
});

describe("Pi RPC stop and prompt delivery", () => {
	it("reports a partial record at EOF after exit as the process stopping", async () => {
		const { fake, instance, events, isDone } = await launch();
		fake.stdout.write('{"type":"agent_e');
		await fake.child.sendSignal("SIGTERM");
		await vi.waitFor(() => expect(isDone()).toBe(true));
		expect(anomalies(events)).toEqual([
			expect.objectContaining({
				kind: "truncated_record",
				harnessRunning: false,
				bytes: 16,
				detail: "Pi process exited (SIGTERM)",
			}),
		]);
		const errors = events.filter((event) => event.kind === "error");
		expect(errors).toEqual([
			expect.objectContaining({
				text: "Pi process exited (SIGTERM)",
				stop: { reason: "process_exited", exit: "SIGTERM" },
			}),
		]);
		await instance.shutdown();
	});

	it("reports a partial record during harnessd shutdown as that shutdown", async () => {
		const { fake, instance, events } = await launch({ exitOnTerm: true });
		fake.stdout.write('{"type":"agent_end","messages":[{"role":"assi');
		await instance.shutdown();
		expect(anomalies(events)).toEqual([
			expect.objectContaining({
				kind: "truncated_record",
				detail: "Pi harness shut down",
				stopRequested: true,
				recordType: "agent_end",
			}),
		]);
		expect(events.some((event) => event.kind === "error")).toBe(false);
	});

	it("holds a prompt during manual compaction and sends it after compaction_end", async () => {
		const { fake, instance, events } = await launch();
		fake.stdout.write('{"type":"compaction_start","reason":"manual"}\n');
		await tick();
		const sending = instance.send(input("after compaction", "held"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fake.commands.some((item) => item.type === "prompt")).toBe(false);
		expect(anomalies(events)).toEqual([
			expect.objectContaining({
				kind: "prompt_held",
				action: "held_prompt",
				harnessRunning: true,
			}),
		]);
		fake.stdout.write('{"type":"compaction_end","reason":"manual"}\n');
		await expect(sending).resolves.toBeUndefined();
		expect(fake.commands.find((item) => item.type === "prompt")).toMatchObject({
			message: "after compaction",
			streamingBehavior: "steer",
		});
		await instance.shutdown();
	});

	it("fails a held prompt explicitly when compaction does not finish in time", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 200,
			compactionHoldTimeoutMs: 20,
		}).launch(request);
		const events: HarnessEvent[] = [];
		void (async () => {
			for await (const event of instance.events) events.push(event);
		})();
		fake.stdout.write('{"type":"compaction_start","reason":"manual"}\n');
		await tick();
		const sending = instance.send(input("late", "late"));
		await expect(sending).rejects.toBeInstanceOf(InputNotDeliveredError);
		await expect(sending).rejects.toThrow(
			"Pi compaction did not finish in time; the input was not sent",
		);
		// The recheck asked Pi whether it still compacts.
		expect(
			fake.commands.filter((item) => item.type === "get_state"),
		).toHaveLength(2);
		expect(fake.commands.some((item) => item.type === "prompt")).toBe(false);
		expect(
			events.filter((event) => event.inputEvent).map((e) => e.inputEvent),
		).toEqual([
			{ inputId: "late", state: "pending" },
			{
				inputId: "late",
				state: "failed",
				detail: "Pi compaction did not finish in time; the input was not sent",
				failure: { reason: "hold_timeout" },
			},
		]);
		await sending.catch((error: InputNotDeliveredError) =>
			expect(error.failure).toEqual({ reason: "hold_timeout" }),
		);
		expect(anomalies(events).map((item) => item.kind)).toEqual([
			"prompt_held",
			"prompt_hold_timeout",
		]);
		await instance.shutdown();
	});

	it("fails a held prompt as not sent when Pi stops during compaction", async () => {
		const { fake, instance, events } = await launch();
		fake.stdout.write('{"type":"compaction_start"}\n');
		await tick();
		const sending = instance.send(input("held", "stopped"));
		await tick();
		await fake.child.sendSignal("SIGTERM");
		await expect(sending).rejects.toBeInstanceOf(InputNotDeliveredError);
		expect(
			events.find(
				(event) => event.inputEvent && event.inputEvent.state !== "pending",
			)?.inputEvent,
		).toEqual({
			inputId: "stopped",
			state: "failed",
			detail: "Pi stopped before the held input was sent",
			failure: { reason: "held_and_stopped" },
		});
		await instance.shutdown();
	});

	it("shows Pi's own redacted reason when it rejects a prompt", async () => {
		const reason =
			"Cannot submit a prompt while compaction is in progress. token=hunter2secret";
		const { fake, instance, events } = await launch({
			rpcResponses: { prompt: { success: false, error: reason } },
		});
		const sending = instance.send(input("q", "rejected"));
		await expect(sending).rejects.toBeInstanceOf(InputNotDeliveredError);
		await expect(sending).rejects.toThrow(
			"Pi rejected the prompt: Cannot submit a prompt while compaction is in progress. token=[REDACTED]",
		);
		expect(
			events.find((event) => event.inputEvent?.state === "failed")?.inputEvent,
		).toMatchObject({
			detail:
				"Pi rejected the prompt: Cannot submit a prompt while compaction is in progress. token=[REDACTED]",
			failure: {
				reason: "prompt_rejected",
				text: "Cannot submit a prompt while compaction is in progress. token=[REDACTED]",
			},
		});
		await sending.catch((error: InputNotDeliveredError) =>
			expect(error.failure).toEqual({
				reason: "prompt_rejected",
				text: "Cannot submit a prompt while compaction is in progress. token=[REDACTED]",
			}),
		);
		expect(anomalies(events)).toEqual([
			expect.objectContaining({
				kind: "prompt_rejected",
				action: "failed_input",
				detail:
					"Cannot submit a prompt while compaction is in progress. token=[REDACTED]",
			}),
		]);
		expect(JSON.stringify(events)).not.toContain("hunter2secret");
		await stillRunning(fake);
		await instance.shutdown();
	});

	it("does not hold prompts during automatic compaction", async () => {
		const { fake, instance } = await launch();
		fake.stdout.write(
			'{"type":"compaction_start","reason":"threshold"}\n{"type":"auto_compaction_start"}\n',
		);
		await tick();
		await instance.send(input("during auto", "auto"));
		expect(fake.commands.find((item) => item.type === "prompt")).toMatchObject({
			message: "during auto",
		});
		await instance.shutdown();
	});

	it("ends a manual compaction hold on an oversized compaction_end", async () => {
		const { fake, instance, events } = await launch(
			{ promptDisposition: "handled" },
			4096,
		);
		fake.stdout.write('{"type":"compaction_start","reason":"manual"}\n');
		await tick();
		const sending = instance.send(input("after big summary", "big-end"));
		await tick();
		fake.stdout.write(
			`${JSON.stringify({
				type: "compaction_end",
				reason: "manual",
				result: { summary: "s".repeat(20_000) },
				aborted: false,
			})}\n`,
		);
		await expect(sending).resolves.toBeUndefined();
		expect(anomalies(events).at(-1)).toMatchObject({
			kind: "oversized_record",
			action: "handled",
			recordType: "compaction_end",
		});
		// Reload is no longer blocked by a stale compaction flag.
		await expect(instance.control?.reload?.()).resolves.toBeUndefined();
		await instance.shutdown();
	});

	it("sends a held prompt after the hold timeout when Pi reports compaction is over", async () => {
		const fake = fakeProvider({
			rpcResponses: {
				get_state: {
					data: { sessionId: "native-exact", isCompacting: false },
				},
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 200,
			compactionHoldTimeoutMs: 20,
		}).launch(request);
		fake.stdout.write('{"type":"compaction_start","reason":"manual"}\n');
		await tick();
		await expect(
			instance.send(input("lost end", "lost")),
		).resolves.toBeUndefined();
		expect(fake.commands.find((item) => item.type === "prompt")).toMatchObject({
			message: "lost end",
		});
		await instance.shutdown();
	});

	it.each(["exact", "current"] as const)(
		"cancels a held prompt (%s cancel) without sending it",
		async (how) => {
			const { fake, instance, events } = await launch();
			fake.stdout.write('{"type":"compaction_start","reason":"manual"}\n');
			await tick();
			const sending = instance.send(input("never sent", "held-cancel"));
			await tick();
			if (how === "exact") await instance.cancel("held-cancel" as InputId);
			else await instance.cancelCurrent?.();
			await expect(sending).rejects.toBeInstanceOf(InputNotDeliveredError);
			fake.stdout.write('{"type":"compaction_end","reason":"manual"}\n');
			await tick();
			expect(fake.commands.some((item) => item.type === "prompt")).toBe(false);
			expect(
				events.filter((event) => event.inputEvent).map((e) => e.inputEvent),
			).toEqual([
				{ inputId: "held-cancel", state: "pending" },
				{
					inputId: "held-cancel",
					state: "failed",
					detail: "Input canceled",
					failure: { reason: "canceled" },
				},
			]);
			await instance.shutdown();
		},
	);

	describe("compaction recheck window", () => {
		async function inRecheck() {
			const fake = fakeProvider({ exitOnTerm: false, holdLaterGetState: true });
			const instance = await new PiRpcHarnessAdapter(fake.provider, {
				executable: "pi",
				startupTimeoutMs: 200,
				shutdownTimeoutMs: 20,
				exitDrainTimeoutMs: 100,
				compactionHoldTimeoutMs: 20,
			}).launch(request);
			const events: HarnessEvent[] = [];
			void (async () => {
				for await (const event of instance.events) events.push(event);
			})();
			fake.stdout.write('{"type":"compaction_start","reason":"manual"}\n');
			await tick();
			const sending = instance.send(input("held", "recheck"));
			sending.catch(() => {});
			// The hold timed out and the get_state recheck is outstanding.
			await vi.waitFor(() =>
				expect(
					fake.commands.filter((item) => item.type === "get_state"),
				).toHaveLength(2),
			);
			const inputs = () =>
				events.filter((event) => event.inputEvent).map((e) => e.inputEvent);
			return { fake, instance, sending, inputs };
		}

		it.each(["exact", "current"] as const)(
			"cancels the held prompt (%s cancel) while Pi's state is rechecked",
			async (how) => {
				const { fake, instance, sending, inputs } = await inRecheck();
				if (how === "exact") await instance.cancel("recheck" as InputId);
				else await instance.cancelCurrent?.();
				// Even if Pi then reports that compaction is over, the input stays canceled.
				const recheck = fake.commands.at(-1) as { id: string };
				fake.stdout.write(
					`${JSON.stringify({
						type: "response",
						id: recheck.id,
						command: "get_state",
						success: true,
						data: { sessionId: "native-exact", isCompacting: false },
					})}\n`,
				);
				await expect(sending).rejects.toMatchObject({
					failure: { reason: "canceled" },
				});
				expect(fake.commands.some((item) => item.type === "prompt")).toBe(
					false,
				);
				expect(inputs()).toEqual([
					{ inputId: "recheck", state: "pending" },
					{
						inputId: "recheck",
						state: "failed",
						detail: "Input canceled",
						failure: { reason: "canceled" },
					},
				]);
				await instance.shutdown();
			},
		);

		it("reports a Pi stop during the recheck as not delivered, not uncertain", async () => {
			const { fake, instance, sending, inputs } = await inRecheck();
			await fake.child.sendSignal("SIGTERM");
			await expect(sending).rejects.toBeInstanceOf(InputNotDeliveredError);
			await expect(sending).rejects.toMatchObject({
				failure: { reason: "held_and_stopped" },
			});
			expect(inputs()).toEqual([
				{ inputId: "recheck", state: "pending" },
				{
					inputId: "recheck",
					state: "failed",
					detail: "Pi stopped before the held input was sent",
					failure: { reason: "held_and_stopped" },
				},
			]);
			await instance.shutdown();
		});
	});

	it("does not settle a held prompt when a run settles during the hold", async () => {
		const { fake, instance, events } = await launch({
			promptDisposition: "started",
		});
		fake.stdout.write('{"type":"compaction_start","reason":"manual"}\n');
		await tick();
		const sending = instance.send(input("held", "held-settle"));
		await tick();
		fake.stdout.write('{"type":"agent_settled"}\n');
		await tick();
		fake.stdout.write('{"type":"compaction_end","reason":"manual"}\n');
		await expect(sending).resolves.toBeUndefined();
		const states = () =>
			events
				.filter((event) => event.inputEvent?.inputId === "held-settle")
				.map((event) => event.inputEvent?.state);
		await vi.waitFor(() => expect(states()).toEqual(["pending", "accepted"]));
		fake.stdout.write('{"type":"agent_start"}\n{"type":"agent_settled"}\n');
		await vi.waitFor(() =>
			expect(states()).toEqual(["pending", "accepted", "completed"]),
		);
		await instance.shutdown();
	});

	it("frames records split across chunks inside multi-byte characters and CRLF", async () => {
		const { fake, instance, events } = await launch({}, 4096);
		const small = Buffer.from(
			`${JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "привет 🙂" },
			})}\r\n`,
		);
		const bigBody = JSON.stringify({ type: "mystery", text: "ж".repeat(5000) });
		const big = Buffer.from(`${bigBody}\r\n`);
		const all = Buffer.concat([small, big]);
		// Split inside the emoji, between CR and LF, and inside a Cyrillic letter.
		const cuts = [
			small.indexOf(Buffer.from("🙂")) + 2,
			small.length - 1,
			small.length + 101,
			all.length - 1,
		];
		let from = 0;
		for (const cut of [...cuts, all.length]) {
			fake.stdout.write(all.subarray(from, cut));
			from = cut;
			await tick();
		}
		await vi.waitFor(() => expect(anomalies(events)).toHaveLength(1));
		expect(events.find((event) => event.kind === "output")?.text).toBe(
			"привет 🙂",
		);
		expect(anomalies(events)[0]).toMatchObject({
			kind: "oversized_record",
			recordType: "mystery",
			bytes: Buffer.byteLength(bigBody),
		});
		await stillRunning(fake);
		await instance.shutdown();
	});

	it("always sends prompts with streamingBehavior steer, even when idle", async () => {
		const { fake, instance } = await launch();
		await instance.send(input("idle", "idle"));
		expect(fake.commands.find((item) => item.type === "prompt")).toMatchObject({
			streamingBehavior: "steer",
		});
		await instance.shutdown();
	});

	it("ignores set_editor_text extension UI requests silently", async () => {
		const { fake, instance, events } = await launch();
		fake.stdout.write(
			`${JSON.stringify({ type: "extension_ui_request", id: "e1", method: "set_editor_text", text: "draft" })}\n{"type":"agent_start"}\n`,
		);
		await vi.waitFor(() => expect(statuses(events)).toContain("agent_start"));
		expect(events).toHaveLength(1);
		await instance.shutdown();
	});
});
