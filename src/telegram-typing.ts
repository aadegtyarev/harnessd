import { cardRetryAfterMs } from "./telegram-card-delivery.js";

export const TYPING_REFRESH_MS = 4000;
const DEADLINE_MS = 5000;
const CAPACITY = 256;
const MAX_TIMER_MS = 2_147_483_647;
type Owner = {
	inFlight: boolean;
	pending: boolean;
	notBefore: number;
	controller?: AbortController;
	deadline?: ReturnType<typeof setTimeout>;
	timer?: ReturnType<typeof setTimeout>;
};

/** Best-effort per-chat typing, with raw-call ownership across local deadlines. */
export class TelegramTyping {
	private readonly owners = new Map<number, Owner>();
	private stopped = false;
	constructor(
		private readonly send: (
			chatId: number,
			signal: AbortSignal,
		) => Promise<unknown>,
		private readonly eligible: (chatId: number) => boolean = () => true,
	) {}

	request(chatId: number): void {
		if (this.stopped || !this.eligible(chatId)) return;
		let owner = this.owners.get(chatId);
		if (!owner) {
			if (this.owners.size >= CAPACITY) return;
			owner = { inFlight: false, pending: false, notBefore: 0 };
			this.owners.set(chatId, owner);
		}
		owner.pending = true;
		this.arm(chatId, owner);
	}

	private arm(chatId: number, owner: Owner): void {
		if (this.stopped || this.owners.get(chatId) !== owner || owner.inFlight)
			return;
		if (owner.timer) clearTimeout(owner.timer);
		owner.timer = undefined;
		if (!this.eligible(chatId)) owner.pending = false;
		const remaining = owner.notBefore - Date.now();
		if (remaining > 0) {
			if (remaining !== Infinity) {
				owner.timer = setTimeout(
					() => this.arm(chatId, owner),
					Math.min(remaining, MAX_TIMER_MS),
				);
				owner.timer.unref();
			}
			return;
		}
		if (!owner.pending) {
			this.owners.delete(chatId);
			return;
		}
		owner.pending = false;
		owner.inFlight = true;
		owner.notBefore = Date.now() + TYPING_REFRESH_MS;
		const controller = new AbortController();
		owner.controller = controller;
		owner.deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
		owner.deadline.unref();
		let raw: Promise<unknown>;
		try {
			raw = Promise.resolve(this.send(chatId, controller.signal));
		} catch (error) {
			raw = Promise.reject(error);
		}
		void raw.then(
			() => this.finish(chatId, owner),
			(error: unknown) => this.finish(chatId, owner, error),
		);
	}

	private finish(chatId: number, owner: Owner, error?: unknown): void {
		if (this.stopped || this.owners.get(chatId) !== owner) return;
		if (owner.deadline) clearTimeout(owner.deadline);
		owner.deadline = undefined;
		owner.controller = undefined;
		owner.inFlight = false;
		if (
			error &&
			typeof error === "object" &&
			"error_code" in error &&
			error.error_code === 429
		) {
			const delay = cardRetryAfterMs(error);
			if (delay !== undefined) {
				const until = Date.now() + delay;
				owner.notBefore = Math.max(
					owner.notBefore,
					until > Number.MAX_SAFE_INTEGER ? Infinity : until,
				);
			}
		}
		this.arm(chatId, owner);
	}

	stop(): void {
		this.stopped = true;
		for (const owner of this.owners.values()) {
			if (owner.deadline) clearTimeout(owner.deadline);
			if (owner.timer) clearTimeout(owner.timer);
			owner.controller?.abort();
		}
		this.owners.clear();
	}
}
