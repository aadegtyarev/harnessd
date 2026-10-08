import type { HarnessEvent } from "../core/types.js";

export const MAX_CLAUDE_QUEUED_EVENTS = 1024;
export const MAX_CLAUDE_QUEUED_BYTES = 4 * 1024 * 1024;

export class ClaudeEventQueue implements AsyncIterable<HarnessEvent> {
	private values: { event: HarnessEvent; bytes: number }[] = [];
	private bytes = 0;
	private waiters: ((value: IteratorResult<HarnessEvent>) => void)[] = [];
	private ended = false;
	[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
		return {
			next: () => {
				const queued = this.values.shift();
				if (queued) {
					this.bytes -= queued.bytes;
					return Promise.resolve({ value: queued.event, done: false });
				}
				if (this.ended)
					return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => this.waiters.push(resolve));
			},
		};
	}
	push(event: HarnessEvent): boolean {
		if (this.ended) return false;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: event, done: false });
		else {
			const bytes = Buffer.byteLength(event.text ?? "") + 128;
			if (
				this.values.length >= MAX_CLAUDE_QUEUED_EVENTS ||
				this.bytes + bytes > MAX_CLAUDE_QUEUED_BYTES
			)
				return false;
			this.values.push({ event, bytes });
			this.bytes += bytes;
		}
		return true;
	}
	fail(event: HarnessEvent): void {
		this.values = [];
		this.bytes = 0;
		this.ended = true;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: event, done: false });
		else {
			const bytes = Buffer.byteLength(event.text ?? "") + 128;
			this.values.push({ event, bytes });
			this.bytes = bytes;
		}
		for (const resolve of this.waiters.splice(0))
			resolve({ value: undefined, done: true });
	}
	close(): void {
		this.ended = true;
		for (const resolve of this.waiters.splice(0))
			resolve({ value: undefined, done: true });
	}
}
