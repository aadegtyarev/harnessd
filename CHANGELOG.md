# Changelog

All notable changes to harnessd are recorded here. Every behavior-changing pull request is a release with its own version; documentation-, test- or CI-only changes may sit under `Unreleased` until the next release moves them into its version. Nothing here implies npm publication.

## [Unreleased]

## [0.3.3] - 2026-10-19

### Changed

- The fatal-stop chat message is harness-neutral (`Сессия остановлена: …`, an unknown exit shown as «неизвестно») and never says «Pi» for a non-Pi session; a Claude protocol error is worded in Russian too.
- A record cut while harnessd itself stops a session (operator `/stop`, delete, option relaunch, service shutdown) is journal-only; no chat notice.
- Input non-delivery and session stops carry fixed reason codes (`prompt_rejected`, `hold_timeout`, `held_and_stopped`, `canceled`; `process_exited`, `stream_corrupted`, …). Telegram picks its Russian text by code instead of matching English details, which remain for the journal and as a fallback.
- The live run card status reflects the actual reason: a cancel shows `Отменено пользователем` and a hold timeout `Не отправлено: Pi долго сжимал контекст`, not «Pi не принял сообщение»; the not-delivered line appears on the card once.

### Fixed

- A prompt held during manual compaction stays held while harnessd rechecks Pi's state after the hold timeout, so a cancel in that window succeeds and a Pi stop in that window reports the input as not delivered instead of uncertain.

## [0.3.2] - 2026-10-19

### Added

- Pi RPC anomaly reports: every tolerated protocol anomaly writes one `harnessd: … harness_anomaly` journal line (kind, action, record type, size, reference, redacted head). The chat hears only about real problems (a skipped record, a failed command, a harnessd handling error, Pi stopping), in plain Russian, coalesced to at most one notice per kind and minute with a repeat count; healthy tolerance stays in the journal.

### Changed

- Every Pi prompt carries `streamingBehavior: "steer"`, so a prompt racing an unseen `agent_start` is queued instead of rejected.
- A prompt submitted during manual Pi compaction is held and sent after it ends; automatic compaction holds nothing. The hold is bounded: on timeout harnessd asks Pi whether it still compacts and either sends the prompt or fails it explicitly. A held prompt can be cancelled and is then never sent.
- A rejected or unsent prompt is reported once, in Russian, with Pi's own redacted reason (`Ввод …: не принят — Pi отклонил сообщение: …`), instead of an English status line plus a separate error reply.
- The message for a Pi process that stopped is Russian and includes any record cut by the stop or a corrupted-stream cause with its journal reference.
- Pi extension `set_editor_text` requests are ignored silently instead of reported as unsupported.

### Fixed

- A long Pi run no longer gets Pi killed at its end: a stdout line over the 1 MiB record limit (such as `agent_end` carrying the whole run) is streamed with only a 16 KiB head kept and handled by its type, so the run settles and its answer is delivered. Oversized compaction events are handled too, so a large compaction summary no longer leaves prompts and reload waiting.
- Non-JSON lines, records without a type, id-less or mismatched responses, and harnessd handling errors are skipped and reported instead of stopping Pi; only stream errors, EOF/exit, or more than 20 consecutive stream anomalies (handling errors excluded) stop it. A partial record at EOF is reported as the process stopping.
- A large tool result no longer shows the tool as succeeded when its outcome could not be read; it is shown as finished without ✓ or ❌.

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
