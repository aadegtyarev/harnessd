const UPDATE_CAPACITY = 100;
const FEEDBACK_CAPACITY = 8;
const OVERLOAD_INTERVAL_MS = 5000;
type Work = () => Promise<void>;
type Lane = { readonly pending: Work[]; active?: Promise<void> };

/** Owns polling work without letting presentation waits stop update admission. */
export class TelegramUpdateIngress {
	private readonly ordinary: Lane = { pending: [] };
	private readonly cancellation: Lane = { pending: [] };
	private readonly feedback = new Set<Promise<void>>();
	private lastOverloadAt = -Infinity;
	private lastErrorAt = -Infinity;
	private closed = false;

	constructor(private readonly onError: (error: unknown) => void) {}

	/** Each lane is FIFO and single-flight; capacity includes its active handler. */
	admit(cancel: boolean, work: Work, overload: Work): boolean {
		if (this.closed) return false;
		const lane = cancel ? this.cancellation : this.ordinary;
		if (lane.pending.length + (lane.active ? 1 : 0) >= UPDATE_CAPACITY) {
			const now = Date.now();
			if (now - this.lastOverloadAt >= OVERLOAD_INTERVAL_MS) {
				this.lastOverloadAt = now;
				this.present(overload);
			}
			return false;
		}
		lane.pending.push(work);
		this.drain(lane);
		return true;
	}

	/** Best-effort cancel feedback cannot own the cancellation dispatch lane. */
	present(work: Work, onDropped?: () => void): void {
		const dropped = () => {
			try {
				onDropped?.();
			} catch {
				/* Observation never changes feedback ownership. */
			}
		};
		if (this.closed || this.feedback.size >= FEEDBACK_CAPACITY) {
			dropped();
			return;
		}
		const task = Promise.resolve()
			.then(() => {
				if (this.closed) {
					dropped();
					return;
				}
				return work();
			})
			.catch((error: unknown) => this.reportError(error));
		this.feedback.add(task);
		void task.finally(() => this.feedback.delete(task));
	}

	/** Invalidate queued closures immediately; the transport bounds joining active work. */
	close(): Promise<void> {
		this.closed = true;
		this.ordinary.pending.length = 0;
		this.cancellation.pending.length = 0;
		return Promise.all([
			this.ordinary.active,
			this.cancellation.active,
			...this.feedback,
		]).then(() => undefined);
	}

	private reportError(error: unknown): void {
		const now = Date.now();
		if (now - this.lastErrorAt < OVERLOAD_INTERVAL_MS) return;
		this.lastErrorAt = now;
		try {
			this.onError(error);
		} catch {
			/* Diagnostics cannot change admission or drain ownership. */
		}
	}

	private drain(lane: Lane): void {
		if (this.closed || lane.active) return;
		const work = lane.pending.shift();
		if (!work) return;
		const task = Promise.resolve()
			.then(() => (this.closed ? undefined : work()))
			.catch((error: unknown) => this.reportError(error));
		lane.active = task;
		void task.finally(() => {
			lane.active = undefined;
			this.drain(lane);
		});
	}
}
