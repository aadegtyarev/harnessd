import type { InputId } from "../core/types.js";

export class ClaudeInputDelivery {
	readonly promise: Promise<void>;
	private resolve!: () => void;
	private reject!: (error: Error) => void;
	private written = false;
	private acknowledged = false;
	private acknowledgementProjected = false;
	constructor(
		readonly id: InputId,
		readonly text: string,
	) {
		this.promise = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
	get isConfirmed(): boolean {
		return this.written && this.acknowledgementProjected;
	}
	markWritten(): void {
		this.written = true;
		this.complete();
	}
	acknowledge(content: string): boolean {
		if (this.acknowledged || this.text !== content) return false;
		this.acknowledged = true;
		return true;
	}
	confirmAcknowledgement(): void {
		this.acknowledgementProjected = true;
		this.complete();
	}
	rejectDelivery(error: Error): void {
		this.reject(error);
	}
	private complete(): void {
		if (this.written && this.acknowledgementProjected) this.resolve();
	}
}
