# Feature contract: Telegram transport and CLI

**Status:** Approved under the approved `harnessd-v1` contract and the user's request to continue v1
**Repository:** `Hobby/harnessd`

## Goal

Make the approved v1 Telegram transport usable through the `harnessd` CLI: authenticated private-chat operators can manage Pi sessions, submit/cancel work, and receive safe session events through the adapter-neutral runtime.

## Scenarios

- `harnessd --help` documents required configuration and the minimal command grammar. The CLI reads `HARNESSD_TELEGRAM_BOT_TOKEN` and a nonempty comma-separated `HARNESSD_TELEGRAM_ALLOWED_USER_IDS`; `HARNESSD_PI_EXECUTABLE` defaults to `pi`, and `HARNESSD_STATE_DIR` uses the core's existing state-directory resolution.
- An authorized private chat can use `/sessions`, `/new [cwd]`, `/use <sessionId>`, `/inspect [sessionId]`, `/stop [sessionId]`, and `/cancel <inputId>`. A plain text message submits to the session selected in that chat. `/new` defaults to the CLI's starting cwd; core remains responsible for canonical path validation.
- `/new` creates a Pi RPC session and selects it for that chat. `/use` verifies a session via inspect before selecting it. Session selection and chat routing are in-memory only; after service restart, operators select a session again. Allowlisted operators share the service's session authority.
- Every Telegram update passes one authorization boundary before dispatch or session data/actions are exposed: sender ID must be an allowed positive numeric ID and chat type must be `private`. Unauthorized/missing senders and groups/channels are ignored without dispatch. No callback-based action UI is provided in this slice.
- Session results use the correlated runtime dispatcher. Live text deltas are buffered/chunked within Telegram message limits and delivered in per-session order to private chats currently selecting that session. Safe status/input state and IDs are sent; raw exceptions, stderr, bot credentials, and request prompts are not echoed. Uncertain delivery is identified by its original `InputId` and is never automatically resent.
- One process owns polling for a bot token. A token-derived, non-secret lock filename is held atomically under the supervisor-owned state directory; the lock contains only the owner PID. A stale lock is removed only when its PID is demonstrably absent; unreadable/ambiguous locks fail closed. Runtime shutdown releases the lock and stops polling.
- `SIGINT`/`SIGTERM` close the runtime; startup failures roll back already-started resources. CLI and transport diagnostics never print the bot token or raw API/process errors. The Pi child keeps the process provider's existing empty-by-default environment; Telegram credentials are not copied into harness environment.

## Non-goals

- Group/channel chats, inline keyboards or callback actions, multiple bot accounts, per-user session ownership, persistent Telegram selection state, or a new storage schema.
- Watchdog/process restart, sandboxing, secret-wallet operations, Codex/Claude adapters, retries/resubmission of uncertain inputs, or arbitrary transport configuration.
- Universal redaction of model/workspace output: allowlisted private-chat operators can receive harness output, which may contain user/workspace data. Direct execution remains trusted and `cwd` is not a sandbox.

## Affected surface contracts

- [`docs/contracts/surfaces/transport-adapter.md`](../surfaces/transport-adapter.md)
- [`docs/contracts/surfaces/core-session-management.md`](../surfaces/core-session-management.md)
- [`docs/contracts/surfaces/pi-rpc-harness.md`](../surfaces/pi-rpc-harness.md)
- [`docs/contracts/surfaces/process-provider.md`](../surfaces/process-provider.md)
- [`docs/contracts/features/harnessd-v1.md`](harnessd-v1.md)

A Telegram-specific durable surface contract will be created after verification; none exists yet.

## Interfaces and constraints

- Use the existing `grammy` dependency and `TransportAdapter`/`ApplicationRuntime` boundaries. Telegram code must not enter core or harness modules.
- The bot token is provided only to the Telegram client and is never logged, persisted in session metadata, or passed to Pi. Authorization uses the Telegram numeric sender ID as `principalId`; the transport does not trust a caller-supplied identity.
- The per-chat selected session map is volatile and private-chat-scoped. Session IDs, not `cwd` or native Pi IDs, identify operations.
- Catch/format API and observer failures with safe messages. Output notifications are best-effort, asynchronous, bounded, and ordered; one chat/observer failure cannot block core event delivery or another recipient.
- Do not change core storage schema or advertise isolation: direct Pi has the supervisor user's OS permissions. Preserve capability failures and uncertain-input safety.

## Acceptance and validation

- Mocked Bot/API tests cover every command and plain-message route, malformed input/IDs, allowed and unauthorized users, missing sender, private versus group/channel chats, and prove rejected updates cannot dispatch or expose session data.
- Tests cover selected-chat event routing, safe error/input/status formatting, chunking/buffering, input cancellation correlation, uncertainty without resend, subscription disposal, polling lock acquisition/release/stale/ambiguous locks, startup failure cleanup, and idempotent stop.
- CLI tests cover help/config validation, safe diagnostics, runtime composition, SIGINT/SIGTERM shutdown, and prove no bot token is passed into the Pi child environment.
- Update the Telegram and transport surface contracts and add root usage documentation. Run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, and `git diff --check`. No live Telegram token or Pi launch is required for automated tests; report that live smoke checks remain unavailable/not run.
