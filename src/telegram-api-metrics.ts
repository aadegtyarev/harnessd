import type { Transformer } from "grammy";

const METHODS = [
	"getMe",
	"getUpdates",
	"setMyCommands",
	"sendMessage",
	"editMessageText",
	"deleteMessage",
	"sendChatAction",
	"setMessageReaction",
	"answerCallbackQuery",
	"getFile",
	"sendDocument",
	"pinChatMessage",
	"unpinChatMessage",
	"other",
] as const;
type Method = (typeof METHODS)[number];
type Counts = {
	started: number;
	ok: number;
	rateLimited: number;
	rejected: number;
	failed: number;
};
const empty = (): Counts => ({
	started: 0,
	ok: 0,
	rateLimited: 0,
	rejected: 0,
	failed: 0,
});
const increment = (n: number): number =>
	Math.min(Number.MAX_SAFE_INTEGER, n + 1);

/** Fixed-cardinality raw Bot API attempt metrics; never inspect payload or error details. */
export class TelegramApiMetrics {
	private readonly counts = new Map<Method, Counts>();
	private inFlight = 0;
	private peak = 0;
	private second = -1;
	private secondStarts = 0;
	private peakStartsPerSecond = 0;
	private stopped = false;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly sink: (line: string) => void = (line) =>
			console.error(line),
	) {
		this.timer = setInterval(() => this.flush(), 60_000);
		this.timer.unref();
	}

	readonly transformer: Transformer = async (prev, method, payload, signal) => {
		if (this.stopped) return prev(method, payload, signal);
		const key: Method = METHODS.includes(method as Method)
			? (method as Method)
			: "other";
		const counters = this.counts.get(key) ?? empty();
		this.counts.set(key, counters);
		counters.started = increment(counters.started);
		const second = Math.floor(Date.now() / 1000);
		if (second !== this.second) {
			this.second = second;
			this.secondStarts = 0;
		}
		this.secondStarts = increment(this.secondStarts);
		this.peakStartsPerSecond = Math.max(
			this.peakStartsPerSecond,
			this.secondStarts,
		);
		this.inFlight = increment(this.inFlight);
		this.peak = Math.max(this.peak, this.inFlight);
		try {
			const response = await prev(method, payload, signal);
			if (!this.stopped) {
				const current = this.getCounts(key);
				if (response.ok) current.ok = increment(current.ok);
				else if (response.error_code === 429)
					current.rateLimited = increment(current.rateLimited);
				else current.rejected = increment(current.rejected);
			}
			return response;
		} catch (error) {
			if (!this.stopped) {
				const current = this.getCounts(key);
				current.failed = increment(current.failed);
			}
			throw error;
		} finally {
			this.inFlight = Math.max(0, this.inFlight - 1);
		}
	};

	private getCounts(method: Method): Counts {
		const counters = this.counts.get(method) ?? empty();
		this.counts.set(method, counters);
		return counters;
	}

	private flush(): void {
		if (this.stopped || !this.counts.size) return;
		const methods = Object.fromEntries(this.counts);
		this.counts.clear();
		const peak = this.peak;
		const peakStarts = this.peakStartsPerSecond;
		this.peak = this.inFlight;
		this.peakStartsPerSecond = 0;
		this.second = -1;
		this.secondStarts = 0;
		try {
			this.sink(
				`harnessd: telegram_api_metrics ${JSON.stringify({ peak_in_flight: peak, peak_starts_per_second: peakStarts, methods })}`,
			);
		} catch {
			/* Diagnostics must not affect API calls. */
		}
	}

	stop(): void {
		if (this.stopped) return;
		this.flush();
		this.stopped = true;
		clearInterval(this.timer);
		this.counts.clear();
	}
}
