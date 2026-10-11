# Feature: bottom-anchored Telegram UX with a live run card

Status: approved by the operator (2026-10-11); delivered in three PRs.

## Goal

Everything the operator needs stays at the bottom of the chat; nothing requires scrolling up to a pinned message. The operator can see where a long run is heading without asking for status.

## Phase 1 — controls (PR #51)

- A persistent reply keyboard under the input field: `📊 Ход`, `📋 Панель`, `✋ Прервать`, `🗂 Сессии`. It is sent before the `/start` welcome and with the first `📋` in a process; `/menu` keeps refreshing the panel in place.
- Button presses are handled as commands and the operator's button message is deleted (best effort). `📊` shows status (phase 2: the run card), `📋` shows the panel, `✋` asks for confirmation and then cancels the current input, `🗂` lists sessions.
- `📋` publishes a fresh panel at the bottom and deletes the previous panel message; panels are no longer pinned. Automatic refreshes keep editing the current panel in place.
- Mid-run assistant messages are sent without notification sound; the answer delivered at run settlement keeps the sound.

## Phase 2 — run card (this PR)

One live card per run and chat, always the last message: header state (working / waiting for agents / needs you / done / error) with elapsed time, task goal and latest progress from `/task`, the latest model thought (reasoning-summary title, ≤160 chars, never full reasoning), the last five events (bash with exit code and duration), and the usage line. Card buttons `📋 Отчёт` and `⛔ Прервать` (from claude-orchestrator); repeated reads/edits collapse; elapsed time has minute resolution so the card is not re-edited every second; a delivered mid-run answer freezes the card in place and opens a new one below (frozen pieces are deleted at the end); collapses to a one-line summary at run end. Deferred: sound when attention is needed.

## Phase 3 — agents section (final PR)

One row per subagent run (parallel runs are separate rows), workflow steps indented under their parent, states queued/running/paused/asking/complete/partial/failed/stopped, elapsed time, current tool, reviewer verdict for finished reviewers, at most six rows with running/asking first, and "the parent waits for: …". Snapshot state `complete` is recognized.

## Non-goals

Mini App, changes to session semantics, per-user ownership.

## Affected surfaces

- [Telegram transport](../surfaces/telegram-transport.md)
- [Pi RPC harness](../surfaces/pi-rpc-harness.md) (phases 2–3: thought, task, and tool-result events)

## Acceptance

Each phase: tests for its scenarios, all gates (`npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, `git diff --check`), independent review, deploy.
