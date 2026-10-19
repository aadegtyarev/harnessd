# Feature contract: tolerate Pi RPC anomalies and report them

Status: approved by the owner 2026-10-19; in implementation. Ships in 0.3.1 together with the panel rename button.

## Goal and user-visible behavior

A long Pi run no longer gets its Pi process killed at the end. Every RPC anomaly harnessd meets is skipped or handled without killing a healthy Pi, and is reported both to the journal and to the owner's chat in plain Russian, so it can be understood and debugged.

Incident: a 38-minute run (167 messages, ~1.4 MB) ended at the exact second harnessd killed Pi with "Malformed or oversized Pi RPC stdout record". Pi's `agent_end` event carries every message of the run on one line; harnessd's 1 MiB record cap treated it as fatal. Every other protocol check is also fatal today, and the journal does not say which one fired.

## Scenarios

1. **Oversized lines are streamed, not collected.** Lines up to the existing cap (1 MiB default) are parsed in full as now. For a longer line harnessd keeps only a bounded head (enough for the event `type` and identifiers), discards the rest as it arrives without buffering it, and then handles the event from the head:
   - `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`: handled by type as today (status events, settlement), so the run ends normally and its answer is delivered.
   - `tool_execution_end`: emits the tool-finished activity using `toolCallId`/`toolName` from the head (failure flag/bash detail only if present in the head), so the board does not stay "running".
   - `message_end` for an assistant message: emits the `message_end` boundary when the role is readable from the head.
   - A `response` with an id readable from the head: the pending command fails as an oversized response (not a killed process).
   - Anything else, or an unreadable type: skipped.
   Each oversized line is reported (scenario 6) with its type (if known) and size.
2. **Non-fatal protocol anomalies.** Instead of killing Pi, harnessd skips and reports: a non-JSON line; a record without a string `type`; a `response` without a string id (including Pi's id-less `parse` error); a `response` whose `command` differs from the pending command (that pending command fails; Pi keeps running). An exception thrown while handling a parsed record is reported as an internal harnessd handling error naming the record type, not as malformed input, and Pi keeps running.
3. **Fatal remains fatal.** Pi is still stopped (with recovery per core) only when the channel is actually broken: stdout/stdin stream errors, EOF/exit, or an excessive burst of consecutive anomalies (more than 20 in a row without a valid record) that indicates a corrupted stream.
4. **Truncated last record.** Leftover partial data at stdout EOF after the child exited or during harnessd's own shutdown is reported as the process stopping (with exit code/signal), not as a malformed record.
5. **Prompts during compaction.** A prompt submitted while Pi is compacting is held and sent after `compaction_end` (bounded wait; on timeout the input fails explicitly). When Pi rejects a prompt, the failure detail includes Pi's own error text (redacted, bounded) instead of only "Pi rejected the prompt".
6. **Reporting every anomaly.** Each anomaly in scenarios 1, 2, 4 and 5 writes one `harnessd: ` journal line (session ID, anomaly kind, record type if known, byte length, and for non-oversized anomalies a redacted head of at most ~300 characters) and sends one plain-Russian message to the chats that receive that session's events (selected/attributed chats, as for other session errors): what happened, what harnessd did (skipped / failed the command / held the prompt), whether Pi keeps running, and a short journal reference. Identical anomaly kinds for one session are coalesced to at most one chat message per minute, with a count of repeats; the journal gets every occurrence (rate-limited only against floods).
7. **Extension UI noise.** `set_editor_text` (including `pasteToEditor`) is ignored silently like `setTitle`, not reported as an unsupported request.
8. **Prompt race.** Prompts always carry `streamingBehavior: "steer"` so a prompt racing with an unseen `agent_start` is not rejected (Pi ignores the field when idle).

## Non-goals

Changing Pi; persisting events; resending inputs; general content inspection beyond the bounded redacted head; group chats.

## Affected surface contracts

- [Pi RPC harness](../surfaces/pi-rpc-harness.md): record size handling, anomaly tolerance, fatal conditions, compaction hold, extension UI.
- [Telegram transport](../surfaces/telegram-transport.md): anomaly messages.
- [Core session management](../surfaces/core-session-management.md) only if new event kinds cross the core boundary.
- [Package release](../surfaces/package-release.md): 0.3.1.

## Interfaces and constraints

- Transport, harness, process-provider and secret-provider boundaries stay independent: the harness emits a typed, safe anomaly event; Telegram presents it.
- Heads shown to the owner and journal are redacted with the existing diagnostic redaction and bounded; no full record content is stored or sent.
- Memory for an oversized line is bounded by the head size regardless of line length.

## Acceptance criteria

- A 5 MiB `agent_end` line ends the run normally (status events, answer delivery), Pi is not killed, memory use does not hold the line, and one anomaly is journaled and shown in chat.
- A large `tool_execution_end` produces a tool-finished activity.
- Non-JSON line, missing type, id-less response, response-command mismatch, and a throwing handler each keep Pi running and produce a journal line and a chat message; a burst over the threshold is fatal.
- Partial data at EOF after exit is reported as process exit.
- A prompt during compaction is sent after `compaction_end`; a rejected prompt shows Pi's reason.
- `set_editor_text` produces no error event; prompts always include `streamingBehavior`.
- Repeated identical anomalies are coalesced in chat.

## Validation

`npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, `git diff --check`; independent review before merge.
