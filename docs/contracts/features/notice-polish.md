# Feature contract: notice polish after 0.3.2

Status: approved by the owner 2026-10-19; in implementation.

## Goal

Remove the remaining noise and fragility in session failure/anomaly messages left after 0.3.2.

## Scenarios

1. **No notice for intentional stops.** A record cut off while harnessd itself is stopping the instance (operator `/stop`, delete, option relaunch, service shutdown) produces a journal line only, no chat message.
2. **Harness-neutral stop wording.** The fatal-stop chat message names the session's harness generically («Процесс сессии остановлен: …») or by its adapter label, never «Pi» for a non-Pi session.
3. **Structured reasons, not string matching.** The harness reports input-not-delivered and stop reasons with a fixed reason code carried on the event/error (for example `prompt_rejected`, `hold_timeout`, `held_and_stopped`, `canceled`, `process_exited`, `stream_corrupted`). Telegram picks Russian text by code; the English detail stays only as journal/fallback. Shared constants, no duplicated literals. The live run-card status reflects the actual reason (a user cancel or hold timeout is not shown as «Pi не принял сообщение»).
4. **Compaction recheck window.** A held input stays marked held until the `get_state` recheck finishes, so a Pi stop in that window reports it consistently as not delivered and a cancel in that window succeeds.

## Non-goals

New notices, behavior changes outside these messages, Pi changes.

## Affected surface contracts

[Pi RPC harness](../surfaces/pi-rpc-harness.md), [Telegram transport](../surfaces/telegram-transport.md), [core session management](../surfaces/core-session-management.md) if the event type gains a reason field; [package release](../surfaces/package-release.md): 0.3.3.

## Acceptance criteria

- Cut record during an operator stop: journal line, no chat message.
- Stop message for a claude-code session contains no «Pi».
- Telegram tests drive reasons by code; changing an English detail string does not change Russian chat text.
- Cancel during the recheck window succeeds; Pi stop in that window reports not delivered (not uncertain).
- Run-card status for cancel and hold timeout matches the reason.

## Validation

`npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, `git diff --check`; independent review before merge.
