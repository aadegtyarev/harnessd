# Surface contract: Telegram transport and CLI

## Boundary, consumers, and ownership

`TelegramTransportAdapter` in `src/telegram-transport.ts` implements the generic transport port. It owns Telegram parsing, sender/chat authorization, per-private-chat session selection, safe result/event presentation, long-polling lifecycle, and a token-derived polling lock. `src/cli.ts` validates configuration and composes one adapter with `ApplicationRuntime`; core and Pi RPC do not import Telegram code. Generic request/result/event guarantees are defined by [transport adapter](transport-adapter.md).

## Configuration and authorization

- `HARNESSD_TELEGRAM_BOT_TOKEN` and a nonempty comma-separated `HARNESSD_TELEGRAM_ALLOWED_USER_IDS` are required. IDs must be positive safe integers. `HARNESSD_PI_EXECUTABLE` defaults to `pi`; `HARNESSD_STATE_DIR` uses the core's standard resolution. `harnessd --help` reports usage without requiring configuration.
- Every Telegram update passes middleware before handlers: the sender must exist, have a positive safe numeric ID in the allowlist, and the chat must be `private`. Unauthorized/missing/malformed senders and groups/channels receive no reply, session data, or core dispatch. No callback action UI is implemented.
- Allowlisted operators share access to all local sessions. The bot token is not logged or passed to Pi; child environment behavior remains the process-provider contract. Direct Pi is trusted local execution with the supervisor user's OS permissions; `cwd` is not a sandbox.

## Commands and session routing

- Supported commands: `/help`, `/sessions`, `/new [cwd]`, `/use <sessionId>`, `/inspect [sessionId]`, `/stop [sessionId]`, and `/cancel <inputId>`. Plain text submits to the session currently selected by that private chat.
- `/new` treats the entire remaining command text as one `cwd` path (or uses the CLI's starting directory when omitted); core canonicalizes and validates it. `/use` inspects before selection, and a failed lookup leaves the existing selection unchanged. Inspect/stop default to the selected session; cancel requires a selected session and exact `InputId`.
- Selection is volatile and private-chat-scoped. After service restart, use `/use` again. Session IDs and working directories are shown only to authorized chats.

## Event presentation and backpressure

- Output, known agent lifecycle status, generic safe error, and input-delivery notifications are labelled with the supervisor `SessionId`. Plain text is used; no prompt or stderr is echoed. Model/workspace output is not universally redacted and may contain sensitive workspace data.
- Output deltas are coalesced for up to 40 ms, chunked to Telegram's 4096-character message limit, and queued per chat in session-event order. Before sending, each item rechecks that the chat still selects that session. Repeated states for one input may be coalesced only at the newest event position, preserving the relative order of retained output/status/input notifications.
- Each chat has a bounded queue (32,768 pending characters, bounded message/control counts) and each API send has a 5-second deadline. Excess output is discarded with a safe omission notice; input-delivery control items receive reserved capacity and output is evicted first. If a chat's event send times out/fails, that chat's event queue is disabled for the remainder of the service run; other recipients and core event delivery continue. Direct command replies are best-effort and time-bounded too.
- Submit uncertainty is reported with the original `InputId` in the safe correlated error result and/or event notification. No automatic resend occurs. An overflowed notification cannot cause an uncertain input to be resent.

## Polling lifecycle and failure behavior

- CLI startup initializes grammY with an abort signal before beginning long polling. A startup signal aborts initialization and runtime startup rolls back. After readiness, an unexpected fatal polling exit requests safe runtime shutdown; the CLI does not silently leave a non-polling runtime active.
- A SHA-256-derived, non-secret lock filename is created exclusively under the supervisor state directory. Its mode is `0600` and its content is only the owner PID. A second harnessd process sharing that state directory is rejected. A stale owner is removed only when the PID is demonstrably absent; ambiguous or unrecoverable lock/recovery state fails closed.
- `SIGINT`/`SIGTERM` stop the runtime. Polling stop, initialization, and notification shutdown are awaited within bounded deadlines. The lock is released only after polling termination is confirmed; incomplete cleanup retains ownership rather than allowing a second poller. Telegram API conflicts with an unrelated poller are treated as fatal; this local lock does not prevent another program from using the same bot token.
- Persisted session rows are not sufficient to prove that a Pi process is live. After an unclean supervisor exit, this milestone does not reattach or restart prior processes; bounded watchdog/recovery is a separate v1 milestone.

## Non-goals and related contracts

Groups/channels, inline keyboard/callback actions, persistent chat selection/event history, per-user session ownership, automatic retries, watchdog/recovery, sandboxing, and secret-wallet behavior are not provided by this surface. See [harnessd v1](../features/harnessd-v1.md), [core session management](core-session-management.md), and [Pi RPC harness](pi-rpc-harness.md).
