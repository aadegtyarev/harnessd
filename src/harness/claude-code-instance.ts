import type {
	HarnessInstance,
	HarnessLaunchRequest,
	ManagedProcess,
} from "../core/ports.js";
import type { InputId } from "../core/types.js";
import { ClaudeCodeProtocol } from "./claude-code-protocol.js";
import { sendClaudeInput } from "./claude-code-send.js";
import { shutdownClaudeProcess } from "./claude-code-shutdown.js";
import { ClaudeEventQueue } from "./claude-event-queue.js";
import { ClaudeJsonlFramer, parseClaudeRecord } from "./claude-jsonl.js";

export function createClaudeInstance(
	child: ManagedProcess,
	request: HarnessLaunchRequest,
	nativeId: string,
	ackTimeoutMs: number,
	cleanupBridge?: () => Promise<void> | undefined,
): HarnessInstance {
	const stdin = child.stdin;
	const stdout = child.stdout;
	const stderr = child.stderr;
	if (!stdin || !stdout || !stderr) throw new Error("CLAUDE_PIPE_REQUIRED");
	stderr.on("error", () => {});
	void stderr.resume();
	const events = new ClaudeEventQueue();
	let cleanup: Promise<void> | undefined;
	const stop = () => {
		cleanup ??= shutdownClaudeProcess(child, stdin);
		void cleanup.catch(() => {
			cleanup = undefined;
		});
	};
	const protocol = new ClaudeCodeProtocol(
		request.sessionId,
		nativeId,
		events,
		stop,
		stdin,
		request.toolPermissionHandler,
	);
	let processExited = false;
	void child.exit.then(
		() => {
			processExited = true;
			void cleanupBridge?.();
		},
		() => {
			processExited = true;
			void cleanupBridge?.();
		},
	);
	const framer = new ClaudeJsonlFramer((line) =>
		protocol.accept(parseClaudeRecord(line)),
	);
	const fail = () => protocol.failProtocol("Claude protocol error");
	stdout.on("data", (chunk: Buffer) => {
		try {
			framer.push(chunk);
		} catch {
			fail();
		}
	});
	stdout.on("error", fail);
	stdout.on("end", () => {
		try {
			framer.finish();
			protocol.streamEnded();
		} catch {
			fail();
		}
	});
	stdin.on("error", fail);
	return {
		processId: child.id,
		exit: child.exit,
		nativeSessionId: nativeId,
		events,
		isIdle: () => !processExited && protocol.isIdle,
		async send(input) {
			await sendClaudeInput(input, stdin, events, protocol, ackTimeoutMs);
		},
		async cancel(_id: InputId) {
			throw new Error("Unsupported capability");
		},
		async shutdown() {
			protocol.close();
			if (!cleanup) cleanup = shutdownClaudeProcess(child, stdin);
			try {
				await cleanup;
				await cleanupBridge?.();
			} catch (error) {
				cleanup = undefined;
				throw error;
			}
		},
	};
}
