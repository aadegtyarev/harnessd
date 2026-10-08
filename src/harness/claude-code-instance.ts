import type {
	HarnessInstance,
	HarnessLaunchRequest,
	ManagedProcess,
} from "../core/ports.js";
import type { Input, InputId } from "../core/types.js";
import { mapClaudeEvent } from "./claude-code-events.js";
import { ClaudeEventQueue } from "./claude-event-queue.js";
import { ClaudeJsonlFramer, parseClaudeRecord } from "./claude-jsonl.js";

export function createClaudeInstance(
	child: ManagedProcess,
	request: HarnessLaunchRequest,
	nativeId: string,
): HarnessInstance {
	const stdin = child.stdin;
	const stdout = child.stdout;
	const stderr = child.stderr;
	if (!stdin || !stdout || !stderr) throw new Error("CLAUDE_PIPE_REQUIRED");
	void stderr.resume();
	const queue = new ClaudeEventQueue();
	let inputId: InputId | undefined;
	let mismatch = false;
	const framer = new ClaudeJsonlFramer((line) => {
		const record = parseClaudeRecord(line);
		if (
			record.type === "system" &&
			record.subtype === "init" &&
			record.session_id !== nativeId
		) {
			mismatch = true;
			queue.push({
				sessionId: request.sessionId,
				kind: "error",
				text: "Claude session identity mismatch",
				fatal: true,
			});
			void child.sendSignal("SIGTERM");
			return;
		}
		for (const event of mapClaudeEvent(record, request.sessionId, inputId))
			queue.push(event);
	});
	stdout.on("data", (chunk: Buffer) => {
		try {
			framer.push(chunk);
		} catch {
			queue.push({
				sessionId: request.sessionId,
				kind: "error",
				text: "Claude protocol error",
				fatal: true,
			});
			void child.sendSignal("SIGTERM");
		}
	});
	stdout.on("end", () => {
		try {
			framer.finish();
		} catch {
			queue.push({
				sessionId: request.sessionId,
				kind: "error",
				text: "Claude protocol error",
				fatal: true,
			});
		}
		queue.close();
	});
	return {
		processId: child.id,
		exit: child.exit,
		nativeSessionId: nativeId,
		events: queue,
		async send(input: Input) {
			if (mismatch || inputId)
				throw new Error("Claude accepts one prompt per process");
			inputId = input.id;
			queue.push({
				sessionId: input.sessionId,
				kind: "input",
				inputEvent: { inputId: input.id, state: "pending" },
			});
			stdin.write(
				`${JSON.stringify({ type: "user", message: { role: "user", content: input.text } })}\n`,
			);
		},
		async cancel(_id: InputId) {
			throw new Error("Unsupported capability");
		},
		async shutdown() {
			stdin.end();
			await child.sendSignal("SIGTERM").catch(() => {});
		},
	};
}
