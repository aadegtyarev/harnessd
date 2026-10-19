# Changelog

All notable changes to harnessd are recorded here. Every behavior-changing pull request is a release with its own version; documentation-, test- or CI-only changes may sit under `Unreleased` until the next release moves them into its version. Nothing here implies npm publication.

## [Unreleased]

## [0.3.1] - 2026-10-19

### Added

- **Переименовать** on the main Telegram panel for the session it shows, starting the same rename flow as the session card; absent when no session is shown.

## [0.3.0] - 2026-10-19

### Added

- Session failure notice in Telegram: one message per failure to every authorized private chat, naming the session and the cause, with a one-tap **Восстановить** button (also on the session card) that stops the session if needed and resumes the same Pi session.
- Durable failure cause: `failed` sessions store a fixed reason (`launch_failed`, `unexpected_exit`, `resume_unavailable`, `native_id_mismatch`, `options_replacement_failed`) and time, shown in `/status` and the session card and cleared when the session runs again. **Schema migration:** startup adds the nullable `failure_reason` and `failed_at` columns to the `sessions` table (idempotent).
- One `harnessd:` journal line per failed recovery attempt and per failure, with session ID, reason, attempt number, Pi exit code/signal, and a bounded, redacted Pi stderr tail (journal only).

### Changed

- The automatic-recovery budget (three attempts after 250 ms, 1 s, 4 s) now resets on stop, and after a successful recovery, resume, or option change once the session has stayed up for 60 s, so repeated transient Pi exits no longer exhaust it for the rest of the process lifetime while a crash loop still ends `failed`.
- Shutdown waits at most 5 s for in-flight requests before stopping sessions.
- At startup a `failed` session with a saved native session ID becomes `stopped` (keeping its cause), so the next message or `/resume` resumes it.
- The generated user unit sets `KillMode=mixed`. Existing installs: re-run `harnessd service install` from the working directory to replace the unit.
- The `failed` session card no longer tells the operator to choose another session.

### Fixed

- A Pi exit during harnessd shutdown (for example `systemctl --user stop`) is no longer treated as a crash: the manager is marked closing before transports stop, so the session ends `stopped` instead of `failed`.

## [0.2.0] - 2026-10-17

### Added

- Optional `.env` configuration loading, `HARNESSD_HOME` for the initial Telegram working folder, and explicit Linux per-user systemd service install/uninstall commands.
- SemVer policy, synchronized package-version validation, and a documented local Git-install workflow.
- Plain-language architecture and operation documentation for the completed v1 service.
- Telegram `/delete` for stopped harnessd session records, code-formatted session IDs, and a private-chat slash-command menu.
- Telegram `/resume [sessionId]` and text-triggered resume of selected stopped sessions using the saved Pi-native session, without automatic prompt retries.
- A visibility-tagged command catalog shared by CLI help and Telegram, plus per-chat `/ls` and `/cd` navigation.

### Changed

- The run card gained an agents section from pi-subagents snapshots: one row per run (parallel runs side by side), workflow steps indented, needs-attention/active first, elapsed time and current tool, reviewer verdicts from completion notices (paired with runs by the run ID in the notice), and whom the parent is waiting for; the snapshot state `complete` is now recognized.
- The Telegram activity bubble became a live run card: /task goal and progress, the latest one-line thought, the last five events (collapsed repeats, bash exit codes and durations, plain-language agent waits), `📋 Отчёт`/`⛔ Прервать` buttons, freeze-and-open below mid-run answers, and a one-line summary when the run ends.
- `/menu` and the `/start` panel action now post the panel at the bottom like `📋 Панель`. A replaced panel that Telegram refuses to delete becomes the note «Панель перенесена ниже ↓» without buttons, and overlapping `/menu`/`📋` presses leave exactly one panel instead of editing the old one.
- Telegram controls are bottom-anchored: a persistent keyboard (`📊 Ход`, `📋 Панель`, `✋ Прервать` with confirmation, `🗂 Сессии`), `📋` posts the panel at the bottom and removes the old one, panels are no longer pinned, and mid-run answers arrive silently while the final answer keeps the sound.
- The Telegram session panel reads more plainly: `✉️ Сообщения →` for the selected session and `👁 Просмотр` (or `та же сессия`) separated by a rule, short 8-character IDs, one combined Russian status line instead of duplicated English/Russian status fields, no redundant `Существует`/`Выбрана для сообщений` lines or live-data notice for stopped sessions, the creation folder at the bottom, and preview buttons without the word «просмотр».
- Git-source installs build the CLI before npm installs the package.

### Fixed

- Telegram assistant answers no longer show raw Markdown headings, pipe tables, bullet markers, blockquote markers, or horizontal rules: headings render bold, table rows become `• <b>key</b> — value` lines, bullets become `•`, `>` lines become a blockquote, and rules are dropped; code stays untouched (an unclosed fence runs to the end), long answers still split into balanced HTML, and a chunk Telegram cannot parse is resent once as plain text instead of stopping the chat's output.
- After a supervisor restart or host reboot, sessions left recorded as `running`/`starting` are reconciled to `stopped` at startup, so the next message resumes the saved native session instead of failing with `SessionNotFoundError`.
- Telegram delivers each Pi assistant message at its `message_end` instead of only when the run settles, so answers are no longer held back for hours by automatic task continuations; the output bound now applies per message, and stopping a session delivers already-buffered text as interrupted instead of discarding it.
- Automatic panel refreshes no longer post a "panel could not be updated" notice on a transient Telegram failure: edits retry up to twice (honoring 429 `retry_after`), persistent transient failures mark the panel stale silently, and a definitively uneditable panel is replaced with a fresh one; taps on a replaced panel's buttons no longer re-adopt it and spawn further panels.
