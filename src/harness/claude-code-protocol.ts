import type { Writable } from "node:stream";
import type { ToolPermissionHandler } from "../core/ports.js";
import type { InputId, SessionId } from "../core/types.js";
import { ClaudeInputDelivery } from "./claude-code-delivery-state.js";
import { ClaudeCodeRecords } from "./claude-code-records.js";
import { ClaudeCodeTurn } from "./claude-code-turn.js";
import type { ClaudeEventQueue } from "./claude-event-queue.js";
import { ClaudePermissionController } from "./claude-permission-controller.js";

export class ClaudeCodeProtocol {
	private failed = false;
	private closed = false;
	private delivery: ClaudeInputDelivery | undefined;
	private turnInput: ClaudeInputDelivery | undefined;
	private readonly records: ClaudeCodeRecords;
	private readonly turn: ClaudeCodeTurn;
	private readonly permissions: ClaudePermissionController;
	constructor(
		private readonly sessionId: SessionId,
		nativeId: string,
		private readonly events: ClaudeEventQueue,
		private readonly onFatal: () => void,
		stdin: Writable,
		permissionHandler?: ToolPermissionHandler,
	) {
		this.turn = new ClaudeCodeTurn(sessionId, events, () =>
			this.failProtocol("Claude event queue overflow"),
		);
		this.permissions = new ClaudePermissionController(
			sessionId,
			() => this.turnInput?.id,
			permissionHandler,
			stdin,
			() => this.failProtocol("Claude permission response failed"),
		);
		this.records = new ClaudeCodeRecords(sessionId, nativeId, events, {
			onUser: (content) => this.acknowledge(content),
			onOutput: (text) => this.output(text),
			onResult: (failed) => this.settle(failed),
		});
	}
	get isIdle(): boolean {
		return !this.failed && !this.closed && !this.delivery && !this.turnInput;
	}

	close(): void {
		this.permissions.close();
	}

	begin(id: InputId, text: string): Promise<void> {
		if (this.failed || this.delivery || this.turnInput)
			throw new Error("CLAUDE_NOT_READY_OR_BUSY");
		const pending = new ClaudeInputDelivery(id, text);
		this.delivery = pending;
		return pending.promise;
	}
	markWritten(): void {
		if (!this.delivery || this.failed) return;
		this.delivery.markWritten();
		this.clearDeliveryIfSettled();
	}
	accept(record: Record<string, unknown>): void {
		if (this.failed) return;
		try {
			if (this.permissions.accept(record)) return;
			this.records.accept(record);
		} catch {
			this.failProtocol("Claude protocol error");
		}
	}
	failProtocol(detail: string): void {
		if (this.failed) return;
		this.failed = true;
		this.closed = true;
		this.permissions.close();
		this.delivery?.rejectDelivery(new Error(detail));
		this.delivery = undefined;
		this.turnInput = undefined;
		this.events.fail({
			sessionId: this.sessionId,
			kind: "error",
			text: detail,
			fatal: true,
		});
		this.onFatal();
	}
	streamEnded(): void {
		if (this.delivery || this.turnInput)
			this.failProtocol("Claude stream ended before turn settlement");
		else {
			this.closed = true;
			this.events.close();
		}
	}
	private acknowledge(content: string): void {
		const p = this.delivery;
		if (!p?.acknowledge(content)) return;
		this.turn.start(p.id);
		this.turnInput = p;
		p.confirmAcknowledgement();
		this.clearDeliveryIfSettled();
	}
	private output(text: string): void {
		if (!this.turnInput) throw new Error("Unexpected assistant output");
		this.turn.output(text);
	}
	private clearDeliveryIfSettled(): void {
		if (this.delivery?.isConfirmed) this.delivery = undefined;
	}
	private settle(failed: boolean): void {
		const p = this.turnInput;
		if (!p) throw new Error("Unexpected result");
		this.turn.settle(p.id, failed);
		this.turnInput = undefined;
	}
}
