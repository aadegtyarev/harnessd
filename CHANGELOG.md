# Changelog

All notable changes to harnessd are recorded here. Entries under `Unreleased` are not a release and do not imply npm publication.

## [Unreleased]

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
- Telegram controls are bottom-anchored: a persistent keyboard (`📊 Ход`, `📋 Панель`, `✋ Прервать` with confirmation, `🗂 Сессии`), `📋` posts the panel at the bottom and removes the old one, panels are no longer pinned, and mid-run answers arrive silently while the final answer keeps the sound.
- The Telegram session panel reads more plainly: `✉️ Сообщения →` for the selected session and `👁 Просмотр` (or `та же сессия`) separated by a rule, short 8-character IDs, one combined Russian status line instead of duplicated English/Russian status fields, no redundant `Существует`/`Выбрана для сообщений` lines or live-data notice for stopped sessions, the creation folder at the bottom, and preview buttons without the word «просмотр».
- Git-source installs build the CLI before npm installs the package.

### Fixed

- After a supervisor restart or host reboot, sessions left recorded as `running`/`starting` are reconciled to `stopped` at startup, so the next message resumes the saved native session instead of failing with `SessionNotFoundError`.
- Telegram delivers each Pi assistant message at its `message_end` instead of only when the run settles, so answers are no longer held back for hours by automatic task continuations; the output bound now applies per message, and stopping a session delivers already-buffered text as interrupted instead of discarding it.
- Automatic panel refreshes no longer post a "panel could not be updated" notice on a transient Telegram failure: edits retry up to twice (honoring 429 `retry_after`), persistent transient failures mark the panel stale silently, and a definitively uneditable panel is replaced with a fresh pinned one; taps on a replaced panel's buttons no longer re-adopt it and spawn further panels.
