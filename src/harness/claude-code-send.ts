import type { Writable } from "node:stream";
import type { Input } from "../core/types.js";
import type { ClaudeCodeProtocol } from "./claude-code-protocol.js";
import type { ClaudeEventQueue } from "./claude-event-queue.js";
import { MAX_CLAUDE_RECORD_BYTES } from "./claude-jsonl.js";
import { UncertainInputDeliveryError } from "./input-delivery-error.js";

export async function sendClaudeInput(
	input: Input,
	stdin: Writable,
	events: ClaudeEventQueue,
	protocol: ClaudeCodeProtocol,
	timeoutMs: number,
): Promise<void> {
	if (input.text.length * 6 > MAX_CLAUDE_RECORD_BYTES - 128)
		throw new Error("CLAUDE_INPUT_TOO_LARGE");
	const line = `${JSON.stringify({ type: "user", message: { role: "user", content: input.text } })}\n`;
	if (Buffer.byteLength(line) > MAX_CLAUDE_RECORD_BYTES)
		throw new Error("CLAUDE_INPUT_TOO_LARGE");
	const acknowledgement = protocol.begin(input.id, input.text);
	void acknowledgement.catch(() => {});
	if (
		!events.push({
			sessionId: input.sessionId,
			kind: "input",
			inputEvent: { inputId: input.id, state: "pending" },
		})
	) {
		protocol.failProtocol("Claude event queue overflow");
		throw new Error("Claude event queue overflow");
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			protocol.failProtocol("Claude acknowledgement timeout");
			reject(new Error("Claude acknowledgement timeout"));
		}, timeoutMs);
	});
	const writing = new Promise<void>((resolve, reject) => {
		try {
			stdin.write(line, (error?: Error | null) =>
				error ? reject(error) : resolve(),
			);
		} catch (error) {
			reject(error);
		}
	});
	try {
		await Promise.race([writing, deadline]);
		protocol.markWritten();
		await Promise.race([acknowledgement, deadline]);
	} catch (error) {
		protocol.failProtocol("Claude input acknowledgement failed");
		await acknowledgement.catch(() => {});
		throw new UncertainInputDeliveryError(input.id, { cause: error });
	} finally {
		if (timer) clearTimeout(timer);
	}
}
