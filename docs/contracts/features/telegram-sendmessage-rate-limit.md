# Feature contract: queued Telegram sendMessage rate limits

Status: approved for implementation

## Goal

Honor a valid Telegram `retry_after` for ordinary queued `sendMessage` deliveries without failing the chat queue or reordering its messages.

## Scenarios

- A queued ordinary message receiving HTTP 429 with a valid positive `retry_after` remains the current item and is retried after the full delay.
- Later queued items wait; successful delivery is not duplicated and FIFO is preserved.
- Stopping the transport cancels the cooldown promptly and prevents another Telegram call.
- Non-429 failures keep the existing failed-queue, remainder-clear, and explicit-reset policy.
- Malformed/unsupported retry metadata may use the ordinary failure policy.

## Non-goals

- Do not alter run-card or panel edit retry behavior.
- Do not reshape/re-enqueue messages or broaden retries to other Telegram operations.

## Affected surfaces

- [Telegram transport](../surfaces/telegram-transport.md)
- [Package release](../surfaces/package-release.md)

## Constraints

Use the existing retry-after parser. Keep retries single-flight and tied to the exact current queued item. Shutdown must interrupt the wait. Do not change behavior for other errors.

## Acceptance criteria

- A `retry_after: 120` response causes no early retry and a retry at the full 120-second interval without setting `ChatQueue.failed` or clearing queued content.
- The same item is attempted before the next item, in FIFO order, with no duplicate successful delivery.
- Shutdown during cooldown returns promptly and makes no later Telegram call.
- Non-429 rejection retains the existing queue failure and clear policy.
- Run-card and panel edit behavior is unchanged.

## Validation

Deterministic fake-timer regressions for full delay/FIFO/no duplication, shutdown cancellation, and non-429 policy; focused tests; `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, `npm pack --dry-run`, production audit, and `git diff --check`.
