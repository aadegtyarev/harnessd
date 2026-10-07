# Feature contract: Telegram files, navigation, and onboarding

Status: approved

## Goal

Improve Telegram onboarding, Russian-language clarity, directory navigation, and file-transfer failure guidance without changing underlying authorization, routing, filesystem, inbox, or retry semantics.

## User-visible behavior

- `/start` welcomes operators, explains the main workflow, and offers `Открыть панель`, `Сессии`, and `Новая сессия` buttons.
- `/help` explains the workflow before presenting a compact command reference.
- Russian is the primary Telegram UI language for command descriptions, status, errors, activity, and buttons. Exact slash commands, `SessionId`/`InputId`, model/provider IDs/effort, paths/names, and safe technical values remain unchanged.
- Use terms consistently: сессия, выбранная сессия, папка, рабочая папка сессии, вложение, файл из рабочей папки.
- The folder panel lists directories independently from the first 100 mixed `/ls` entries. It displays at most 100 directories, reports that limit honestly, and guides access to additional paths with `/cd <путь>`. `/ls` retains its existing mixed bounded behavior.
- Incoming file errors distinguish size, quota, inbox-inside-workspace, download timeout/network, write, stale target, and unavailable session. `/send` distinguishes missing, inaccessible, outside canonical workspace, non-regular file, size, and Telegram delivery failures.
- Errors provide actionable guidance without useless retry affordances or automatic resend. Quota text explains cleanup skips running sessions and does not promise a cleanup button.

## Constraints and non-goals

Preserve callback binding, authorization, path canonicalization, selection revalidation, and current filesystem semantics. Do not add inbox management, change TTL/quota/20 MiB limits, schema/persistence, an unlimited/search browser, sandbox/permissions, CLI/README localization, a language chooser/full i18n, event history, authority/resend/recovery/process changes.

## Affected surface contracts

- [Telegram transport](../surfaces/telegram-transport.md)

## Acceptance criteria

- Tests cover onboarding and Russian-language presentation; directory navigation with more than 100 files before directories and with more than 100 directories; each typed incoming-file failure reason; distinct Telegram `/send` delivery failure; whitespace-containing paths; and absence of retry behavior.
- Existing callback/auth/path/selection invariants and mixed bounded `/ls` behavior remain intact.

## Validation

Run focused tests and all required project gates: `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, and `git diff --check`.
