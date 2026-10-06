# Telegram truthful outcomes

Status: approved; implementation pending

## Goal and behavior

The UI never falsely describes delivery, cancellation, or deletion consequences.

- `UncertainInputDeliveryError` for text and media says Pi may have accepted the input, its acknowledgement was lost, and no automatic resend occurred. Definite rejection remains distinct.
- User cancellation is presented as “canceled by user,” not as a send error.
- Delete confirmation states that the harnessd record and received inbox attachments are deleted, while workspace and Pi-native files remain.

## Scenarios

Cover uncertain text and media delivery, definite rejection versus uncertainty, user cancellation presentation, and the exact delete confirmation.

## Non-goals

Response history, inbox management, core lifecycle/storage schema changes, automatic resend, or broadened delete rights.

## Affected surfaces

- [Telegram transport](../surfaces/telegram-transport.md)
- [Core session management](../surfaces/core-session-management.md)
- [Pi RPC harness](../surfaces/pi-rpc-harness.md)

## Interfaces and constraints

Keep transport, harness, and session-management boundaries unchanged. Do not resend uncertain inputs or expand deletion effects.

## Acceptance

Regression tests cover all scenarios above. All required validation gates pass and independent review is obtained.

## Validation

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, `git diff --check`, and the docs checker if present.
