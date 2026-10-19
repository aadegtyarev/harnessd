# Feature contract: rename from the main panel

Status: approved by the owner 2026-10-19; in implementation.

## Goal and user-visible behavior

The owner did not find rename behind 🗂 Сессии → session → «Переименовать». The main inline panel gets a «Переименовать» button for the session it currently shows, so renaming takes one tap from `/menu` or 📋.

## Scenarios

1. The main panel shows a session (its preview/selected session): a «Переименовать» button is present. Tapping it starts exactly the existing rename flow for that session (the same prompt, reply handling, cancel, and `--clear` semantics as the session-card button); after the rename the panel reflects the new name.
2. The panel shows no session (no sessions, or nothing previewed/selected): no rename button.
3. The button is bound to the session shown when the panel was rendered; if that session was deleted meanwhile, the existing rename flow's not-found handling applies.
4. Button placement keeps the panel compact (no extra row if it fits an existing session-actions row); no other buttons, texts, or flows change.

## Non-goals

Renaming the Pi-native session; new rename commands; changes to `/rename` or the session card.

## Affected surface contracts

- [Telegram transport](../surfaces/telegram-transport.md): main panel actions.
- [Package release](../surfaces/package-release.md): patch release 0.3.1.

## Acceptance criteria

- A panel showing a session has «Переименовать»; tapping it produces the same rename prompt as the card button and the rename applies to that session.
- A panel with no shown session has no rename button.
- Existing panel tests stay green.

## Validation

`npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, `git diff --check`; independent review before merge.
