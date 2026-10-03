# TODO

## Telegram file exchange

- [ ] Add bidirectional transfer of arbitrary file types between authorized Telegram chats and the selected harnessd session, subject to Telegram Bot API transfer limits.
  - Agent → Telegram: let the active session send files with their original filenames and an optional caption.
  - Telegram → agent: receive files into a per-session `inbox/` under harnessd-owned session/state storage (candidate: `$HARNESSD_STATE_DIR/inbox/<SessionId>/`), never into the project `cwd`; provide the resulting local path to the selected session through an explicit, safe flow.
  - Keep file contents out of SQLite and do not silently write incoming files into the workspace.
  - Define per-file and aggregate size/count quotas, retention TTL, cleanup triggers, and protection against deleting files while a session is using them. Clean up expired inbox data and handle session deletion.
  - Before implementation, contract the source/destination permissions, path/symlink handling, filename sanitization, Telegram transfer limits, and cleanup behavior.
