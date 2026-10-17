# Feature contract: `/menu` publishes the panel at the bottom

**Status:** approved (2026-10-17)

## Goal

`/menu` behaves like the `📋 Панель` button: the operator always gets the control panel as the latest message instead of an edit of an older panel far up the chat. Panels stay unpinned.

## Scenarios

- `/menu` and the `/start` welcome "panel" action publish a fresh panel at the bottom through the same path as `📋` (`showPanelAtBottom`). Only after the new panel is confirmed is the previous one retired and deleted. The operator's `/menu` message is deleted best effort, as for the button.
- If deleting the previous panel fails (for example, it is older than 48 hours), it is edited to the short note «Панель перенесена ниже ↓» with no buttons (empty inline keyboard). If that also fails, its taps keep answering that the panel is outdated and refresh the current panel (existing behaviour). The delete is checked, not fire-and-forget.
- If the new panel is not confirmed, the previous panel remains the panel; no duplicate is left.
- Repeated or concurrent `/menu`/`📋` in one chat yield exactly one current panel at the bottom; the previous panel is never edited by a superseded publication. Known race to fix: call #1 detaches the panel reference, call #2 begins a newer intent and makes #1 stale, #1 restores `previous`, and #2's render then edits the old panel. Bottom publishes are serialized per chat (or the restore is otherwise suppressed while a newer bottom publish is in flight).
- Automatic refreshes (preview refreshes, live status after resume/stop/delete/settle), in-panel navigation (`menu:*`), the stale-notice Refresh, and restart restore keep editing the current panel in place.

## Non-goals

Pinning; detecting whether the panel is already the last message; panel layout or session-behaviour changes.

## Affected surface contracts

- [Telegram transport and CLI](../surfaces/telegram-transport.md) — session panel section (`/menu` no longer "refreshes in place").

## Interfaces and constraints

- No new Telegram API methods beyond `sendMessage`, `deleteMessage`, and `editMessageText` already in use.
- Retired panel IDs stay bounded per chat; no persistence or schema change.

## Acceptance criteria

- `/menu` with a stored panel sends a new panel and deletes the old message ID; no edit targets the old ID.
- A failed delete edits the old message to the note with an empty inline keyboard.
- Concurrent `/menu` + `📋` leave one stored panel, and the old panel receives no text edit other than the retirement note.
- A live-status refresh after `/menu` edits the new panel ID.
- Updated restart, welcome, and menu tests pass; `pinned` stays empty.

## Validation

`npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, `git diff --check`.
