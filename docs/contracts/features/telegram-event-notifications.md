# Feature contract: Telegram event notifications

**Status:** Approved for implementation

## Goal and observable behavior

Reduce duplicate and visually noisy Telegram notifications while preserving useful input-delivery and failure information. A successful submit produces one acceptance confirmation containing the original `InputId`. Session event messages show the session ID without a `#` tag and render that ID in monospace in the footer.

## Scenarios

- A successful submit: the Telegram user sees one acceptance confirmation with the returned `InputId`, not a second `accepted` event notification for the same input.
- A failed/uncertain submit: its original ID and meaningful delivery state remain visible; no automatic resend is introduced.
- A session reports repeated identical error events before recovery: notify once for that failure episode. After a `harness_recovered` event, a subsequent failure is notified as a new episode.
- Event/footer text containing HTML-like characters is delivered as literal text; only the footer session ID receives monospace formatting.
- Multipart event messages retain ordering, limits, and the same unprefixed monospace session ID in each footer.

## Non-goals

Do not change core recovery policy, retry behavior, the safe generic error text, command/result presentation outside session-event footers, or other transport behavior. Do not expose raw exception details, prompt content, or stderr.

## Affected surface contracts

- [Telegram transport](../surfaces/telegram-transport.md)
- [Transport adapter](../surfaces/transport-adapter.md)

## Interfaces and constraints

Changes remain within Telegram event presentation and its tests unless implementation evidence shows a necessary adjacent boundary; any new affected surface requires renewed approval. Preserve per-chat ordering, bounded queue behavior, the original `InputId`, Telegram message-size and Unicode handling, authorization, and safe-output guarantees. Use Telegram message entities or equivalent escaping so event bodies remain literal and safe while the session ID alone is monospace.

## Acceptance criteria

- Tests prove successful submit yields exactly one acceptance notification with the returned `InputId`.
- Tests prove duplicate error notifications in one episode are suppressed and a post-recovery error is emitted.
- Tests prove session footer has no `#`, includes the full session ID, and applies monospace formatting only to that ID.
- Tests cover literal HTML-special text, multipart footer formatting, and unchanged uncertain-input visibility.
- Relevant tests, typecheck, build, lint, format check, version check, and `git diff --check` pass.

## Validation

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, and `git diff --check`. Obtain an independent read-only review against this contract and the two affected surface contracts before merge.
