import type { Writable } from "node:stream";
import type { ManagedProcess } from "../core/ports.js";

const TERM_WAIT_MS = 800;
const KILL_WAIT_MS = 800;

export async function shutdownClaudeProcess(
	child: ManagedProcess,
	stdin: Writable,
): Promise<void> {
	try {
		stdin.end();
	} catch {
		/* Continue to process termination. */
	}
	if (await waitExit(child, 250)) return;
	if (await signalAndWait(child, "SIGTERM", TERM_WAIT_MS)) return;
	if (await signalAndWait(child, "SIGKILL", KILL_WAIT_MS)) return;
	throw new Error("Claude shutdown failed; process exit was not confirmed");
}

async function signalAndWait(
	child: ManagedProcess,
	signal: string,
	milliseconds: number,
): Promise<boolean> {
	const deadline = Date.now() + milliseconds;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), milliseconds);
	});
	const signalResult = Promise.resolve()
		.then(() => child.sendSignal(signal))
		.then(
			() => "signal" as const,
			() => "signal" as const,
		);
	const outcome = await Promise.race([
		child.exit.then(
			() => "exit" as const,
			() => "exit-error" as const,
		),
		signalResult,
		timeout,
	]);
	if (timer) clearTimeout(timer);
	if (outcome === "exit") return true;
	if (outcome === "timeout") return false;
	return waitExit(child, Math.max(0, deadline - Date.now()));
}

async function waitExit(
	child: ManagedProcess,
	milliseconds: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), milliseconds);
		child.exit.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				clearTimeout(timer);
				resolve(false);
			},
		);
	});
}
