export class TelegramPanelRefreshScheduler {
	private readonly pending = new Map<number, () => Promise<void>>();
	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
	private readonly queuedAt = new Map<number, number>();
	private readonly lastRun = new Map<number, number>();
	private readonly generations = new Map<number, number>();
	private readonly running = new Set<number>();

	constructor(
		private readonly clock: () => number = Date.now,
		private readonly spacingMs = 500,
		private readonly maxWaitMs = 2000,
	) {}

	schedule(chatId: number, refresh: () => Promise<void>, flush = false): void {
		this.pending.set(chatId, refresh);
		if (!this.queuedAt.has(chatId)) this.queuedAt.set(chatId, this.clock());
		this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
		if (flush) {
			this.clearTimer(chatId);
			void this.run(chatId);
			return;
		}
		this.arm(chatId);
	}

	private arm(chatId: number): void {
		this.clearTimer(chatId);
		const now = this.clock();
		const earliest = (this.lastRun.get(chatId) ?? -Infinity) + this.spacingMs;
		const latest = (this.queuedAt.get(chatId) ?? now) + this.maxWaitMs;
		this.timers.set(
			chatId,
			setTimeout(
				() => void this.run(chatId),
				Math.max(0, Math.min(earliest, latest) - now),
			),
		);
	}

	private async run(chatId: number): Promise<void> {
		if (this.running.has(chatId)) return;
		this.clearTimer(chatId);
		const refresh = this.pending.get(chatId);
		if (!refresh) return;
		const generation = this.generations.get(chatId);
		this.pending.delete(chatId);
		this.queuedAt.delete(chatId);
		this.running.add(chatId);
		this.lastRun.set(chatId, this.clock());
		try {
			await refresh();
		} finally {
			this.running.delete(chatId);
			if (
				this.pending.has(chatId) &&
				this.generations.get(chatId) !== generation
			)
				this.arm(chatId);
		}
	}

	private clearTimer(chatId: number): void {
		const timer = this.timers.get(chatId);
		if (timer) clearTimeout(timer);
		this.timers.delete(chatId);
	}
}
