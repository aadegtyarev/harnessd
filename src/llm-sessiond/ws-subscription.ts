import type { EventEnvelope } from "./types.js";

export type Subscription = AsyncIterableIterator<EventEnvelope> & {
	close(): void;
	closed: Promise<void>;
	error?: Error;
};
type Waiter = {
	resolve(value: IteratorResult<EventEnvelope>): void;
	reject(error: Error): void;
};

export class EventSubscription implements Subscription {
	private readonly queue: EventEnvelope[] = [];
	private readonly waiters: Waiter[] = [];
	private terminal = false;
	private failure: Error | undefined;
	private resolveClosed!: () => void;
	readonly closed = new Promise<void>((resolve) => {
		this.resolveClosed = resolve;
	});

	constructor(private readonly closeSocket: () => void) {}
	get error(): Error | undefined {
		return this.failure;
	}
	get isTerminal(): boolean {
		return this.terminal;
	}
	[Symbol.asyncIterator](): AsyncIterableIterator<EventEnvelope> {
		return this;
	}
	next(): Promise<IteratorResult<EventEnvelope>> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.terminal) return Promise.resolve({ done: true, value: undefined });
		const event = this.queue.shift();
		if (event) return Promise.resolve({ done: false, value: event });
		return new Promise((resolve, reject) =>
			this.waiters.push({ resolve, reject }),
		);
	}
	return(): Promise<IteratorResult<EventEnvelope>> {
		this.terminate();
		return Promise.resolve({ done: true, value: undefined });
	}
	close(): void {
		this.terminate();
	}
	push(event: EventEnvelope): void {
		if (this.terminal) return;
		const waiter = this.waiters.shift();
		waiter
			? waiter.resolve({ done: false, value: event })
			: this.queue.push(event);
	}
	fail(error: Error): void {
		this.terminate(error);
	}
	socketClosed(): void {
		this.end();
		this.resolveClosed();
	}
	private terminate(error?: Error): void {
		if (this.end(error)) {
			try {
				this.closeSocket();
			} catch {
				/* close confirmation remains pending */
			}
		}
	}
	private end(error?: Error): boolean {
		if (this.terminal) return false;
		this.terminal = true;
		this.failure = error;
		this.queue.length = 0;
		for (const waiter of this.waiters.splice(0))
			error
				? waiter.reject(error)
				: waiter.resolve({ done: true, value: undefined });
		return true;
	}
}
