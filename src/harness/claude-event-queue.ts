import type { HarnessEvent } from "../core/types.js";

export class ClaudeEventQueue implements AsyncIterable<HarnessEvent> {
	private values: HarnessEvent[] = [];
	private waiters: ((value: IteratorResult<HarnessEvent>) => void)[] = [];
	private ended = false;
	[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
		return {
			next: () => {
				const value = this.values.shift();
				if (value) return Promise.resolve({ value, done: false });
				if (this.ended)
					return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => this.waiters.push(resolve));
			},
		};
	}
	push(event: HarnessEvent): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.values.push(event);
	}
	close(): void {
		this.ended = true;
		for (const resolve of this.waiters.splice(0))
			resolve({ value: undefined, done: true });
	}
}
