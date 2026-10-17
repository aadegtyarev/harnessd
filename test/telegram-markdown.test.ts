import { describe, expect, it } from "vitest";
import {
	isTelegramParseError,
	renderTelegramMarkdown,
	telegramHtmlToPlainText,
} from "../src/telegram-markdown.js";

const md = (...lines: string[]) => renderTelegramMarkdown(lines.join("\n"));

describe("Telegram Markdown blocks", () => {
	it("renders the operator screenshot shape", () => {
		expect(
			md(
				"### Что сделано",
				"",
				"| Параметр | Значение |",
				"|---|---|",
				"| **Ветка** | `fix/telegram` |",
				"| **Тесты** | 12 прошли, **0** упало |",
				"",
				"### Дальше",
				"",
				"1. **Проверить** деплой",
				"2. Обновить README",
			),
		).toBe(
			[
				"<b>Что сделано</b>",
				"",
				"• <b>Ветка</b> — <code>fix/telegram</code>",
				"• <b>Тесты</b> — 12 прошли, <b>0</b> упало",
				"",
				"<b>Дальше</b>",
				"",
				"1. <b>Проверить</b> деплой",
				"2. Обновить README",
			].join("\n"),
		);
	});

	it("finishes on a fence glued to a quote marker", () => {
		// «>```» is not a quote line; it used to keep the renderer from advancing.
		for (const input of [">```\ncode\n```", "a\n>```\nx", ">```", "> a\n>```"])
			expect(typeof renderTelegramMarkdown(input)).toBe("string");
	});

	it("renders headings of every level without the marker", () => {
		for (const marker of ["#", "##", "###", "####", "#####", "######"])
			expect(md(`${marker} Title *x* ##`)).toBe("<b>Title <i>x</i></b>");
		expect(md("## **Bold** heading")).toBe("<b>Bold heading</b>");
		expect(md("####### seven")).toBe("####### seven");
	});

	it("keeps hashtags and a bare marker as text", () => {
		expect(md("#hashtag text")).toBe("#hashtag text");
		expect(md("#")).toBe("#");
		expect(md("text # not heading")).toBe("text # not heading");
	});

	it("renders 3+ column tables with header names and skips empty cells", () => {
		expect(
			md(
				"Name | Status | Note",
				":--- | :---: | ---:",
				"`api` | ok | [docs](https://example.com) ",
				"**web** |  | slow",
				"|  | x |  |",
			),
		).toBe(
			[
				'• <b><code>api</code></b> — Status: ok; Note: <a href="https://example.com">docs</a>',
				"• <b>web</b> — Note: slow",
				"• Status: x",
			].join("\n"),
		);
	});

	it("does not nest bold when the first cell is partly bold", () => {
		expect(md("| a | b |", "|---|---|", "| **x** y | z |")).toBe(
			"• <b>x y</b> — z",
		);
	});

	it("handles escaped pipes and pipes inside inline code", () => {
		expect(md("| k | v |", "|-|-|", "| a\\|b | `x | y` |")).toBe(
			"• <b>a|b</b> — <code>x | y</code>",
		);
	});

	it("ends a table at the first line without a pipe", () => {
		expect(md("| a | b |", "|---|---|", "| 1 | 2 |", "after")).toBe(
			"• <b>1</b> — 2\nafter",
		);
	});

	it("leaves malformed tables and prose pipes as text", () => {
		expect(md("| a | b |", "| 1 | 2 |")).toBe("| a | b |\n| 1 | 2 |");
		expect(md("| a | b |", "|---|---|---|", "| 1 | 2 |")).toBe(
			"| a | b |\n|---|---|---|\n| 1 | 2 |",
		);
		expect(md("| a | b |", "|---|---|")).toBe("| a | b |\n|---|---|");
		expect(md("use a | b here")).toBe("use a | b here");
	});

	it("turns bullets into dots and keeps nesting", () => {
		expect(
			md("- one", "* two *it*", "+ three", "  - nested", "    * deeper"),
		).toBe(
			[
				"• one",
				"• two <i>it</i>",
				"• three",
				"  • nested",
				"    • deeper",
			].join("\n"),
		);
		expect(md("*italic* start")).toBe("<i>italic</i> start");
		expect(md("**bold** start")).toBe("<b>bold</b> start");
	});

	it("merges consecutive quote lines into one blockquote", () => {
		expect(md("> first **b**", ">", "> - item", "> 5 items", "after")).toBe(
			"<blockquote>first <b>b</b>\n\n• item\n5 items</blockquote>\nafter",
		);
		expect(md("> one", "", "> two")).toBe(
			"<blockquote>one</blockquote>\n\n<blockquote>two</blockquote>",
		);
		expect(md("> quote", ">no space")).toBe(
			"<blockquote>quote</blockquote>\n&gt;no space",
		);
	});

	it("keeps comparison-like lines as prose", () => {
		expect(md("> 5 items", ">= 3", "> =x", ">", "> ")).toBe(
			"&gt; 5 items\n&gt;= 3\n&gt; =x\n&gt;\n&gt; ",
		);
	});

	it("renders a fence inside a quote as code within the blockquote", () => {
		expect(
			md("intro", "> see:", "> ```", "> - x | y", "> ```", "> done", "after"),
		).toBe(
			"intro\n<blockquote>see:\n<pre>- x | y\n</pre>\ndone</blockquote>\nafter",
		);
		expect(md("> ```", "> unclosed")).toBe(
			"<blockquote><pre>unclosed</pre></blockquote>",
		);
	});

	it("treats an unclosed fence as code to the end of the message", () => {
		expect(
			md(
				"# Title",
				"```ts",
				"### not heading",
				"| a | b |",
				"|---|---|",
				"- x",
			),
		).toBe(
			"<b>Title</b>\n<pre>### not heading\n| a | b |\n|---|---|\n- x</pre>",
		);
		expect(md("use ``` inline", "- item")).toBe("use ``` inline\n• item");
		expect(md("text", "```")).toBe("text\n```");
	});

	it("normalizes CRLF line endings before block rules", () => {
		expect(
			renderTelegramMarkdown(
				"### Head\r\n| a | b |\r\n|---|---|\r\n| x | y |\r\n> q\r\n- i\r\n```\r\ncode\r\n```",
			),
		).toBe(
			"<b>Head</b>\n• <b>x</b> — y\n<blockquote>q</blockquote>\n• i\n<pre>code\n</pre>",
		);
	});

	it("keeps inline code inside bold headings and first cells", () => {
		expect(md("## `config.json` layout")).toBe(
			"<b><code>config.json</code> layout</b>",
		);
		expect(md("| key | value |", "|---|---|", "| `PORT` | 8080 |")).toBe(
			"• <b><code>PORT</code></b> — 8080",
		);
	});

	it("removes horizontal rules", () => {
		expect(md("a", "---", "b", "***", "c", "___", "d", "- - -")).toBe(
			"a\n\nb\n\nc\n\nd\n",
		);
	});

	it("leaves code fences and inline code untouched", () => {
		expect(
			md(
				"```",
				"### not heading",
				"| a | b |",
				"|---|---|",
				"- item",
				"> quote",
				"---",
				"```",
				"`# x | y`",
			),
		).toBe(
			"<pre>### not heading\n| a | b |\n|---|---|\n- item\n&gt; quote\n---\n</pre>\n<code># x | y</code>",
		);
		expect(md("text ```js", "- a", "``` - tail", "- b")).toBe(
			"text <pre>- a\n</pre> - tail\n• b",
		);
	});

	it("escapes all text inside generated blocks", () => {
		const html = md(
			'# <script>alert("x")</script>',
			"| <b> | &amp; |",
			"|---|---|",
			"| <i>x</i> | [bad](javascript:void) |",
			"> <a href=x>",
			"- <img src=x>",
		);
		expect(html).toBe(
			[
				"<b>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</b>",
				"• <b>&lt;i&gt;x&lt;/i&gt;</b> — bad",
				"<blockquote>&lt;a href=x&gt;</blockquote>",
				"• &lt;img src=x&gt;",
			].join("\n"),
		);
	});

	it("turns rendered HTML back into readable plain text", () => {
		expect(
			telegramHtmlToPlainText(
				'<b>T</b> &lt;x&gt; &amp;amp; &quot;q&quot; &#39;a&#39; &#x1F642; <a href="https://e.com">l</a> &#99999999;',
			),
		).toBe("T <x> &amp; \"q\" 'a' 🙂 l &#99999999;");
	});

	it("recognizes only Telegram entity parse errors", () => {
		expect(
			isTelegramParseError({
				error_code: 400,
				description: "Bad Request: can't parse entities: Unexpected end tag",
			}),
		).toBe(true);
		expect(
			isTelegramParseError({
				error_code: 400,
				description: "Bad Request: chat not found",
			}),
		).toBe(false);
		expect(
			isTelegramParseError({
				error_code: 429,
				description: "can't parse entities",
			}),
		).toBe(false);
		expect(isTelegramParseError(new Error("can't parse entities"))).toBe(false);
		expect(isTelegramParseError(undefined)).toBe(false);
	});
});
