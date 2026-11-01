# Feature contract: Telegram mid-run message flood

**Status:** Approved  
**Date:** 2026-11-01

## Goal

Prevent intermediate assistant `message_end` events within one Pi run from producing separate Telegram messages. Show progress in the existing throttled/coalesced run-card; deliver the run's final answer as a separate Telegram message exactly once.

## Affected surface contracts

- [Telegram transport](../surfaces/telegram-transport.md)
- [Pi RPC harness](../surfaces/pi-rpc-harness.md)

## Scope and scenarios

- Any number of assistant `message_end` boundaries during a still-open run must not create intermediate Telegram output bubbles. Progress updates use only the existing run-card and remain throttled/coalesced; they do not create new bubbles.
- At run settlement, deliver the final assistant answer as a separate message exactly once, without duplicating intermediate fragments.
- Preserve multi-input/steering attribution, recipient selection, per-chat FIFO ordering, and subagent/tool activity presentation.
- Preserve interruption, stop, and cancellation behavior, including interrupted-output handling, canceled-run suppression, and queued-input semantics.
- Intermediate fragment text is not required in the run-card. Existing structured progress/activity is sufficient; do not expose or duplicate assistant output merely to represent progress.
- A burst of message ends produces no burst of Telegram messages. Relevant HTTP 429 run-card edit behavior honors the full supplied `retry_after`, coalesces to the newest lifecycle intent, and does not delay final answer delivery or change the independent event-delivery queue.

## Non-goals

- Changing the Pi RPC event contract or suppressing/merging its `message_end` events.
- Daemon mode, persistence/schema, general retry policy, panels, or subagent protocol changes.

## Constraints

Implement this projection only in Telegram transport. Keep existing run-card throttling/coalescing and card-local backoff independent from ordinary queued message delivery. Do not add bubbles for intermediate assistant fragments.

## Acceptance criteria

- A run with many assistant `message_end` events creates no separate intermediate assistant messages; its final answer is delivered separately once and is not duplicated.
- Steering/multi-input attribution and FIFO, subagent activity, and stop/cancel/interruption semantics remain intact.
- During a burst of progress edits receiving relevant 429 responses, the card honors `retry_after` and retains newest-wins behavior; final answer delivery is not held behind card cooldown.

## Validation

Run targeted Telegram transport tests, then `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` where scripts/dependencies are available; run `git diff --check`.
