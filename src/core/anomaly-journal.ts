import type { HarnessAnomaly, SessionId } from "./types.js";

/** Journal lines allowed per session and anomaly kind in one window before flood suppression. */
const FLOOD_LIMIT = 30;
const FLOOD_WINDOW_MS = 60_000;

interface KindWindow {
	startedAt: number;
	written: number;
	suppressed: number;
}

/**
 * Writes one `harnessd:` journal line per harness anomaly. Only floods are limited:
 * past {@link FLOOD_LIMIT} lines per minute for one session and kind, lines are counted
 * and the next written line reports how many were suppressed.
 */
export class AnomalyJournal {
	private readonly windows = new Map<string, KindWindow>();

	constructor(
		private readonly write: (line: string) => void,
		private readonly now: () => number = Date.now,
	) {}

	record(sessionId: SessionId, anomaly: HarnessAnomaly): void {
		const key = `${sessionId}\u0000${anomaly.kind}`;
		const now = this.now();
		let window = this.windows.get(key);
		if (!window || now - window.startedAt >= FLOOD_WINDOW_MS) {
			window = {
				startedAt: now,
				written: 0,
				suppressed: window?.suppressed ?? 0,
			};
			this.windows.set(key, window);
		}
		if (window.written >= FLOOD_LIMIT) {
			window.suppressed++;
			return;
		}
		window.written++;
		const suppressed = window.suppressed;
		window.suppressed = 0;
		this.write(formatAnomalyLine(sessionId, anomaly, suppressed));
	}

	forget(sessionId: SessionId): void {
		for (const key of this.windows.keys())
			if (key.startsWith(`${sessionId}\u0000`)) this.windows.delete(key);
	}
}

export function formatAnomalyLine(
	sessionId: SessionId,
	anomaly: HarnessAnomaly,
	suppressed = 0,
): string {
	const fields = [
		`harnessd: session ${sessionId} harness_anomaly kind=${anomaly.kind}`,
		`action=${anomaly.action}`,
		`running=${anomaly.harnessRunning ? "yes" : "no"}`,
		`ref=${token(anomaly.ref)}`,
		...(anomaly.recordType ? [`type=${token(anomaly.recordType)}`] : []),
		...(anomaly.command ? [`command=${token(anomaly.command)}`] : []),
		...(anomaly.bytes !== undefined ? [`bytes=${anomaly.bytes}`] : []),
		...(suppressed ? [`suppressed=${suppressed}`] : []),
		...(anomaly.detail ? [`detail=${JSON.stringify(anomaly.detail)}`] : []),
		...(anomaly.head ? [`head=${JSON.stringify(anomaly.head)}`] : []),
	];
	return fields.join(" ");
}

/** Keep a field on one journal line even if an adapter supplied an odd value. */
function token(value: string): string {
	return /^[A-Za-z0-9_:.-]{1,64}$/.test(value)
		? value
		: JSON.stringify(value.slice(0, 64));
}
