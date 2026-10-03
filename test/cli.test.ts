import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { HELP, isDirectInvocation, main } from "../src/cli.js";

const EMPTY_CWD = path.join(os.tmpdir(), `harnessd-cli-${randomUUID()}`);

function runMain(options: Parameters<typeof main>[0] = {}): Promise<void> {
	return main({ cwd: EMPTY_CWD, ...options });
}

function transportOptions(options: unknown): {
	signal: AbortSignal;
	token: string;
	defaultCwd: string;
	onFatal: () => void;
} {
	const transport = (options as { transports: readonly unknown[] })
		.transports[0] as {
		options: {
			signal: AbortSignal;
			token: string;
			defaultCwd: string;
			onFatal: () => void;
		};
	};
	return transport.options;
}

describe("CLI", () => {
	it("shows trusted direct and isolated availability in help", async () => {
		const write = vi.fn();
		await runMain({ argv: ["--help"], env: {}, write });
		expect(write).toHaveBeenCalledWith(HELP);
		expect(HELP).toContain("HARNESSD_EXECUTION_MODE");
		expect(HELP).toContain("direct (default, trusted; cwd is not a sandbox)");
		expect(HELP).toContain("isolated (unavailable in this CLI");
		expect(HELP).toContain("HARNESSD_DEFAULT_CWD");
		expect(HELP).toContain("harnessd service install");
		expect(HELP).toContain("/resume [sessionId]");
	});

	it("recognizes direct invocation through an npm-style symlink", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "harnessd-cli-bin-"));
		const entryPath = path.join(cwd, "dist", "cli.js");
		const binPath = path.join(cwd, "node_modules", ".bin", "harnessd");
		await mkdir(path.dirname(binPath), { recursive: true });
		await mkdir(path.dirname(entryPath), { recursive: true });
		await writeFile(entryPath, "");
		await symlink(entryPath, binPath);
		try {
			expect(isDirectInvocation(pathToFileURL(entryPath).href, binPath)).toBe(
				true,
			);
			expect(isDirectInvocation(pathToFileURL(entryPath).href, undefined)).toBe(
				false,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("prints help through both direct and npm-style symlink invocations", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "harnessd-cli-smoke-"));
		try {
			const root = process.cwd();
			const outputDir = path.join(cwd, "dist");
			const compiledCli = path.join(outputDir, "src", "cli.js");
			const binDir = path.join(cwd, "consumer", "node_modules", ".bin");
			const binPath = path.join(binDir, "harnessd");
			await mkdir(binDir, { recursive: true });
			await writeFile(path.join(cwd, "package.json"), '{"type":"module"}');
			await symlink(
				path.join(root, "node_modules"),
				path.join(cwd, "node_modules"),
				"dir",
			);
			const compile = spawnSync(
				process.execPath,
				[
					path.join(root, "node_modules", "typescript", "bin", "tsc"),
					"--target",
					"ES2023",
					"--module",
					"NodeNext",
					"--moduleResolution",
					"NodeNext",
					"--rootDir",
					".",
					"--outDir",
					outputDir,
					"--strict",
					"--esModuleInterop",
					"--skipLibCheck",
					"src/cli.ts",
				],
				{ cwd: root, encoding: "utf8" },
			);
			expect(compile.status, compile.stderr).toBe(0);
			await chmod(compiledCli, 0o755);
			await symlink(compiledCli, binPath);
			const nodeHelp = spawnSync(process.execPath, [compiledCli, "--help"], {
				cwd,
				encoding: "utf8",
				env: {},
			});
			const symlinkHelp = spawnSync(binPath, ["--help"], {
				cwd,
				encoding: "utf8",
				env: {
					PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(
						path.delimiter,
					),
				},
			});
			for (const result of [nodeHelp, symlinkHelp]) {
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toContain(
					"harnessd - locally supervised Pi sessions",
				);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("loads .env before validating config and uses its default cwd", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "harnessd-cli-env-"));
		const close = vi.fn(async () => {});
		let runtimeOptions: unknown;
		const runtimeStart = vi.fn(async (options: unknown) => {
			runtimeOptions = options;
			return { close } as never;
		});
		await writeFile(
			path.join(cwd, ".env"),
			"HARNESSD_TELEGRAM_BOT_TOKEN=file-token\nHARNESSD_TELEGRAM_ALLOWED_USER_IDS=42\nHARNESSD_DEFAULT_CWD=/workspace\n",
		);
		try {
			const running = runMain({
				argv: [],
				cwd,
				env: { HARNESSD_TELEGRAM_BOT_TOKEN: "shell-token" },
				runtimeStart: runtimeStart as never,
			});
			await vi.waitFor(() => expect(runtimeStart).toHaveBeenCalledOnce());
			expect(transportOptions(runtimeOptions).token).toBe("shell-token");
			expect(transportOptions(runtimeOptions).defaultCwd).toBe("/workspace");
			process.emit("SIGINT");
			await running;
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("dispatches service commands with configuration from the install directory", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "harnessd-service-cli-"));
		await writeFile(
			path.join(cwd, ".env"),
			"HARNESSD_TELEGRAM_BOT_TOKEN=service-token\nHARNESSD_TELEGRAM_ALLOWED_USER_IDS=42\nHOME=/file-home\nXDG_CONFIG_HOME=/file-config\n",
		);
		const serviceManager = vi.fn(async () => {});
		const env: NodeJS.ProcessEnv = {};
		try {
			await runMain({
				argv: ["service", "install"],
				cwd,
				env,
				serviceManager: serviceManager as never,
			});
			expect(serviceManager).toHaveBeenCalledWith(
				"install",
				expect.objectContaining({
					cwd,
					env,
				}),
			);
			expect(env).toEqual({});
			await runMain({
				argv: ["service", "uninstall"],
				cwd,
				env: {},
				serviceManager: serviceManager as never,
			});
			expect(serviceManager).toHaveBeenNthCalledWith(
				2,
				"uninstall",
				expect.anything(),
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("requires Telegram settings in .env before installing a user service", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "harnessd-service-cli-"));
		const serviceManager = vi.fn(async () => {});
		try {
			await expect(
				runMain({
					argv: ["service", "install"],
					cwd,
					env: {
						HARNESSD_TELEGRAM_BOT_TOKEN: "shell-token",
						HARNESSD_TELEGRAM_ALLOWED_USER_IDS: "42",
					},
					serviceManager: serviceManager as never,
				}),
			).rejects.toThrow(
				"HARNESSD_SERVICE_DOTENV_MUST_CONTAIN_TELEGRAM_CONFIGURATION",
			);
			expect(serviceManager).not.toHaveBeenCalled();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it.each([undefined, "direct"] as const)(
		"selects direct execution by default or explicitly (%s)",

		async (mode) => {
			const runtimeStart = vi.fn(
				async () => ({ close: async () => {} }) as never,
			);
			const running = runMain({
				argv: [],
				env: {
					HARNESSD_TELEGRAM_BOT_TOKEN: "token",
					HARNESSD_TELEGRAM_ALLOWED_USER_IDS: "42",
					...(mode ? { HARNESSD_EXECUTION_MODE: mode } : {}),
				},
				runtimeStart: runtimeStart as never,
			});
			await vi.waitFor(() => expect(runtimeStart).toHaveBeenCalledOnce());
			const [runtimeOptions] = runtimeStart.mock.calls[0] as unknown as [
				Record<string, unknown>,
			];
			expect(runtimeOptions.executionMode).toBe("direct");
			process.emit("SIGINT");
			await running;
		},
	);

	it("rejects isolated and invalid mode before transport or runtime startup", async () => {
		const runtimeStart = vi.fn();
		for (const mode of ["isolated", "invalid-secret-value"]) {
			const writeError = vi.fn();
			await expect(
				runMain({
					argv: [],
					env: {
						HARNESSD_TELEGRAM_BOT_TOKEN: "secret-token",
						HARNESSD_TELEGRAM_ALLOWED_USER_IDS: "42",
						HARNESSD_EXECUTION_MODE: mode,
					},
					runtimeStart: runtimeStart as never,
					writeError,
				}),
			).rejects.toMatchObject({
				code:
					mode === "isolated"
						? "ISOLATION_UNAVAILABLE"
						: "INVALID_EXECUTION_MODE",
			});
		}
		expect(runtimeStart).not.toHaveBeenCalled();
	});

	it("validates required environment without exposing credentials", async () => {
		await expect(
			runMain({ argv: [], env: { HARNESSD_TELEGRAM_BOT_TOKEN: "secret" } }),
		).rejects.toThrow("HARNESSD_TELEGRAM_ALLOWED_USER_IDS");
		await expect(
			runMain({
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
			const running = runMain({
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
			expect(transportOptions(runtimeOptions).defaultCwd).toBe("/work");
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
		const running = runMain({
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
		const running = runMain({
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
