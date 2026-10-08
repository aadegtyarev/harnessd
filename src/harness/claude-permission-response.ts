import type { Writable } from "node:stream";
import type { ToolPermissionDecision } from "../core/ports.js";

export function writePermissionDecision(
	stdin: Writable,
	requestId: string,
	decision: ToolPermissionDecision,
): Promise<void> {
	const response =
		decision.behavior === "allow"
			? { behavior: "allow" }
			: {
					behavior: "deny",
					message: decision.message.slice(0, 512),
					interrupt: false,
				};
	return write(stdin, {
		type: "control_response",
		response: { subtype: "success", request_id: requestId, response },
	});
}

export function writePermissionError(
	stdin: Writable,
	requestId: string,
	message: string,
): Promise<void> {
	return write(stdin, {
		type: "control_response",
		response: { subtype: "error", request_id: requestId, error: { message } },
	});
}

function write(stdin: Writable, record: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			stdin.write(`${JSON.stringify(record)}\n`, (error?: Error | null) =>
				error ? reject(error) : resolve(),
			);
		} catch (error) {
			reject(error);
		}
	});
}
