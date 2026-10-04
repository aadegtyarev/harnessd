#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	ApplicationRuntime,
	InvalidExecutionModeError,
	IsolationUnavailableError,
} from "./application-runtime.js";
import { getCliCommandUsages } from "./command-catalog.js";
import { resolveStateDirectory } from "./core/session-store.js";
import { loadDotEnv } from "./dotenv.js";
import { describeError } from "./error-diagnostics.js";
import { resolveInitialDirectory } from "./telegram-filesystem.js";
import { TelegramTransportAdapter } from "./telegram-transport.js";
import {
	manageUserService,
	type UserServiceAction,
	type UserServiceOptions,
} from "./user-service.js";

function renderCliUsages(section: "service" | "private-chat"): string {
	return getCliCommandUsages(section)
		.map(({ usage, description }) =>
			description ? `  ${usage.padEnd(34)}${description}` : `  ${usage}`,
		)
		.join("\n");
}

export const HELP = `harnessd - locally supervised Pi sessions over Telegram

Usage:
  harnessd [--help]
  harnessd service install|uninstall

An optional .env in the current directory is loaded before configuration checks;
existing process environment variables take precedence. --help skips config loading.

Required environment:
  HARNESSD_TELEGRAM_BOT_TOKEN       Telegram bot token
  HARNESSD_TELEGRAM_ALLOWED_USER_IDS  Comma-separated positive numeric Telegram user IDs

Optional environment:
  HARNESSD_PI_EXECUTABLE            Pi executable (default: pi)
  HARNESSD_STATE_DIR                Supervisor state directory
  HARNESSD_EXECUTION_MODE           direct (default, trusted; cwd is not a sandbox) or isolated (unavailable in this CLI; requires a registered isolation provider)
  HARNESSD_HOME                     Initial Telegram working folder (default: /; not a sandbox)

Service commands (Linux systemd --user):
${renderCliUsages("service")}

Private-chat commands:
${renderCliUsages("private-chat")}

Paths may be relative to the chat's current folder or absolute. ~ always means the
operating-system user's home; navigation is not restricted to HARNESSD_HOME.
Plain text is submitted to the session selected in that private chat.
`;

export interface CliOptions {
	readonly argv?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly cwd?: string;
	readonly runtimeStart?: typeof ApplicationRuntime.start;
	readonly write?: (text: string) => void;
	readonly writeError?: (text: string) => void;
	readonly serviceManager?: (
		action: UserServiceAction,
		options: UserServiceOptions,
	) => Promise<void>;
}

export async function main(options: CliOptions = {}): Promise<void> {
	const argv = options.argv ?? process.argv.slice(2);
	const write = options.write ?? ((text) => process.stdout.write(text));
	if (argv.includes("--help") || argv.includes("-h")) {
		write(HELP);
		return;
	}
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	if (argv[0] === "service") {
		const action = argv[1];
		if ((action !== "install" && action !== "uninstall") || argv.length !== 2)
			throw new Error("HARNESSD_UNSUPPORTED_SERVICE_COMMAND");
		if (action === "install") {
			const dotenvValues = await loadDotEnv(cwd, {});
			validateServiceDotEnv(dotenvValues);
		}
		const serviceManager = options.serviceManager ?? manageUserService;
		await serviceManager(action, {
			env,
			cwd,
			nodeExecutable: process.execPath,
			cliEntryPoint: fileURLToPath(import.meta.url),
			write,
		});
		return;
	}
	if (argv.length) throw new Error("Unsupported command-line arguments");
	await loadDotEnv(cwd, env);
	const executionMode = env.HARNESSD_EXECUTION_MODE ?? "direct";
	if (executionMode !== "direct" && executionMode !== "isolated")
		throw new InvalidExecutionModeError();
	if (executionMode === "isolated") throw new IsolationUnavailableError();
	const { token, ids } = validateTelegramConfiguration(env);
	const initialCwd = await resolveInitialDirectory(env.HARNESSD_HOME, cwd);
	const stateDirectory = resolveStateDirectory(env.HARNESSD_STATE_DIR);
	const writeError =
		options.writeError ?? ((text: string) => process.stderr.write(text));
	const runtimeStart = options.runtimeStart ?? ApplicationRuntime.start;
	const startupAbort = new AbortController();
	let runtime: Awaited<ReturnType<typeof ApplicationRuntime.start>> | undefined;
	let closePromise: Promise<void> | undefined;
	let closeRequested = false;
	let notifyCloseRequested!: () => void;
	const closeRequestedPromise = new Promise<void>((resolve) => {
		notifyCloseRequested = resolve;
	});
	const beginClose = () => {
		closeRequested = true;
		notifyCloseRequested();
		if (runtime && !closePromise) {
			closePromise = runtime.close();
			void closePromise.catch(() => {});
		} else if (!runtime) startupAbort.abort();
	};
	const onSignal = () => beginClose();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	const transport = new TelegramTransportAdapter({
		token,
		allowedUserIds: ids,
		stateDirectory,
		initialCwd,
		signal: startupAbort.signal,
		onFatal: () => {
			try {
				writeError("Telegram polling failed; harnessd is shutting down.\n");
			} finally {
				beginClose();
			}
		},
	});
	try {
		try {
			runtime = await runtimeStart({
				executionMode,
				piExecutable: env.HARNESSD_PI_EXECUTABLE || "pi",
				stateDirectory,
				transports: [transport],
			});
		} catch (error) {
			if (!closeRequested) throw error;
			if (error instanceof AggregateError)
				writeError(
					"harnessd startup cleanup was incomplete; polling ownership remains protected\n",
				);
			return;
		}
		if (closeRequested && !closePromise) {
			closePromise = runtime.close();
			void closePromise.catch(() => {});
		}
		await closeRequestedPromise;
		closePromise ??= runtime.close();
		await closePromise;
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		if (runtime && !closePromise) await runtime.close();
	}
}

function validateTelegramConfiguration(env: NodeJS.ProcessEnv): {
	readonly token: string;
	readonly ids: number[];
} {
	const token = env.HARNESSD_TELEGRAM_BOT_TOKEN;
	const ids = parseAllowedIds(env.HARNESSD_TELEGRAM_ALLOWED_USER_IDS);
	if (!token?.trim())
		throw new Error("HARNESSD_TELEGRAM_BOT_TOKEN is required");
	if (!ids.length)
		throw new Error(
			"HARNESSD_TELEGRAM_ALLOWED_USER_IDS must contain positive numeric IDs",
		);
	return { token, ids };
}

function validateServiceDotEnv(
	dotenvValues: Readonly<NodeJS.ProcessEnv>,
): void {
	const executionMode = dotenvValues.HARNESSD_EXECUTION_MODE ?? "direct";
	if (executionMode !== "direct" && executionMode !== "isolated")
		throw new InvalidExecutionModeError();
	if (executionMode === "isolated") throw new IsolationUnavailableError();
	if (!dotenvValues.HARNESSD_TELEGRAM_BOT_TOKEN?.trim())
		throw new Error(
			"HARNESSD_SERVICE_DOTENV_MUST_CONTAIN_TELEGRAM_CONFIGURATION",
		);
	if (!parseAllowedIds(dotenvValues.HARNESSD_TELEGRAM_ALLOWED_USER_IDS).length)
		throw new Error(
			"HARNESSD_SERVICE_DOTENV_MUST_CONTAIN_TELEGRAM_CONFIGURATION",
		);
}

function parseAllowedIds(value: string | undefined): number[] {
	if (!value?.trim()) return [];
	const parts = value.split(",").map((item) => item.trim());
	if (parts.some((item) => !/^\d+$/.test(item))) return [];
	const ids = parts.map(Number);
	return ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 0)
		? [...new Set(ids)]
		: [];
}

export function isDirectInvocation(
	moduleUrl: string,
	entryPath: string | undefined,
): boolean {
	if (!entryPath) return false;
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath);
	} catch {
		return false;
	}
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
	void main().catch((error: unknown) => {
		const message =
			error instanceof Error && error.message.startsWith("HARNESSD_")
				? error.message
				: "harnessd could not start or shut down cleanly";
		const detail = describeError(error, [
			process.env.HARNESSD_TELEGRAM_BOT_TOKEN,
		]);
		process.stderr.write(`${message}\n${detail}\n`);
		process.exitCode = 1;
	});
}
