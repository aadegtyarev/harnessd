import { describe, expect, it } from "vitest";
import { stripModelOutputGarbageTail } from "../src/telegram-model-output-sanitizer.js";

describe("stripModelOutputGarbageTail", () => {
	it("removes the screenshot signature after Russian body text", () => {
		expect(
			stripModelOutputGarbageTail(
				"Ответ готов\n\nxx\nhidden.\nStop.\nNo.\nEnd.",
			),
		).toBe("Ответ готов");
	});

	it("accepts CRLF and blank lines, including a garbage-only message", () => {
		expect(
			stripModelOutputGarbageTail(
				"Ответ\r\n\r\nxx\r\n\r\nhidden.\r\nStop.\r\nNo.\r\nEnd.",
			),
		).toBe("Ответ");
		expect(stripModelOutputGarbageTail("xx\nhidden.\nStop.\nNo.\nDone.")).toBe(
			"",
		);
	});

	it.each([
		"Body\nxx\nhidden.\nStop.\nNo.\nEnd.\nMore text",
		"```text\nxx\nhidden.\nStop.\nNo.\nEnd.\n```",
		"```text\nxx\nhidden.\nStop.\nNo.\nEnd.",
		"```text\n```not-close\nxx\nhidden.\nStop.\nNo.\nEnd.",
		"```text\r\n```not-close\r\nxx\r\nhidden.\r\nStop.\r\nNo.\r\nEnd.",
		"~~~text\n~~~not-close\nxx\nhidden.\nStop.\nNo.\nEnd.",
		"~~~text\r\n~~~not-close\r\nxx\r\nhidden.\r\nStop.\r\nNo.\r\nEnd.",
		"Body\nxx\nhidden.\nStop.\nNo.",
		"Body\nxx\nhidden.\nStop.\nNo.\nUnknown.",
		"At 500. is the legitimate limit.",
		"Body\nXX\nhidden.\nStop.\nNo.\nEnd.",
	])("preserves lookalike or incomplete text unchanged: %s", (text) => {
		expect(stripModelOutputGarbageTail(text)).toBe(text);
	});

	it("does not remove a signature-looking sequence in the middle", () => {
		const text = "Body\nxx\nhidden.\nStop.\nNo.\nEnd.\nnormal ending";
		expect(stripModelOutputGarbageTail(text)).toBe(text);
	});
});
