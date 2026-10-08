export class TelegramPanelRefreshScheduler {
	private readonly pending = new Map<number, () => Promise<void>>();
	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
	private readonly queuedAt = new Map<number, number>();
	private readonly lastRun = new Map<number, number>();
	private readonly executions = new Map<number, Set<Promise<void>>>();
	private stopped = false;

	constructor(
		private readonly clock: () => number = Date.now,
		private readonly spacingMs = 500,
		private readonly maxWaitMs = 2000,
		private readonly onError: (error: unknown) => void = () => {},
	) {}
	async stop(): Promise<void> {
		this.stopped = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.pending.clear();
		this.queuedAt.clear();
		await Promise.all(
			[...this.executions.values()].flatMap((jobs) => [...jobs]),
		);
	}
	schedule(chatId: number, refresh: () => Promise<void>, flush = false): void {
		if (this.stopped) return;
		this.pending.set(chatId, refresh);
		if (!this.queuedAt.has(chatId)) this.queuedAt.set(chatId, this.clock());
		if (flush) {
			this.clearTimer(chatId);
			this.launch(chatId);
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
				() => this.launch(chatId),
				Math.max(0, Math.min(earliest, latest) - now),
			),
		);
	}
	private launch(chatId: number): void {
		if (this.stopped) return;
		const refresh = this.pending.get(chatId);
		if (!refresh) return;
		this.clearTimer(chatId);
		this.pending.delete(chatId);
		this.queuedAt.delete(chatId);
		this.lastRun.set(chatId, this.clock());
		const execution = this.run(refresh);
		const jobs = this.executions.get(chatId) ?? new Set<Promise<void>>();
		jobs.add(execution);
		this.executions.set(chatId, jobs);
		void execution.then(
			() => this.finish(chatId, execution),
			() => this.finish(chatId, execution),
		);
	}
	private finish(chatId: number, execution: Promise<void>): void {
		const jobs = this.executions.get(chatId);
		jobs?.delete(execution);
		if (!jobs?.size) this.executions.delete(chatId);
	}
	private async run(refresh: () => Promise<void>): Promise<void> {
		try {
			await refresh();
		} catch (error) {
			try {
				this.onError(error);
			} catch {
				// Error reporting must not escape the scheduler task.
			}
		}
	}

	private clearTimer(chatId: number): void {
		const timer = this.timers.get(chatId);
		if (timer) clearTimeout(timer);
		this.timers.delete(chatId);
	}
}
