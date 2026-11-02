const SPACING_MS = 500;
const DEADLINE_MS = 5000;
const MAX_TIMER_MS = 2_147_483_647;
const CLEANUP_CAPACITY = 128;
const CLEANUP_SPACING_MS = 5000;
const DIAGNOSTIC_INTERVAL_MS = 60_000;
export type CardCallResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: unknown };
export type CardDiagnosticKind =
	| "edit_deferred"
	| "edit_exhausted"
	| "render_failed"
	| "cleanup_deferred"
	| "cleanup_capacity"
	| "edit_rejected";
function reportDiagnostic(
	sink: (kind: CardDiagnosticKind) => void,
	kind: CardDiagnosticKind,
): void {
	try {
		sink(kind);
	} catch {
		/* A failing diagnostic sink cannot change retry ownership. */
	}
}
type Operation = (signal: AbortSignal) => Promise<unknown>;
type FailurePolicy = {
	readonly transient: boolean;
	readonly retryAfterMs?: number;
	readonly confirmed?: boolean;
};

/** Card-local metadata only: malformed limits get the bounded transient failure policy. */
export function cardRetryAfterMs(error: unknown): number | undefined {
	if (!error || typeof error !== "object" || !("parameters" in error)) return;
	const seconds = (error.parameters as { retry_after?: unknown } | undefined)
		?.retry_after;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
		return;
	// Unrepresentably large valid intervals are quarantined until shutdown, never shortened.
	const milliseconds = seconds * 1000;
	return milliseconds > Number.MAX_SAFE_INTEGER ? Infinity : milliseconds;
}

type CardSettlement = { readonly at: number; readonly result: CardCallResult };

function retryDeadlineAt(at: number, delay: number): number {
	const deadline = at + delay;
	return deadline > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(deadline);
}

/** A late verdict contributes cooldown metadata, never a second delivery result or budget reset. */
function settlementRetryAt(
	settlement: CardSettlement | undefined,
	classify: (error: unknown) => FailurePolicy,
): number | undefined {
	if (!settlement || settlement.result.ok) return;
	const delay = classify(settlement.result.error).retryAfterMs;
	return delay === undefined
		? undefined
		: retryDeadlineAt(settlement.at, delay);
}

/** The API deadline ends the result, not ownership of an uncertain underlying call. */
class CardCallOwner {
	private controller?: AbortController;
	settled: Promise<CardSettlement | undefined> = Promise.resolve(undefined);
	async call(operation: Operation): Promise<CardCallResult> {
		const controller = new AbortController();
		this.controller = controller;
		let raw: Promise<unknown>;
		try {
			raw = Promise.resolve(operation(controller.signal));
		} catch (error) {
			raw = Promise.reject(error);
		}
		this.settled = raw.then(
			() => ({ at: Date.now(), result: { ok: true, value: undefined } }),
			(error: unknown) => ({ at: Date.now(), result: { ok: false, error } }),
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort = () => {};
		const deadline = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(new Error("card call stopped"));
			controller.signal.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => {
				reject(new Error("deadline"));
				controller.abort();
			}, DEADLINE_MS);
		});
		try {
			return { ok: true, value: await Promise.race([raw, deadline]) };
		} catch (error) {
			return { ok: false, error };
		} finally {
			if (timer) clearTimeout(timer);
			controller.signal.removeEventListener("abort", onAbort);
			void this.settled.then(() => {
				if (this.controller === controller) this.controller = undefined;
			});
		}
	}
	stop(): void {
		this.controller?.abort();
	}
}

/** One dirty bit, one timer and one raw-owned call per physical live card. */
export class TelegramCardScheduler {
	private readonly owner = new CardCallOwner();
	private dirty = false;
	private closed = false;
	private exhausted = false;
	private failures = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private active = false;
	private lastEditAt = -Infinity;
	retryAt = -Infinity;
	task: Promise<void> = Promise.resolve();

	constructor(
		private readonly render: () => Promise<void>,
		private readonly classify: (error: unknown) => FailurePolicy,
		private readonly onExhausted: (notBefore: number) => void,
		private readonly diagnostic: (kind: CardDiagnosticKind) => void,
	) {}

	schedule(): void {
		if (this.closed || this.exhausted) return;
		this.dirty = true;
		this.arm();
	}
	stop(): void {
		this.closed = true;
		this.dirty = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.owner.stop();
	}
	async edit(operation: Operation): Promise<CardCallResult> {
		this.lastEditAt = Date.now();
		const result = await this.owner.call(operation);
		if (this.closed) return result;
		if (result.ok) {
			this.failures = 0;
			return result;
		}
		const policy = this.classify(result.error);
		if (policy.confirmed) {
			this.failures = 0;
			return { ok: true, value: true };
		}
		if (!policy.transient) return result;
		reportDiagnostic(this.diagnostic, "edit_deferred");
		if (policy.retryAfterMs !== undefined) {
			this.retryAt = retryDeadlineAt(Date.now(), policy.retryAfterMs);
			this.dirty = true;
		} else if (++this.failures <= 2) {
			this.retryAt = Date.now() + this.failures * 500;
			this.dirty = true;
		} else {
			this.exhausted = true;
			this.dirty = false;
		}
		return result;
	}
	private arm(): void {
		if (this.closed || this.active || this.timer || !this.dirty) return;
		const at = Math.max(this.retryAt, this.lastEditAt + SPACING_MS);
		const remaining = at - Date.now();
		if (remaining === Infinity) return;
		if (remaining > 0) {
			this.timer = setTimeout(
				() => {
					this.timer = undefined;
					this.arm();
				},
				Math.min(remaining, MAX_TIMER_MS),
			);
			return;
		}
		this.active = true;
		this.dirty = false;
		this.task = Promise.resolve()
			.then(async () => {
				if (this.closed) return;
				try {
					await this.render();
				} catch {
					reportDiagnostic(this.diagnostic, "render_failed");
				}
				// Absorb a late 429 before releasing either edit or exhaustion-cleanup ownership.
				const settlement = await this.owner.settled;
				if (this.closed) return;
				const retryAt = settlementRetryAt(settlement, this.classify);
				if (retryAt !== undefined)
					this.retryAt = Math.max(this.retryAt, retryAt);
				if (this.exhausted) {
					reportDiagnostic(this.diagnostic, "edit_exhausted");
					this.onExhausted(this.retryAt);
				}
			})
			.finally(() => {
				this.active = false;
				this.arm();
			});
	}
}

type CleanupIntent = {
	readonly chatId: number;
	readonly messageId: number;
	readonly generation: number;
	nextAt: number;
	attempts: number;
};

/** At most one deletion per closure, at most two attempts per retained physical message. */
export class TelegramCardCleanup {
	private readonly intents = new Map<string, CleanupIntent>();
	private readonly owner = new CardCallOwner();
	private active = false;
	private closed = false;
	private lastAttemptAt = -Infinity;
	private notBefore = -Infinity;

	constructor(
		private readonly remove: (
			chatId: number,
			messageId: number,
			signal: AbortSignal,
		) => Promise<unknown>,
		private readonly classify: (error: unknown) => FailurePolicy,
		private readonly isGone: (error: unknown) => boolean,
		private readonly diagnostic: (kind: CardDiagnosticKind) => void,
	) {}
	exhausted(
		chatId: number,
		messageId: number,
		generation: number,
		notBefore = -Infinity,
	): void {
		if (this.closed) return;
		const key = JSON.stringify([chatId, messageId]);
		if (this.intents.has(key)) return;
		if (this.intents.size >= CLEANUP_CAPACITY) {
			reportDiagnostic(this.diagnostic, "cleanup_capacity");
			return;
		}
		const intent = {
			chatId,
			messageId,
			generation,
			attempts: 0,
			nextAt: Math.max(Date.now(), notBefore),
		};
		this.intents.set(key, intent);
		this.attempt(key, intent);
	}
	/** Only a later normal closure may retry an already retained old target. */
	onClosure(): void {
		if (!this.eligible()) return;
		for (const [key, intent] of this.intents) {
			if (Date.now() < intent.nextAt) continue;
			this.attempt(key, intent);
			return;
		}
	}
	private eligible(): boolean {
		return (
			!this.closed &&
			!this.active &&
			Date.now() >=
				Math.max(this.notBefore, this.lastAttemptAt + CLEANUP_SPACING_MS)
		);
	}
	private attempt(key: string, intent: CleanupIntent): void {
		if (!this.eligible() || Date.now() < intent.nextAt) return;
		this.active = true;
		this.lastAttemptAt = Date.now();
		intent.attempts++;
		void this.owner
			.call((signal) => this.remove(intent.chatId, intent.messageId, signal))
			.then(async (result) => {
				if (this.closed) return;
				if (!result.ok) {
					const retryAfter = this.classify(result.error).retryAfterMs;
					if (retryAfter !== undefined)
						this.notBefore = Math.max(
							this.notBefore,
							retryDeadlineAt(Date.now(), retryAfter),
						);
				}
				if (result.ok || this.isGone(result.error) || intent.attempts >= 2)
					this.intents.delete(key);
				else {
					reportDiagnostic(this.diagnostic, "cleanup_deferred");
					const policy = this.classify(result.error);
					intent.nextAt = retryDeadlineAt(
						Date.now(),
						Math.max(CLEANUP_SPACING_MS, policy.retryAfterMs ?? 0),
					);
				}
				const settlement = await this.owner.settled;
				if (this.closed) return;
				const retryAt = settlementRetryAt(settlement, this.classify);
				if (retryAt !== undefined) {
					// The cleanup owner's cooldown survives even a dropped second-attempt target.
					this.notBefore = Math.max(this.notBefore, retryAt);
					intent.nextAt = Math.max(intent.nextAt, retryAt);
				}
			})
			.finally(() => {
				this.active = false;
			});
	}

	stop(): void {
		this.closed = true;
		this.intents.clear();
		this.owner.stop();
	}
}

/** Fixed fields only; no exceptions, update contents, tokens or model text enter this sink. */
export class TelegramCardDiagnostics {
	private readonly phases = new Map<
		CardDiagnosticKind,
		{ at: number; suppressed: number }
	>();
	report(kind: CardDiagnosticKind): void {
		const previous = this.phases.get(kind);
		if (previous && Date.now() - previous.at < DIAGNOSTIC_INTERVAL_MS) {
			previous.suppressed = Math.min(
				previous.suppressed + 1,
				Number.MAX_SAFE_INTEGER,
			);
			return;
		}
		this.phases.set(kind, { at: Date.now(), suppressed: 0 });
		try {
			console.error(
				`harnessd: telegram_card ${kind} suppressed=${previous?.suppressed ?? 0}`,
			);
		} catch {
			/* Diagnostics never change delivery ownership. */
		}
	}
}
