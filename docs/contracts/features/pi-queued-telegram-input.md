# Feature contract: Pi-queued Telegram input and acknowledgment

- Status: complete; acceptance and independent review passed (251 tests; typecheck, build, lint, format, version, and diff checks passed)

## Goal and user-visible behavior

A Telegram operator must not receive a generic `An input is already active` error merely because Pi is busy. harnessd submits additional inputs to Pi's native queue and visibly acknowledges messages Pi has accepted. The UI must make success, rejection, and uncertainty obvious without requiring the operator to manually wait and retry.

## Scenarios

- When a selected Pi session is idle, a new Telegram text/media input starts normally.
- While Pi is running, a new input is accepted into Pi's native steering queue using RPC's `prompt` with `streamingBehavior: "steer"` (Pi's normal Enter behavior); it is not held in a separate harnessd text queue.
- Every input keeps its own `InputId`; acknowledgement and lifecycle events must not conflate queued inputs. A positive RPC response means accepted/queued, not completed.
- After positive acceptance, react with `👀` to the originating Telegram message. Keep the existing InputId acceptance reply. If adding a reaction fails, journal a diagnostic and retain the visible reply; do not turn accepted work into a failure.
- If Pi rejects an input, return a readable actionable error and do not react as if it was accepted. If delivery is uncertain, report uncertainty and never automatically resend.
- On Pi process exit, unresolved accepted inputs are reported uncertain; they are never replayed after recovery or service restart.

## Non-goals

No harnessd-persisted prompt queue, no new retry behavior, no Telegram-owned scheduler, no changing Pi queue mode, no changing authorization/session-selection rules, and no claim that 👀 means processing completed. The reaction means Pi acknowledged acceptance only. Pi RPC aborts the current run rather than addressing an individual queued prompt; when multiple inputs are outstanding, `/cancel` must refuse without aborting any work and explain that the queue cannot be canceled item-by-item.

## Affected surfaces

- [Telegram transport](../surfaces/telegram-transport.md)
- [Pi RPC harness](../surfaces/pi-rpc-harness.md)
- [Core session management](../surfaces/core-session-management.md)
- [Transport adapter](../surfaces/transport-adapter.md)

## Interfaces and constraints

Use Pi RPC's existing `prompt` command and `streamingBehavior: "steer"` when submitting during an active turn; do not write to Pi through a second protocol. Preserve transport/core/harness ownership and Pi command correlation. Track accepted inputs independently so `agent_settled`, process exit, cancellation, and uncertainty retain correct `InputId` association. Telegram message reactions are a presentation side effect after RPC acceptance; API failure is non-fatal and the existing acceptance reply remains the fallback. Prompt bodies are never logged or echoed in diagnostics.

## Acceptance criteria

- Concurrent inputs during an active Pi turn reach Pi's built-in steering queue rather than failing at the harness active-input guard.
- RPC rejection remains a definite failure; a lost response remains uncertain and is never resent.
- Multiple queued inputs receive distinct IDs and accurate non-duplicated delivery notifications; settlement/process exit cannot mark the wrong input completed.
- Accepted text, photo, and document submissions receive the 👀 reaction on their originating Telegram messages when supported; reaction API failures do not invalidate accepted input and are logged safely.
- Telegram replies explain acceptance/rejection/uncertainty; users do not need to manually retry after a normal in-progress submission.
- When multiple inputs are outstanding, cancellation is explicitly refused without sending `abort` or disrupting the queue. A new submission arriving during a single-input abort waits for the abort response before being sent to Pi; if that response is uncertain, it waits until Pi settles or exits. This prevents the run-wide abort from discarding a newly queued input.
- Tests cover queued RPC payload/disposition, multiple input lifecycle ordering, rejection/uncertainty, process exit, reactions, and reaction failure fallback.

## Validation

Run relevant harness/transport/core tests and `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, and `git diff --check`.
