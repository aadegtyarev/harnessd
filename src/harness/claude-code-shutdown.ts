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
	try {
		await child.sendSignal("SIGTERM");
	} catch {
		/* Escalate after the bounded wait. */
	}
	if (await waitExit(child, TERM_WAIT_MS)) return;
	try {
		await child.sendSignal("SIGKILL");
	} catch {
		/* Verify exit below. */
	}
	if (await waitExit(child, KILL_WAIT_MS)) return;
	throw new Error("Claude shutdown failed; process exit was not confirmed");
}

async function waitExit(
	child: ManagedProcess,
	milliseconds: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), milliseconds);
		child.exit.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}
