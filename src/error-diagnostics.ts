const SECRET_ASSIGNMENT =
	/((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const TELEGRAM_BOT_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;
const AUTHORIZATION_ASSIGNMENT =
	/(\bauthorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi;
const SECRET_MARKER = /\bSECRET_[A-Z0-9_]+\b/gi;

/** Render an exception with causes and stack frames, while removing known secrets. */
export function describeError(
	error: unknown,
	redactions: readonly (string | undefined)[] = [],
	includeCauses = true,
): string {
	const seen = new Set<unknown>();
	const lines: string[] = [];
	const visit = (value: unknown, label: string, depth: number): void => {
		if (depth > 5 || seen.has(value)) return;
		if (value && (typeof value === "object" || typeof value === "function"))
			seen.add(value);
		if (value instanceof Error) {
			lines.push(
				`${label}: ${value.stack ?? `${value.name}: ${value.message}`}`,
			);
			if (includeCauses && value.cause !== undefined)
				visit(value.cause, "Caused by", depth + 1);
			if (includeCauses && value instanceof AggregateError)
				for (const [index, cause] of [...value.errors].entries())
					visit(cause, `Contained error ${index + 1}`, depth + 1);
		} else {
			let rendered: string;
			try {
				rendered = typeof value === "string" ? value : JSON.stringify(value);
			} catch {
				rendered = String(value);
			}
			lines.push(`${label}: ${rendered ?? String(value)}`);
		}
	};
	visit(error, "Error", 0);
	return redactDiagnosticText(lines.join("\n"), redactions);
}

export function redactDiagnosticText(
	value: string,
	redactions: readonly (string | undefined)[] = [],
): string {
	let result = value;
	const environmentSecrets = Object.entries(process.env)
		.filter(([key]) =>
			/(?:token|secret|password|credential|api[_-]?key|authorization)/i.test(
				key,
			),
		)
		.map(([, value]) => value);
	for (const secret of [...redactions, ...environmentSecrets]) {
		if (secret && secret.length >= 3)
			result = result.replaceAll(secret, "[REDACTED]");
	}
	return result
		.replace(SECRET_MARKER, "[REDACTED]")
		.replace(TELEGRAM_BOT_TOKEN, "[REDACTED_TELEGRAM_BOT_TOKEN]")
		.replace(AUTHORIZATION_ASSIGNMENT, "$1[REDACTED]")
		.replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
		.slice(0, 24_000);
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

/** Bound text without splitting a UTF-16 surrogate pair. */
export function truncateDiagnostic(value: string, limit: number): string {
	if (value.length <= limit) return value;
	let end = Math.max(0, limit - 18);
	if (/^[\uDC00-\uDFFF]$/.test(value[end] ?? "")) end--;
	return `${value.slice(0, end)}\n… [truncated]`;
}
