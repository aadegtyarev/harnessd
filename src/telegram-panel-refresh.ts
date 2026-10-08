export class TelegramPanelRefreshScheduler {
	private readonly pending = new Map<number, () => Promise<void>>();
	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
	private readonly queuedAt = new Map<number, number>();
	private readonly lastRun = new Map<number, number>();
	private readonly generations = new Map<number, number>();
	private readonly running = new Set<number>();
	private readonly flushRequested = new Set<number>();
	private stopped = false;

	constructor(
		private readonly clock: () => number = Date.now,
		private readonly spacingMs = 500,
		private readonly maxWaitMs = 2000,
		private readonly onError: (error: unknown) => void = () => {},
	) {}

	stop(): void {
		this.stopped = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.pending.clear();
		this.queuedAt.clear();
		this.flushRequested.clear();
		for (const chatId of this.generations.keys())
			this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
	}

	schedule(chatId: number, refresh: () => Promise<void>, flush = false): void {
		if (this.stopped) return;
		this.pending.set(chatId, refresh);
		if (!this.queuedAt.has(chatId)) this.queuedAt.set(chatId, this.clock());
		this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
		if (flush) {
			this.clearTimer(chatId);
			if (this.running.has(chatId)) this.flushRequested.add(chatId);
			else void this.run(chatId);
			return;
		}
		this.arm(chatId);
	}

	private arm(chatId: number): void {
		if (this.stopped) return;
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
		if (this.stopped || this.running.has(chatId)) return;
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
		} catch (error) {
			this.onError(error);
		} finally {
			this.running.delete(chatId);
			if (this.flushRequested.delete(chatId) && this.pending.has(chatId))
				void this.run(chatId);
			else if (
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
