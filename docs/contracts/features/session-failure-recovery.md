# Feature contract: sessions do not fail silently

Status: approved by the owner 2026-10-19; in implementation.

## Goal and user-visible behavior

A transient Pi exit or a harnessd restart does not leave a session `failed`. When a session does fail, the owner learns it at once, with the cause, and restores it with one tap. The cause is visible later and in the journal.

Incident behind this change: on an owner machine an idle pi-rpc session was found `failed` with no journal line and no Telegram notice. The manager-lifetime recovery budget never resets, so transient Pi exits accumulate until the next exit fails immediately. During `systemctl --user stop`, the default `KillMode=control-group` kills the Pi child before the manager is marked closing, so the exit is treated as a crash.

## Scenarios

1. **Budget reset.** Automatic recovery keeps three `resume` attempts delayed by 250 ms, 1 s and 4 s. The per-session counter resets after a successful automatic recovery, a successful operator resume and an operator stop. Three consecutive failed attempts in one recovery still persist `failed`. A session that crashes and recovers four or more times in one manager lifetime keeps recovering.
2. **Shutdown is not a crash.** Runtime shutdown marks the manager as closing before any transport is stopped. A harness exit observed after that point does not start recovery and does not write `failed`; the session ends `stopped` through the normal close path.
3. **Unit stop signal.** The generated user unit sets `KillMode=mixed`: `SIGTERM` reaches only the harnessd main process, which stops its Pi children itself; systemd kills any remaining processes after the main process exits or at the stop timeout. Existing installs get this by re-running `harnessd service install` from the working directory (it replaces a harnessd-managed unit).
4. **Startup reconciliation.** At runtime start, in addition to `running`/`starting` → `stopped`, a `failed` record with a stored native session ID becomes `stopped` and keeps its failure cause. A `failed` record without a native ID stays `failed`. Nothing is launched at start; a later message or explicit resume follows the existing stopped-session path.
5. **Durable cause.** Each transition to `failed` persists a fixed reason code and a timestamp: `launch_failed`, `unexpected_exit` (recovery exhausted), `resume_unavailable` (missing native ID or resume capability), `native_id_mismatch`, `options_replacement_failed`. The columns are added by an idempotent startup migration on existing databases. A successful launch/resume to `running` clears them. `/status` and the session card show the last cause and time while set.
6. **Journal.** Every write of `failed` and every failed automatic recovery attempt emits one `harnessd:` journal line with session ID, reason code, attempt number, and the last Pi exit code/signal. The Pi adapter keeps a bounded tail (about 2 KB) of Pi stderr per instance; it is included only in these journal lines, never in Telegram output or SQLite.
7. **Owner notice.** On `harness_recovery_failed`, Telegram sends one notice per failure to every authorized private chat — whether or not the session is selected there — naming the session and the reason code in plain Russian, with a **Восстановить** button. One failure produces at most one notice per chat (including chats that would also get the selected-session status line); a later failure after a successful recovery or resume notifies again.
8. **One-tap restore.** **Восстановить** on a `failed` session (in the notice and in the session card) stops it if needed and resumes the same native session, ending `running`; the button is bound to the authorized chat, sender, and session like other one-time callbacks. The card hint telling the operator to choose another session is removed. A failed restore reports the error and leaves the session `stopped` or `failed` as persistence permits.

## Non-goals

- Diagnosing why Pi itself exits; the new journal lines exist to show that next time.
- Resending old input, falling back to a fresh Pi session, or launching sessions at startup.
- Group chats, persistent event history, Telegram-owned retry policy.

## Affected surface contracts

- [Core session management](../surfaces/core-session-management.md): budget reset, close ordering, startup reconciliation of `failed`, failure cause persistence.
- [Pi RPC harness](../surfaces/pi-rpc-harness.md): bounded stderr tail exposed for diagnostics.
- [Telegram transport](../surfaces/telegram-transport.md): owner-wide failure notice, restore action, cause in status/card.
- [User service](../surfaces/user-service.md): `KillMode=mixed`, reinstall note.
- [Package release](../surfaces/package-release.md): minor release 0.3.0 with schema migration.

## Interfaces and constraints

- Transport, harness, process-provider and secret-provider boundaries stay independent; Telegram only presents core events and calls core operations.
- Session summary gains optional `failureReason`/`failedAt`; no prompt text or stderr is persisted or sent to Telegram.
- Migration is additive (`ALTER TABLE ... ADD COLUMN`) and tolerates already-migrated databases.

## Acceptance criteria

- Four crash/recover cycles in one manager lifetime all recover; three consecutive failed resumes persist `failed` with `unexpected_exit`.
- A harness exit while runtime close is in progress (transport stop held open) leaves the record `stopped`, with no resume call and no `failed`.
- The generated unit contains `KillMode=mixed`.
- Startup turns `failed` + native ID into `stopped`; `failed` without native ID stays `failed`.
- Failure cause and time are stored, shown in `/status` and the card, and cleared on `running`; migration works on a pre-0.3.0 database.
- A failure journal line is written for each `failed` write and failed attempt, including the stderr tail.
- A chat with no or another selected session receives exactly one notice per failure; the **Восстановить** button brings a `failed` session to `running` with the same native ID.

## Validation

`npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, `git diff --check`; independent review before merge.
