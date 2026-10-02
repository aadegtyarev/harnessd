import { describe, expect, it, vi } from "vitest";
import { HELP, main } from "../src/cli.js";

function transportOptions(options: unknown): {
	signal: AbortSignal;
	token: string;
	onFatal: () => void;
} {
	const transport = (options as { transports: readonly unknown[] })
		.transports[0] as {
		options: { signal: AbortSignal; token: string; onFatal: () => void };
	};
	return transport.options;
}

describe("CLI", () => {
	it("shows help without requiring configuration", async () => {
		const write = vi.fn();
		await main({ argv: ["--help"], env: {}, write });
		expect(write).toHaveBeenCalledWith(HELP);
	});

	it("validates required environment without exposing credentials", async () => {
		await expect(
			main({ argv: [], env: { HARNESSD_TELEGRAM_BOT_TOKEN: "secret" } }),
		).rejects.toThrow("HARNESSD_TELEGRAM_ALLOWED_USER_IDS");
		await expect(
			main({
				argv: [],
				env: {
					HARNESSD_TELEGRAM_BOT_TOKEN: "secret",
					HARNESSD_TELEGRAM_ALLOWED_USER_IDS: "0,not-a-number",
				},
			}),
		).rejects.toThrow("HARNESSD_TELEGRAM_ALLOWED_USER_IDS");
	});

	it.each(["SIGINT", "SIGTERM"] as const)(
		"composes one runtime and shuts it down on %s",
		async (signal) => {
			const close = vi.fn(async () => {});
			let runtimeOptions: unknown;
			const runtimeStart = vi.fn(async (options: unknown) => {
				runtimeOptions = options;
				return { close } as never;
			});
			const running = main({
				argv: [],
				env: {
					HARNESSD_TELEGRAM_BOT_TOKEN: "secret-token",
					HARNESSD_TELEGRAM_ALLOWED_USER_IDS: "42,43",
					HARNESSD_PI_EXECUTABLE: "custom-pi",
					HARNESSD_STATE_DIR: "/tmp/harnessd-cli-test",
				},
				cwd: "/work",
				runtimeStart: runtimeStart as never,
			});
			await vi.waitFor(() => expect(runtimeStart).toHaveBeenCalledOnce());
			setTimeout(() => process.emit(signal), 5);
			await running;
			expect(runtimeOptions).toMatchObject({
				piExecutable: "custom-pi",
				stateDirectory: "/tmp/harnessd-cli-test",
				transports: [
					{ descriptor: { id: "telegram", capabilities: ["transport.poll"] } },
				],
			});
			expect(runtimeOptions).not.toHaveProperty("piOptions");
			expect(transportOptions(runtimeOptions).token).toBe("secret-token");
			expect(
				JSON.stringify({
					piExecutable: (runtimeOptions as { piExecutable: string })
						.piExecutable,
					piOptions: (runtimeOptions as { piOptions?: unknown }).piOptions,
				}),
			).not.toContain("secret-token");
			expect(close).toHaveBeenCalledOnce();
		},
	);

	it("shuts down the ready runtime on fatal polling failure with a safe diagnostic", async () => {
		let runtimeOptions: unknown;
		let transport: { stop(): Promise<void> } | undefined;
		const close = vi.fn(async () => {
			await transport?.stop();
		});
		const writeError = vi.fn();
		const runtimeStart = vi.fn(async (options: unknown) => {
			runtimeOptions = options;
			transport = (
				options as { transports: readonly { stop(): Promise<void> }[] }
			).transports[0];
			return { close } as never;
		});
		const running = main({
			argv: [],
			env: {
				HARNESSD_TELEGRAM_BOT_TOKEN: "secret-token",
				HARNESSD_TELEGRAM_ALLOWED_USER_IDS: "42",
			},
			runtimeStart: runtimeStart as never,
			writeError,
		});
		await vi.waitFor(() => expect(runtimeStart).toHaveBeenCalledOnce());
		transportOptions(runtimeOptions).onFatal();
		await running;
		expect(close).toHaveBeenCalledOnce();
		expect(writeError).toHaveBeenCalledWith(
			"Telegram polling failed; harnessd is shutting down.\n",
		);
	});

	it("aborts runtime startup when a signal arrives before readiness", async () => {
		let observedSignal!: AbortSignal;
		const runtimeStart = vi.fn((options: unknown) => {
			observedSignal = transportOptions(options).signal;
			return new Promise<never>((_resolve, reject) => {
				observedSignal.addEventListener(
					"abort",
					() => reject(new Error("startup aborted")),
					{ once: true },
				);
			});
		});
		const running = main({
			argv: [],
			env: {
				HARNESSD_TELEGRAM_BOT_TOKEN: "secret-token",
				HARNESSD_TELEGRAM_ALLOWED_USER_IDS: "42",
			},
			runtimeStart: runtimeStart as never,
		});
		await vi.waitFor(() => expect(observedSignal).toBeDefined());
		process.emit("SIGINT");
		await running;
		expect(observedSignal.aborted).toBe(true);
	});
});
