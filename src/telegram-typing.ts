import { cardRetryAfterMs } from "./telegram-card-delivery.js";

export const TYPING_REFRESH_MS = 4000;
const DEADLINE_MS = 5000;
const CAPACITY = 256;
const MAX_TIMER_MS = 2_147_483_647;
type Owner = {
	inFlight: boolean;
	notBefore: number;
	controller?: AbortController;
	deadline?: ReturnType<typeof setTimeout>;
	retire?: ReturnType<typeof setTimeout>;
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
	) {}

	request(chatId: number): void {
		if (this.stopped) return;
		let owner = this.owners.get(chatId);
		if (!owner) {
			if (this.owners.size >= CAPACITY) return;
			owner = { inFlight: false, notBefore: 0 };
			this.owners.set(chatId, owner);
		}
		if (owner.inFlight || Date.now() < owner.notBefore) return;
		if (owner.retire) clearTimeout(owner.retire);
		owner.retire = undefined;
		owner.inFlight = true;
		owner.notBefore = Date.now() + TYPING_REFRESH_MS;
		const controller = new AbortController();
		owner.controller = controller;
		owner.deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
		owner.deadline.unref();
		const current = owner;
		let raw: Promise<unknown>;
		try {
			raw = Promise.resolve(this.send(chatId, controller.signal));
		} catch (error) {
			raw = Promise.reject(error);
		}
		void raw.then(
			() => this.finish(chatId, current),
			(error: unknown) => this.finish(chatId, current, error),
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
		this.retireWhenSafe(chatId, owner);
	}

	private retireWhenSafe(chatId: number, owner: Owner): void {
		if (this.stopped || this.owners.get(chatId) !== owner || owner.inFlight)
			return;
		const remaining = owner.notBefore - Date.now();
		if (remaining <= 0) {
			this.owners.delete(chatId);
			return;
		}
		if (remaining === Infinity) return;
		owner.retire = setTimeout(
			() => this.retireWhenSafe(chatId, owner),
			Math.min(remaining, MAX_TIMER_MS),
		);
		owner.retire.unref();
	}

	stop(): void {
		this.stopped = true;
		for (const owner of this.owners.values()) {
			if (owner.deadline) clearTimeout(owner.deadline);
			if (owner.retire) clearTimeout(owner.retire);
			owner.controller?.abort();
		}
		this.owners.clear();
	}
}
