import { randomUUID } from "node:crypto";
import type { HarnessAnomaly } from "../core/types.js";
import {
	redactDiagnosticText,
	truncateDiagnostic,
} from "../error-diagnostics.js";

/** Characters of an oversized line kept for type/ID extraction; the rest is discarded. */
export const OVERSIZED_HEAD_CHARS = 16 * 1024;
/** Longest redacted record head journaled for a non-oversized anomaly. */
const ANOMALY_HEAD_CHARS = 300;
/** Longest redacted detail (for example Pi's own error text) carried by an anomaly. */
const ANOMALY_DETAIL_CHARS = 300;
/** More consecutive stream anomalies than this, without a valid record, mean a corrupted stream. */
export const MAX_CONSECUTIVE_ANOMALIES = 20;

/** A short token such as a record type or command name, or undefined when unsafe. */
export function safeToken(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9_:.-]{1,64}$/.test(value)
		? value
		: undefined;
}

export function anomalyText(
	value: string,
	redactions: readonly (string | undefined)[],
	limit = ANOMALY_HEAD_CHARS,
): string {
	// Pre-bound at a delimiter so a cut-off secret is dropped rather than half-shown,
	// then redact before the final bound.
	let window = value.slice(0, limit * 4);
	if (value.length > window.length)
		window = window.replace(/[^\s,"{}:[\]]*$/u, "");
	return truncateDiagnostic(
		redactDiagnosticText(window, redactions)
			.replace(/[\p{Cc}\p{Cf}]/gu, " ")
			.trim(),
		limit,
	);
}

export function anomalyDetail(
	value: string,
	redactions: readonly (string | undefined)[],
): string {
	return anomalyText(value, redactions, ANOMALY_DETAIL_CHARS);
}

/** Build an anomaly report with a fresh correlation reference. */
export function anomaly(fields: Omit<HarnessAnomaly, "ref">): HarnessAnomaly {
	return { ...fields, ref: randomUUID().slice(0, 8) };
}
