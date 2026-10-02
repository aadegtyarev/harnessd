# Feature contract: in-process session watchdog

**Status:** Approved under the approved `harnessd-v1` contract and the user's request to continue v1
**Repository:** `Hobby/harnessd`

## Goal

Recover an unexpectedly exited harness process while its `SessionManager` is still alive, using explicit lifecycle observation, bounded native-session resume, and no prompt replay.

## Scenarios and guarantees

- `HarnessInstance` exposes an explicit process-exit promise (OS exit code/signal), forwarded by `PiRpcHarnessAdapter` from its `ManagedProcess`. Core must not infer process death from ordinary `events` EOF alone.
- When the current instance exits unexpectedly, core drains its event pump before notifying/restarting, preserving final output and input uncertainty before events from a replacement instance. It emits safe `harness_restarting`, `harness_recovered`, or `harness_recovery_failed` status events, tagged with the same supervisor `SessionId`.
- Core attempts at most three `resume` calls per `SessionId` during one `SessionManager` lifetime. Delays before attempts are 250 ms, 1 s, and 4 s; failed resumes consume the budget, which does not reset after a successful resume. Recovery is deterministic (no jitter) and ends in persisted `failed` status when exhausted.
- Resume is allowed only when the harness declares `harness.resume`, implements `resume`, and the persisted session has a native session ID. It passes the exact supervisor ID, cwd, and native ID. Missing capability/ID or failed recovery marks the session failed; core never silently falls back to a fresh `launch`.
- Session status is `starting` during recovery, `running` after successful resume, `failed` after terminal recovery failure, and `stopped` after explicit stop. Per-input uncertainty remains an `InputEvent` concern; this feature does not assign new meaning to `SessionStatus.uncertain`.
- Core tracks unsettled `InputId`s in memory. If an instance exits before an input receives a terminal `completed`, `failed`, or `uncertain` event, core publishes one `uncertain` event with the original ID. Already-reported uncertainty is not duplicated. Old input text is never retained or resent by recovery; only a later explicit submit creates new work.
- Operator `stop()` and `SessionManager.close()` become terminal before shutdown/retry cancellation. A pending backoff is cancelled; a resume that races with stop is shut down before stop completes. No watchdog restart occurs for intentional shutdown.
- A failure isolated to one session does not delay or stop another session. Error/status events and diagnostics are safe and exclude prompt contents, raw exceptions, and process environment.

## Non-goals

- Reattaching/reconciling sessions after the supervisor process itself restarts, detecting or killing orphaned processes, persisting restart budgets or input history, or adding a storage-schema migration.
- Fresh-launch fallback for a harness that cannot resume, user-facing restart commands, configurable watchdog policy, retries of uncertain inputs, process isolation, or secret-wallet operations.

## Affected surface contracts

- [`docs/contracts/surfaces/core-session-management.md`](../surfaces/core-session-management.md)
- [`docs/contracts/surfaces/pi-rpc-harness.md`](../surfaces/pi-rpc-harness.md)
- [`docs/contracts/surfaces/process-provider.md`](../surfaces/process-provider.md)
- [`docs/contracts/surfaces/transport-adapter.md`](../surfaces/transport-adapter.md)
- [`docs/contracts/surfaces/telegram-transport.md`](../surfaces/telegram-transport.md)
- [`docs/contracts/features/harnessd-v1.md`](harnessd-v1.md)

## Interfaces and constraints

- Core owns per-session exit observation, the finite retry budget, backoff, stop dominance, active-`InputId` tracking, persistence of `starting/running/failed/stopped`, and ordered lifecycle events. `ProcessProvider` remains a process primitive.
- The process exit signal is distinct from the harness event stream: await/drain final events before beginning resume. Ignore late exit signals from superseded instances.
- Retry only `HarnessAdapter.resume`; it must preserve the native session ID. Do not call `send` for an input accepted or possibly accepted by the prior process.
- Keep supervisor restart state in memory for this slice; do not change SQLite schema. Preserve the existing trusted direct-execution and adapter-boundary guarantees.

## Acceptance and validation

- Tests prove an unexpected exit drains final events then resumes using the exact stored native ID; ordinary event-stream EOF without exit does not restart; stale exits do not restart a newer instance.
- Two-session tests prove exit/recovery/failure isolation. Tests cover missing capability/native ID (no launch fallback), three-attempt/backoff exhaustion and persisted failed state, and recovery success status/event ordering.
- Tests simulate an in-flight input and a terminal uncertain event: the original `InputId` is reported once, no old prompt is sent to the resumed instance, and only a later explicit submit creates a new ID.
- Tests cover operator stop during backoff, stop racing with resume completion, and manager close while recovery is pending; no late instance remains live and terminal stop is not overwritten.
- Telegram maps watchdog statuses safely with the supervisor `SessionId`; tests verify ordering and safe output. No raw exception, prompt, or child environment leaks.
- Run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, and `git diff --check`. No live Pi crash/restart is required for mocked validation; report that smoke test as unavailable/not run.
