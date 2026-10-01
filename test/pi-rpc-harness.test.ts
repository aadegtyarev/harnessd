import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ManagedProcess,
	ProcessLaunchRequest,
	ProcessProvider,
} from "../src/core/ports.js";
import type {
	AdapterId,
	HarnessEvent,
	Input,
	InputId,
	ProcessId,
	SessionId,
} from "../src/core/types.js";
import {
	PiRpcHarnessAdapter,
	UncertainInputDeliveryError,
} from "../src/harness/index.js";

interface FakeOptions {
	readonly holdPrompt?: boolean;
	readonly holdGetState?: boolean;
	readonly holdAbort?: boolean;
	readonly malformedPromptAck?: boolean;
	readonly exitOnPrompt?: boolean;
	readonly exitBeforePromptResponse?: boolean;
	readonly exitBeforeAbortResponse?: boolean;
	readonly sessionId?: string;
	readonly promptSuccess?: boolean;
	readonly promptDisposition?: string;
	readonly abortSuccess?: boolean;
	readonly exitOnTerm?: boolean;
	readonly missingStream?: "stdin" | "stdout" | "stderr";
	readonly beforeResponse?: (
		command: Record<string, unknown>,
		stdout: PassThrough,
	) => void;
}
const children: ManagedProcess[] = [];
afterEach(async () => {
	await Promise.all(
		children.splice(0).map(async (child) => {
			child.stdin?.end();
			const exited = child.exit.then(
				() => true,
				() => true,
			);
			try {
				await Promise.race([
					exited,
					new Promise((resolve) => setTimeout(resolve, 50)),
				]);
				if (
					await Promise.race([
						exited,
						new Promise<boolean>((resolve) =>
							setTimeout(() => resolve(false), 1),
						),
					])
				)
					return;
			} catch {
				return;
			}
			try {
				await child.sendSignal("SIGKILL");
			} catch {
				/* already exited */
			}
		}),
	);
});

function fakeProvider(options: FakeOptions = {}) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let finish!: (value: { code: number | null; signal: string | null }) => void;
	let exited = false;
	const exit = new Promise<{ code: number | null; signal: string | null }>(
		(resolve) => {
			finish = resolve;
		},
	);
	const commands: Record<string, unknown>[] = [];
	const signals: string[] = [];
	let launchRequest: ProcessLaunchRequest | undefined;
	let text = "";
	stdin.setEncoding("utf8");
	const complete = (
		code: number | null,
		signal: string | null,
		closeStreams = true,
	) => {
		if (!exited) {
			exited = true;
			finish({ code, signal });
			if (closeStreams) {
				stdout.end();
				stderr.end();
			}
		}
	};
	stdin.on("data", (chunk: string) => {
		text += chunk;
		for (;;) {
			const index = text.indexOf("\n");
			if (index < 0) break;
			const command = JSON.parse(text.slice(0, index)) as Record<
				string,
				unknown
			>;
			text = text.slice(index + 1);
			commands.push(command);
			if (command.type === "extension_ui_response") continue;
			if (command.type === "get_state" && options.holdGetState) continue;
			if (command.type === "prompt" && options.exitOnPrompt) {
				complete(1, null);
				continue;
			}
			if (options.beforeResponse) {
				options.beforeResponse(command, stdout);
			}
			if (command.type === "prompt" && options.malformedPromptAck) {
				stdout.write(
					`${JSON.stringify({
						type: "response",
						id: command.id,
						command: "prompt",
						success: "yes",
					})}\n`,
				);
			}
			if (command.type === "abort" && options.holdAbort) continue;
			if (command.type === "prompt" && options.exitBeforePromptResponse) {
				complete(0, null, false);
				setImmediate(() => {
					stdout.write(
						`${JSON.stringify({
							type: "response",
							id: command.id,
							command: "prompt",
							success: true,
							data: { disposition: "started" },
						})}\r\n{"type":"agent_settled"}\r\n`,
					);
					stdout.end();
					stderr.end();
				});
				continue;
			}
			if (command.type === "abort" && options.exitBeforeAbortResponse) {
				complete(0, null, false);
				setImmediate(() => {
					stdout.write(
						`{"type":"agent_settled"}\r\n${JSON.stringify({
							type: "response",
							id: command.id,
							command: "abort",
							success: options.abortSuccess ?? true,
						})}\r\n`,
					);
					stdout.end();
					stderr.end();
				});
				continue;
			}
			if (command.type === "prompt" && options.holdPrompt) continue;
			const response =
				command.type === "get_state"
					? {
							type: "response",
							id: command.id,
							command: command.type,
							success: true,
							data: { sessionId: options.sessionId ?? "native-exact" },
						}
					: {
							type: "response",
							id: command.id,
							command: command.type,
							success:
								command.type === "prompt"
									? (options.promptSuccess ?? true)
									: command.type === "abort"
										? (options.abortSuccess ?? true)
										: true,
							...(command.type === "prompt" && options.promptDisposition
								? { data: { disposition: options.promptDisposition } }
								: {}),
						};
			stdout.write(`${JSON.stringify(response)}\r\n`);
		}
	});
	stdin.on("end", () => {
		if (options.exitOnTerm !== false) complete(0, null);
	});
	const managed: ManagedProcess = {
		id: `fake-${children.length}` as ProcessId,
		stdin: options.missingStream === "stdin" ? null : stdin,
		stdout: options.missingStream === "stdout" ? null : stdout,
		stderr: options.missingStream === "stderr" ? null : stderr,
		exit,
		async sendSignal(signal) {
			signals.push(signal);
			complete(null, signal);
		},
	};
	children.push(managed);
	const provider: ProcessProvider = {
		descriptor: {
			id: "fake" as AdapterId,
			capabilities: ["process.launch", "process.signal"],
		},
		async launch(request) {
			launchRequest = request;
			return managed;
		},
	};
	return {
		provider,
		commands,
		signals,
		stdout,
		stderr,
		child: managed,
		get launchRequest() {
			return launchRequest;
		},
	};
}
const input = (text: string, id: string): Input => ({
	id: id as InputId,
	sessionId: "supervisor" as SessionId,
	text,
	createdAt: new Date(),
});
async function collectEvents(
	instance: Awaited<ReturnType<PiRpcHarnessAdapter["launch"]>>,
	count: number,
) {
	const iterator = instance.events[Symbol.asyncIterator]();
	const result = [];
	for (let i = 0; i < count; i++) result.push((await iterator.next()).value);
	return result;
}
const request = { sessionId: "supervisor" as SessionId, cwd: "/a cwd" };

describe("PiRpcHarnessAdapter", () => {
	it("declares the core capabilities and launches configured replacement process values", async () => {
		const fake = fakeProvider();
		const options = {
			executable: "/bin/pi",
			args: ["--model", "model name"],
			env: { ONLY: "replacement" },
			startupTimeoutMs: 100,
		};
		const instance = await new PiRpcHarnessAdapter(
			fake.provider,
			options,
		).launch(request);
		expect(
			new PiRpcHarnessAdapter(fake.provider, options).descriptor.capabilities,
		).toEqual([
			"harness.launch",
			"harness.stop",
			"harness.resume",
			"harness.cancel",
			"input.submit",
		]);
		expect(fake.launchRequest).toMatchObject({
			executable: options.executable,
			args: ["--model", "model name", "--mode", "rpc"],
			cwd: request.cwd,
			env: options.env,
			stdio: "pipe",
		});
		expect(instance.nativeSessionId).toBe("native-exact");
		await instance.shutdown();
	});

	it("does not report an expected process exit during shutdown as an error", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.shutdown();
		const seen: HarnessEvent[] = [];
		for await (const event of instance.events) seen.push(event);
		expect(seen.some((event) => event.kind === "error")).toBe(false);
	});

	it("treats a handled prompt as immediately complete", async () => {
		const fake = fakeProvider({ promptDisposition: "handled" });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("/extension-command", "handled"));
		await expect(
			instance.send(input("next explicit input", "next")),
		).resolves.toBeUndefined();
		const events = await collectEvents(instance, 6);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual([
			"pending",
			"accepted",
			"completed",
			"pending",
			"accepted",
			"completed",
		]);
		await instance.shutdown();
	});

	it.each(["--no-session", "--continue", "-c", "--resume", "-r", "--fork"])(
		"rejects conflicting option %s",
		async (flag) => {
			const fake = fakeProvider();
			await expect(
				new PiRpcHarnessAdapter(fake.provider, {
					executable: "pi",
					args: [flag],
				}).launch(request),
			).rejects.toThrow("controlled by the adapter");
		},
	);

	it("resumes a matching native session with the exact --session argument", async () => {
		const fake = fakeProvider({ sessionId: "saved-id" });
		const adapter = new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		});
		const instance = await adapter.resume({
			...request,
			nativeSessionId: "saved-id",
		});
		expect(instance.nativeSessionId).toBe("saved-id");
		expect(fake.launchRequest?.args).toEqual([
			"--mode",
			"rpc",
			"--session",
			"saved-id",
		]);
		await instance.shutdown();
	});

	it("uses --session and rejects a resume whose returned session differs", async () => {
		const fake = fakeProvider({ sessionId: "other-session" });
		const adapter = new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			shutdownTimeoutMs: 5,
		});
		await expect(
			adapter.resume({ ...request, nativeSessionId: "saved/native" }),
		).rejects.toThrow("different native session");
		expect(fake.launchRequest?.args).toContain("--session");
		expect(fake.launchRequest?.args).toContain("saved/native");
		expect(fake.launchRequest?.args).not.toContain("--session-id");
	});

	it("rejects launch when the readiness response times out", async () => {
		const fake = fakeProvider({ holdGetState: true });
		await expect(
			new PiRpcHarnessAdapter(fake.provider, {
				executable: "pi",
				startupTimeoutMs: 5,
				commandTimeoutMs: 100,
				shutdownTimeoutMs: 5,
			}).launch(request),
		).rejects.toThrow("startup timed out");
		expect(fake.child.stdin?.writableEnded).toBe(true);
	});

	it("parses fragmented CRLF JSONL without splitting Unicode separators and completes settled prompts", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		const sent = instance.send(input("prompt paragraph separator", "i1"));
		await sent;
		const delta = "hi😀\u2028there\u2029end";
		const frame = Buffer.from(
			`${JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta },
			})}\r\n`,
		);
		const split = frame.indexOf(Buffer.from("😀")) + 1;
		fake.stdout.write(frame.subarray(0, split));
		fake.stdout.write(frame.subarray(split));
		fake.stdout.write(Buffer.from('{"type":"agent_settled"}\r\n'));
		const got = await collectEvents(instance, 5);
		expect(
			got
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual(["pending", "accepted", "completed"]);
		expect(got.some((event) => event?.text === delta)).toBe(true);
		await instance.shutdown();
	});

	it("handles agent_settled before prompt acknowledgement", async () => {
		let sentSettled = false;
		const fake = fakeProvider({
			beforeResponse(command, stdout) {
				if (command.type === "prompt" && !sentSettled) {
					sentSettled = true;
					stdout.write('{"type":"agent_settled"}\n');
				}
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("fast", "fast"));
		const events = await collectEvents(instance, 4);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual(["pending", "accepted", "completed"]);
		await instance.shutdown();
	});

	it("rejects prompt definitively and cancels dialog requests without exposing secrets", async () => {
		const fake = fakeProvider({ promptSuccess: false });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		const sending = instance.send(input("DO NOT LEAK", "reject"));
		await expect(sending).rejects.toThrow("rejected");
		fake.stdout.write(
			'{"type":"extension_ui_request","id":"dialog-1","method":"confirm"}\n',
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fake.commands.at(-1)).toMatchObject({
			type: "extension_ui_response",
			id: "dialog-1",
			cancelled: true,
		});
		fake.stderr.write("PRIVATE STDERR");
		const events = await collectEvents(instance, 3);
		expect(events.some((event) => event?.text?.includes("DO NOT LEAK"))).toBe(
			false,
		);
		expect(
			events.some((event) => event?.text?.includes("PRIVATE STDERR")),
		).toBe(false);
		await instance.shutdown();
	});

	it("excludes parallel inputs, aborts active work, and reports uncertain after written response loss", async () => {
		const fake = fakeProvider({ holdPrompt: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 15,
		}).launch(request);
		const sending = instance.send(input("private prompt", "one"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(instance.send(input("second", "two"))).rejects.toThrow(
			"already active",
		);
		await expect(sending).rejects.toBeInstanceOf(UncertainInputDeliveryError);
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		const events = await collectEvents(instance, 2);
		expect(
			events.some((event) => event?.inputEvent?.state === "uncertain"),
		).toBe(true);
		await expect(
			instance.send(input("new explicit input", "blocked-after-uncertain")),
		).rejects.toThrow("already active");
		fake.stdout.write('{"type":"agent_settled"}\n');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await instance.shutdown();
	});

	it("aborts an acknowledged active input as failed with cancellation detail", async () => {
		const fake = fakeProvider({
			beforeResponse(command, stdout) {
				if (command.type === "abort")
					stdout.write('{"type":"agent_settled"}\n');
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("cancel", "cancel"));
		await instance.cancel("cancel" as InputId);
		const states = (await collectEvents(instance, 4))
			.filter((event) => event?.inputEvent)
			.map((event) => event?.inputEvent);
		expect(states.map((event) => event?.state)).toEqual([
			"pending",
			"accepted",
			"failed",
		]);
		expect(states.at(-1)?.detail).toBe("Input canceled");
		await instance.shutdown();
	});

	it("rejects overlapping cancellation and binds abort replies to their input", async () => {
		const fake = fakeProvider({ holdAbort: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("first", "cancel-owner-a"));
		const firstCancel = instance.cancel("cancel-owner-a" as InputId);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const abortCommands = () =>
			fake.commands.filter((command) => command.type === "abort");
		const firstAbort = abortCommands()[0];
		if (!firstAbort || typeof firstAbort.id !== "string")
			throw new Error("first abort command was not sent");
		await expect(instance.cancel("cancel-owner-a" as InputId)).rejects.toThrow(
			"already in progress",
		);
		expect(abortCommands()).toHaveLength(1);
		fake.stdout.write(
			`${JSON.stringify({
				type: "response",
				id: firstAbort.id,
				command: "abort",
				success: true,
			})}\n`,
		);
		await expect(firstCancel).resolves.toBeUndefined();

		await instance.send(input("second", "cancel-owner-b"));
		const secondCancel = instance.cancel("cancel-owner-b" as InputId);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const secondAbort = abortCommands()[1];
		if (!secondAbort || typeof secondAbort.id !== "string")
			throw new Error("second abort command was not sent");
		fake.stdout.write(
			`${JSON.stringify({
				type: "response",
				id: firstAbort.id,
				command: "abort",
				success: true,
			})}\n`,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await expect(
			instance.send(input("blocked", "during-cancel-b")),
		).rejects.toThrow("already active");
		fake.stdout.write(
			`{"type":"agent_settled"}\n${JSON.stringify({
				type: "response",
				id: secondAbort.id,
				command: "abort",
				success: true,
			})}\n`,
		);
		await expect(secondCancel).resolves.toBeUndefined();

		const events = await collectEvents(instance, 7);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual([
			"pending",
			"accepted",
			"failed",
			"pending",
			"accepted",
			"failed",
		]);
		await instance.shutdown();
	});

	it("completes settled work when Pi rejects abort after settlement", async () => {
		const fake = fakeProvider({
			abortSuccess: false,
			beforeResponse(command, stdout) {
				if (command.type === "abort")
					stdout.write('{"type":"agent_settled"}\n');
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("still active", "abort-rejected"));
		await expect(instance.cancel("abort-rejected" as InputId)).rejects.toThrow(
			"rejected the abort",
		);
		await expect(
			instance.send(input("second", "after-settlement")),
		).resolves.toBeUndefined();
		fake.stdout.write('{"type":"agent_settled"}\n');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await instance.shutdown();
	});

	it("reports uncertain cancellation when the abort response is lost after settlement", async () => {
		const fake = fakeProvider({
			holdAbort: true,
			beforeResponse(command, stdout) {
				if (command.type === "abort")
					stdout.write('{"type":"agent_settled"}\n');
			},
		});
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			commandTimeoutMs: 10,
		}).launch(request);
		await instance.send(input("cancel uncertainty", "abort-uncertain"));
		await expect(instance.cancel("abort-uncertain" as InputId)).rejects.toThrow(
			"timed out",
		);
		const events = await collectEvents(instance, 4);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual(["pending", "accepted", "uncertain"]);
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it("throws typed uncertainty if the child exits before the prompt response", async () => {
		const fake = fakeProvider({ exitOnPrompt: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await expect(
			instance.send(input("written then lost", "exit-before-ack")),
		).rejects.toBeInstanceOf(UncertainInputDeliveryError);
		expect(
			fake.commands.filter((command) => command.type === "prompt"),
		).toHaveLength(1);
		await instance.shutdown();
	});

	it("drains final correlated response and events after child exit", async () => {
		const fake = fakeProvider({ exitBeforePromptResponse: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			exitDrainTimeoutMs: 100,
		}).launch(request);
		await expect(
			instance.send(input("final output", "final")),
		).resolves.toBeUndefined();
		const events = await collectEvents(instance, 4);
		expect(
			events
				.filter((event) => event?.inputEvent)
				.map((event) => event?.inputEvent?.state),
		).toEqual(["pending", "accepted", "completed"]);
		await instance.shutdown();
	});

	it("applies final abort acknowledgement and settlement before EOF after exit", async () => {
		const fake = fakeProvider({ exitBeforeAbortResponse: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			exitDrainTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("abort final", "abort-final"));
		await expect(
			instance.cancel("abort-final" as InputId),
		).resolves.toBeUndefined();
		const events = await collectEvents(instance, 5);
		const deliveries = events
			.filter((event) => event?.inputEvent)
			.map((event) => event?.inputEvent);
		expect(deliveries.map((event) => event?.state)).toEqual([
			"pending",
			"accepted",
			"failed",
		]);
		expect(deliveries.at(-1)?.detail).toBe("Input canceled");
		await instance.shutdown();
	});

	it("marks active accepted input uncertain on child exit", async () => {
		const fake = fakeProvider();
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
		}).launch(request);
		await instance.send(input("active", "exit"));
		await fake.child.sendSignal("SIGTERM");
		const events = await collectEvents(instance, 4);
		expect(
			events.some((event) => event?.inputEvent?.state === "uncertain"),
		).toBe(true);
		await instance.shutdown();
	});

	it("treats malformed correlated prompt acknowledgements as protocol uncertainty", async () => {
		const fake = fakeProvider({ malformedPromptAck: true });
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			shutdownTimeoutMs: 5,
		}).launch(request);
		await expect(
			instance.send(input("untrusted ack", "malformed-ack")),
		).rejects.toBeInstanceOf(UncertainInputDeliveryError);
		const events = await collectEvents(instance, 3);
		expect(
			events.some((event) => event?.inputEvent?.state === "uncertain"),
		).toBe(true);
		expect(events.some((event) => event?.inputEvent?.state === "failed")).toBe(
			false,
		);
		await instance.shutdown();
	});

	it.each(["bad-json", "oversized"] as const)(
		"fails and cleans up %s stdout",
		async (kind) => {
			const fake = fakeProvider({ exitOnTerm: false });
			const instance = await new PiRpcHarnessAdapter(fake.provider, {
				executable: "pi",
				startupTimeoutMs: 100,
				shutdownTimeoutMs: 5,
				maxRecordBytes: 150,
			}).launch(request);
			fake.stdout.write(
				kind === "bad-json"
					? "{bad}\n"
					: `{"type":"agent_start"}\n${"x".repeat(200)}`,
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fake.signals).toContain("SIGTERM");
			await instance.shutdown();
		},
	);

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		"rejects invalid command timeout %s",
		(value) => {
			expect(
				() =>
					new PiRpcHarnessAdapter(fakeProvider().provider, {
						executable: "pi",
						commandTimeoutMs: value,
					}),
			).toThrow("from 1 to");
		},
	);

	it("rejects record caps above the documented bound", () => {
		expect(
			() =>
				new PiRpcHarnessAdapter(fakeProvider().provider, {
					executable: "pi",
					maxRecordBytes: 64 * 1024 * 1024 + 1,
				}),
		).toThrow("maxRecordBytes");
	});

	it.each(["stdin", "stdout", "stderr"] as const)(
		"terminates process if %s pipe is unavailable",
		async (missingStream) => {
			const fake = fakeProvider({ missingStream });
			await expect(
				new PiRpcHarnessAdapter(fake.provider, {
					executable: "pi",
					shutdownTimeoutMs: 5,
				}).launch(request),
			).rejects.toThrow("requires");
		},
	);

	it("escalates TERM to KILL on bounded shutdown", async () => {
		const fake = fakeProvider({ exitOnTerm: false });
		const signals: string[] = [];
		const original = fake.child.sendSignal.bind(fake.child);
		fake.child.sendSignal = async (signal) => {
			signals.push(signal);
			if (signal === "SIGKILL") await original(signal);
		};
		const instance = await new PiRpcHarnessAdapter(fake.provider, {
			executable: "pi",
			startupTimeoutMs: 100,
			shutdownTimeoutMs: 5,
		}).launch(request);
		await instance.shutdown();
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
