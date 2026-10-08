import type { InputId, SessionId } from "../core/types.js";
import { ClaudeCodeRecords } from "./claude-code-records.js";
import { ClaudeCodeTurn } from "./claude-code-turn.js";
import type { ClaudeEventQueue } from "./claude-event-queue.js";

type Pending = {
	id: InputId;
	text: string;
	written: boolean;
	acknowledged: boolean;
	resolve(): void;
	reject(error: Error): void;
};

export class ClaudeCodeProtocol {
	private failed = false;
	private pending: Pending | undefined;
	private readonly records: ClaudeCodeRecords;
	private readonly turn: ClaudeCodeTurn;
	constructor(
		private readonly sessionId: SessionId,
		nativeId: string,
		private readonly events: ClaudeEventQueue,
		private readonly onFatal: () => void,
	) {
		this.turn = new ClaudeCodeTurn(sessionId, events, () =>
			this.failProtocol("Claude event queue overflow"),
		);
		this.records = new ClaudeCodeRecords(sessionId, nativeId, events, {
			onUser: (content) => this.acknowledge(content),
			onOutput: (text) => this.output(text),
			onResult: (failed) => this.settle(failed),
		});
	}
	begin(id: InputId, text: string): Promise<void> {
		if (this.failed || this.pending)
			throw new Error("CLAUDE_NOT_READY_OR_BUSY");
		return new Promise((resolve, reject) => {
			this.pending = {
				id,
				text,
				written: false,
				acknowledged: false,
				resolve,
				reject,
			};
		});
	}
	markWritten(): void {
		const p = this.pending;
		if (!p || this.failed) return;
		p.written = true;
		if (p.acknowledged) p.resolve();
	}
	accept(record: Record<string, unknown>): void {
		if (this.failed) return;
		try {
			this.records.accept(record);
		} catch {
			this.failProtocol("Claude protocol error");
		}
	}
	failProtocol(detail: string): void {
		if (this.failed) return;
		this.failed = true;
		this.pending?.reject(new Error(detail));
		this.pending = undefined;
		this.events.fail({
			sessionId: this.sessionId,
			kind: "error",
			text: detail,
			fatal: true,
		});
		this.onFatal();
	}
	streamEnded(): void {
		if (this.pending)
			this.failProtocol("Claude stream ended before turn settlement");
		else this.events.close();
	}
	private acknowledge(content: string): void {
		const p = this.pending;
		if (!p || p.text !== content) return;
		p.acknowledged = true;
		this.turn.start(p.id);
		if (p.written) p.resolve();
	}
	private output(text: string): void {
		if (!this.pending?.acknowledged)
			throw new Error("Unexpected assistant output");
		this.turn.output(text);
	}
	private settle(failed: boolean): void {
		const p = this.pending;
		if (!p?.acknowledged) throw new Error("Unexpected result");
		this.turn.settle(p.id, failed);
		this.pending = undefined;
	}
}
