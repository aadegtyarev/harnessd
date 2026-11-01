# Feature contract: Telegram model-output garbage tails

Status: approved for implementation

## Goal

Remove the strict model-generated garbage signature from completed assistant output presented by Telegram, without altering the assistant body or native session history.

## Scenarios

- Remove an exact terminal `xx` / `hidden.` pair followed by at least three allowed standalone marker lines, including Russian body text, CRLF, and garbage-only output.
- Preserve incomplete signatures, inline/prose/code lookalikes, unknown marker lines, markers before normal trailing text, and legitimate `At 500.` prose.

## Non-goals

- No broad AI-output filtering, mid-message cleanup, history/event/log mutation, or deployment/restart.

## Affected surface

- [Telegram transport](../surfaces/telegram-transport.md)

## Constraints and interface

Use a pure responsibility-scoped sanitizer on completed assistant text immediately before delivery in both `message_end` and settled-turn paths. Match case conservatively and only at line boundaries; tolerate blank lines and CRLF. After the exact signature, every nonblank line must be one of `Stop.`, `No.`, `End.`, `Done.`, or `At <digits>.`. Remove the suffix only when it reaches end-of-text; preserve preceding text byte-for-byte apart from the removed boundary.

## Acceptance

- Both delivery paths sanitize; interrupted/overflow notices remain independent.
- Garbage-only output produces no ordinary answer absent an independently required notice.
- Positive screenshot and CRLF fixtures pass; specified negative cases remain unchanged.
- Durable Telegram surface contract states the narrow presentation guarantee.

## Validation

Focused sanitizer/transport tests, full test suite, typecheck, build, lint, format check, version check, audit, package dry run, diff check, and authored-file line limits.
