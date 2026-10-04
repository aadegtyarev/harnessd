import { describe, expect, it } from "vitest";
import { describeError } from "../src/error-diagnostics.js";

describe("error diagnostics", () => {
	it("preserves stack and causes while redacting tokens and sensitive assignments", () => {
		const token = "123456:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
		const error = new Error(`request failed with token=${token}`, {
			cause: new TypeError("database password=hunter2 was rejected"),
		});
		const diagnostic = describeError(
			new Error("Authorization: Bearer abc123-private", { cause: error }),
			[token],
		);
		expect(diagnostic).toContain("Error: request failed");
		expect(diagnostic).toContain("Caused by: TypeError: database");
		expect(diagnostic).not.toContain(token);
		expect(diagnostic).not.toContain("hunter2");
		expect(diagnostic).not.toContain("abc123-private");
		expect(diagnostic).not.toContain("Bearer");
	});

	it("redacts credentials from process environment", () => {
		const key = "HARNESSD_TEST_SECRET";
		process.env[key] = "local-secret-value";
		try {
			expect(
				describeError(new Error("failed local-secret-value")),
			).not.toContain("local-secret-value");
		} finally {
			delete process.env[key];
		}
	});
});
