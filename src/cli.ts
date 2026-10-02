#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	ApplicationRuntime,
	InvalidExecutionModeError,
	IsolationUnavailableError,
} from "./application-runtime.js";
import { resolveStateDirectory } from "./core/session-store.js";
import { TelegramTransportAdapter } from "./telegram-transport.js";

export const HELP = `harnessd - locally supervised Pi sessions over Telegram

Usage: harnessd [--help]

Required environment:
  HARNESSD_TELEGRAM_BOT_TOKEN       Telegram bot token
  HARNESSD_TELEGRAM_ALLOWED_USER_IDS  Comma-separated positive numeric Telegram user IDs

Optional environment:
  HARNESSD_PI_EXECUTABLE            Pi executable (default: pi)
  HARNESSD_STATE_DIR                Supervisor state directory
  HARNESSD_EXECUTION_MODE           direct (default, trusted; cwd is not a sandbox) or isolated (unavailable in this CLI; requires a registered isolation provider)

Private-chat commands:
  /sessions
  /new [cwd]
  /use <sessionId>
  /inspect [sessionId]
  /stop [sessionId]
  /cancel <inputId>
  /help

Plain text is submitted to the session selected in that private chat.
`;

export interface CliOptions {
	readonly argv?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly cwd?: string;
	readonly runtimeStart?: typeof ApplicationRuntime.start;
	readonly write?: (text: string) => void;
	readonly writeError?: (text: string) => void;
}

export async function main(options: CliOptions = {}): Promise<void> {
	const argv = options.argv ?? process.argv.slice(2);
	const write = options.write ?? ((text) => process.stdout.write(text));
	if (argv.includes("--help") || argv.includes("-h")) {
		write(HELP);
		return;
	}
	if (argv.length) throw new Error("Unsupported command-line arguments");
	const env = options.env ?? process.env;
	const executionMode = env.HARNESSD_EXECUTION_MODE ?? "direct";
	if (executionMode !== "direct" && executionMode !== "isolated")
		throw new InvalidExecutionModeError();
	if (executionMode === "isolated") throw new IsolationUnavailableError();
	const token = env.HARNESSD_TELEGRAM_BOT_TOKEN;
	const ids = parseAllowedIds(env.HARNESSD_TELEGRAM_ALLOWED_USER_IDS);
	if (!token?.trim())
		throw new Error("HARNESSD_TELEGRAM_BOT_TOKEN is required");
	if (!ids.length)
		throw new Error(
			"HARNESSD_TELEGRAM_ALLOWED_USER_IDS must contain positive numeric IDs",
		);
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
		defaultCwd: options.cwd ?? process.cwd(),
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

function parseAllowedIds(value: string | undefined): number[] {
	if (!value?.trim()) return [];
	const parts = value.split(",").map((item) => item.trim());
	if (parts.some((item) => !/^\d+$/.test(item))) return [];
	const ids = parts.map(Number);
	return ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 0)
		? [...new Set(ids)]
		: [];
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	void main().catch((error: unknown) => {
		const message =
			error instanceof Error && error.message.startsWith("HARNESSD_")
				? error.message
				: "harnessd could not start or shut down cleanly; check configuration and runtime availability";
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
}
