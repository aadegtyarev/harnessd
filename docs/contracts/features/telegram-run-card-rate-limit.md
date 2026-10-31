# Feature contract: Telegram run-card retry-after

- Status: approved, in progress
- Affected surface: [Telegram transport](../surfaces/telegram-transport.md)

## Goal

Prevent repeated Telegram run-card edits from hammering the API after an HTTP 429 while preserving the independent event-notification channel.

## Scenarios and constraints

- A run-card edit rejected with HTTP 429 and `parameters.retry_after` becomes eligible only after that server interval, including intervals longer than 10 seconds.
- While throttled, state changes coalesce; exactly the newest rendered state is edited after the deadline. No snapshots are queued, and card edits remain single-flight.
- Card-local throttling does not fail or disable the chat's event queue. Event delivery retains its existing failure policy.
- Shutdown and retirement of the card invalidate its delayed retry. Transient non-429 behavior and existing delivery guarantees remain unchanged.

## Non-goals

- Do not change event-send retry/disablement policy or add retries to message delivery.

## Acceptance criteria

- A 209-second retry-after causes one failed edit despite many card updates, no early API calls, then one edit of the newest content.
- Event notifications can still drain while the card is throttled.
- Shutdown during cooldown causes no delayed edit.
- Existing non-429 card behavior and true event-send queue failure remain intact.

## Validation

Add deterministic fake-timer regression tests; run focused tests and the full required package checks, including pack dry-run and diff check.
