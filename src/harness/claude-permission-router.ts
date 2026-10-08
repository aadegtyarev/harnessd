import type { Writable } from "node:stream";
import { isRecord } from "./claude-permission-record.js";
import { writePermissionError } from "./claude-permission-response.js";

export class ClaudePermissionRouter {
	private readonly handled = new Set<string>();
	constructor(
		private readonly stdin: Writable,
		private readonly fail: () => void,
		private readonly onRequest: (
			id: string,
			request: Record<string, unknown>,
		) => void,
		private readonly onCancel: (id: string) => void,
	) {}

	accept(record: Record<string, unknown>): boolean {
		if (record.type === "control_cancel_request") {
			if (typeof record.request_id !== "string") this.fail();
			else this.onCancel(record.request_id);
			return true;
		}
		if (record.type !== "control_request") return false;
		const id = record.request_id;
		if (typeof id !== "string" || id.length < 1 || id.length > 128) {
			this.fail();
			return true;
		}
		if (this.handled.has(id)) return true;
		if (this.handled.size >= 128) {
			this.fail();
			return true;
		}
		this.handled.add(id);
		const request = record.request;
		if (!isRecord(request) || request.subtype !== "can_use_tool") {
			this.error(id, "Unsupported permission request");
			return true;
		}
		this.onRequest(id, request);
		return true;
	}

	private error(id: string, message: string): void {
		void writePermissionError(this.stdin, id, message).catch(() => this.fail());
	}
}
