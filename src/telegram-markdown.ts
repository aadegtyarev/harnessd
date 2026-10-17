import { escapeHtml } from "./error-diagnostics.js";

/**
 * Render assistant Markdown as Telegram HTML (parse_mode HTML).
 *
 * Fenced code blocks become `<pre>`; outside them, block rules (headings,
 * pipe tables, bullets, blockquotes, horizontal rules) are applied per line
 * and inline rules (code, links, emphasis) inside each line. Every piece of
 * source text is HTML-escaped; only the tags produced here are emitted.
 */
export function renderTelegramMarkdown(body: string): string {
	let html = "";
	let textStart = 0;
	let atLineStart = true;
	for (let offset = 0; offset < body.length; ) {
		const remaining = body.slice(offset);
		const fence = remaining.match(FENCE);
		if (fence) {
			html += renderBlocks(body.slice(textStart, offset), atLineStart);
			html += `<pre>${escapeHtml(fence[1] ?? "")}</pre>`;
			offset += fence[0].length;
			textStart = offset;
			atLineStart = false;
			continue;
		}
		// Backticks inside inline code never open a fence.
		const inlineCode = remaining.match(INLINE_CODE);
		offset += inlineCode ? inlineCode[0].length : 1;
	}
	return html + renderBlocks(body.slice(textStart), atLineStart);
}

const FENCE = /^```[^\n]*\n([\s\S]*?)```/;
const INLINE_CODE = /^`([^`\n]+)`/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(\S.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const SEPARATOR_CELL = /^:?-+:?$/;

/**
 * Apply block rules to a fence-free text segment. When the segment begins
 * mid-line (right after a closing fence), its first line gets inline rules only.
 */
function renderBlocks(text: string, atLineStart: boolean): string {
	if (!text) return "";
	const lines = text.split("\n");
	const out: string[] = [];
	let index = 0;
	if (!atLineStart) {
		out.push(renderInline(lines[0] ?? ""));
		index = 1;
	}
	while (index < lines.length) {
		const line = lines[index] ?? "";
		const table = parseTable(lines, index);
		if (table) {
			out.push(...table.rows);
			index = table.next;
			continue;
		}
		if (QUOTE.test(line)) {
			const quoted: string[] = [];
			while (index < lines.length) {
				const match = (lines[index] ?? "").match(QUOTE);
				if (!match) break;
				quoted.push(renderLine(match[1] ?? ""));
				index++;
			}
			out.push(
				quoted.some(Boolean)
					? `<blockquote>${quoted.join("\n")}</blockquote>`
					: "",
			);
			continue;
		}
		out.push(renderLine(line));
		index++;
	}
	return out.join("\n");
}

/** Single-line block rules: rule, heading, bullet, otherwise inline only. */
function renderLine(line: string): string {
	if (RULE.test(line)) return "";
	const heading = line.match(HEADING);
	if (heading?.[1]) return `<b>${withoutBold(renderInline(heading[1]))}</b>`;
	const bullet = line.match(BULLET);
	if (bullet) {
		const indent = (bullet[1] ?? "").replace(/\t/g, "    ").length;
		const depth = Math.floor(indent / 2);
		return `${"  ".repeat(depth)}• ${renderInline(bullet[2] ?? "")}`;
	}
	return renderInline(line);
}

/**
 * Recognize a pipe table at `start`: a header row, a separator with the same
 * column count, then consecutive pipe-containing rows. Returns undefined for
 * anything malformed so the lines stay ordinary text.
 */
function parseTable(
	lines: readonly string[],
	start: number,
): { rows: string[]; next: number } | undefined {
	const headerLine = lines[start] ?? "";
	const separatorLine = lines[start + 1] ?? "";
	if (!headerLine.includes("|") || !separatorLine.includes("|"))
		return undefined;
	const header = splitCells(headerLine);
	const separator = splitCells(separatorLine);
	if (
		header.length === 0 ||
		separator.length !== header.length ||
		!separator.every((cell) => SEPARATOR_CELL.test(cell))
	)
		return undefined;
	const rows: string[] = [];
	let index = start + 2;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (!line.includes("|") || !line.trim()) break;
		const row = renderRow(header, splitCells(line));
		if (row) rows.push(row);
		index++;
	}
	if (rows.length === 0) return undefined;
	return { rows, next: index };
}

function renderRow(
	header: readonly string[],
	cells: readonly string[],
): string | undefined {
	const [first = "", ...rest] = cells;
	const label = first ? `<b>${withoutBold(renderInline(first))}</b>` : "";
	const values: string[] = [];
	for (const [offset, cell] of rest.entries()) {
		if (!cell) continue;
		const value = renderInline(cell);
		const name = header[offset + 1] ?? "";
		values.push(
			header.length > 2 && name ? `${renderInline(name)}: ${value}` : value,
		);
	}
	const details = values.join("; ");
	if (!label && !details) return undefined;
	return `• ${label}${label && details ? " — " : ""}${details}`;
}

/** Split a table row on unescaped pipes outside inline code; trims cells. */
function splitCells(line: string): string[] {
	let source = line.trim();
	if (source.startsWith("|")) source = source.slice(1);
	if (source.endsWith("|") && !source.endsWith("\\|"))
		source = source.slice(0, -1);
	const cells: string[] = [];
	let cell = "";
	for (let offset = 0; offset < source.length; ) {
		const code = source.slice(offset).match(INLINE_CODE);
		if (code) {
			cell += code[0];
			offset += code[0].length;
			continue;
		}
		const character = source[offset] ?? "";
		if (character === "\\" && source[offset + 1] === "|") {
			cell += "|";
			offset += 2;
			continue;
		}
		if (character === "|") {
			cells.push(cell.trim());
			cell = "";
		} else cell += character;
		offset++;
	}
	cells.push(cell.trim());
	return cells;
}

/** Drop generated bold tags so a bold wrapper does not nest them. */
function withoutBold(html: string): string {
	return html.replace(/<\/?b>/g, "");
}

/** Inline rules for one line: inline code, safe links, emphasis. */
export function renderInline(text: string): string {
	let html = "";
	for (let offset = 0; offset < text.length; ) {
		const remaining = text.slice(offset);
		const inlineCode = remaining.match(INLINE_CODE);
		if (inlineCode) {
			html += `<code>${escapeHtml(inlineCode[1] ?? "")}</code>`;
			offset += inlineCode[0].length;
			continue;
		}
		const link = remaining.match(/^\[([^\]\n]+)\]\(([^()\n]+)\)/);
		if (link) {
			const href = (link[2] ?? "").trim();
			html += isSafeHref(href)
				? `<a href="${escapeHtml(href)}">${escapeHtml(link[1] ?? "")}</a>`
				: escapeHtml(link[1] ?? link[0]);
			offset += link[0].length;
			continue;
		}
		const emphasis = remaining.match(/^(\*\*|__|~~|\*|_)([^*_~\n]+?)\1/);
		if (emphasis) {
			const marker = emphasis[1] ?? "";
			const tag = marker === "~~" ? "s" : marker.length === 2 ? "b" : "i";
			html += `<${tag}>${escapeHtml(emphasis[2] ?? "")}</${tag}>`;
			offset += emphasis[0].length;
			continue;
		}
		const point = String.fromCodePoint(text.codePointAt(offset) ?? 0);
		html += escapeHtml(point);
		offset += point.length;
	}
	return html;
}

function isSafeHref(href: string): boolean {
	try {
		return ["http:", "https:", "mailto:"].includes(new URL(href).protocol);
	} catch {
		/* Malformed destinations remain readable, non-clickable text. */
		return false;
	}
}
