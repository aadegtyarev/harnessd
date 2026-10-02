# Surface contract: Telegram transport and CLI

## Boundary, consumers, and ownership

`TelegramTransportAdapter` in `src/telegram-transport.ts` implements the generic transport port. It owns Telegram parsing, sender/chat authorization, per-private-chat session selection, safe result/event presentation, long-polling lifecycle, and a token-derived polling lock. `src/cli.ts` validates configuration and composes one adapter with `ApplicationRuntime`; core and Pi RPC do not import Telegram code. Generic request/result/event guarantees are defined by [transport adapter](transport-adapter.md).

## Configuration and authorization

- Runtime startup loads an optional `.env` from the process current working directory before validating configuration. Process-environment values take precedence, file values are parsed as Node dotenv syntax (never executed as shell), and read errors are reported without exposing contents. See [CLI configuration](cli-configuration.md).
- `HARNESSD_TELEGRAM_BOT_TOKEN` and a nonempty comma-separated `HARNESSD_TELEGRAM_ALLOWED_USER_IDS` are required. IDs must be positive safe integers. `HARNESSD_PI_EXECUTABLE` defaults to `pi`; `HARNESSD_STATE_DIR` uses the core's standard resolution; `HARNESSD_DEFAULT_CWD` optionally selects the default `/new` workspace. `harnessd --help` reports usage without requiring or loading configuration.
- `HARNESSD_EXECUTION_MODE` defaults to `direct` (trusted; `cwd` is not a sandbox). The CLI accepts only `direct` or `isolated`; because it registers no isolation provider, an isolated request fails safely before transport startup. Invalid values are rejected before configuration-driven transport construction.
- Every Telegram update passes middleware before handlers: the sender must exist, have a positive safe numeric ID in the allowlist, and the chat must be `private`. Unauthorized/missing/malformed senders and groups/channels receive no reply, session data, or core dispatch. No callback action UI is implemented.
- Allowlisted operators share access to all local sessions. The bot token is not logged or passed to Pi; child environment behavior remains the process-provider contract. Direct Pi is trusted local execution with the supervisor user's OS permissions; `cwd` is not a sandbox.

## Commands and session routing

- Supported commands: `/help`, `/sessions`, `/new [cwd]`, `/use <sessionId>`, `/inspect [sessionId]`, `/stop [sessionId]`, and `/cancel <inputId>`. Plain text submits to the session currently selected by that private chat.
- `/new` treats the entire remaining command text as one `cwd` path; if omitted, it uses `HARNESSD_DEFAULT_CWD` or falls back to the CLI process working directory. Core canonicalizes and validates either path. `/use` inspects before selection, and a failed lookup leaves the existing selection unchanged. Inspect/stop default to the selected session; cancel requires a selected session and exact `InputId`.
- Selection is volatile and private-chat-scoped. After service restart, use `/use` again. Session IDs and working directories are shown only to authorized chats.

## Event presentation and backpressure

- Output, known agent lifecycle status, generic safe error, and input-delivery notifications are labelled with the supervisor `SessionId`. Watchdog status events map to fixed messages: `harness_restarting` → “Harness is restarting.”, `harness_recovered` → “Harness recovered.”, and `harness_recovery_failed` → “Harness recovery failed.” These messages do not claim a status write succeeded and do not include raw exceptions. Plain text is used; no prompt or stderr is echoed. Model/workspace output is not universally redacted and may contain sensitive workspace data.
- Output deltas are coalesced for up to 40 ms, chunked to Telegram's 4096-character message limit, and queued per chat in session-event order. Before sending, each item rechecks that the chat still selects that session. Repeated states for one input may be coalesced only at the newest event position, preserving the relative order of retained output/status/input notifications.
- Each chat has a bounded queue (32,768 pending characters, bounded message/control counts) and each API send has a 5-second deadline. Excess output is discarded with a safe omission notice; input-delivery control items receive reserved capacity and output is evicted first. If a chat's event send times out/fails, that chat's event queue is disabled for the remainder of the service run; other recipients and core event delivery continue. Direct command replies are best-effort and time-bounded too.
- Submit uncertainty is reported with the original `InputId` in the safe correlated error result and/or event notification. No automatic resend occurs. An overflowed notification cannot cause an uncertain input to be resent.

## Polling lifecycle and failure behavior

- CLI startup initializes grammY with an abort signal before beginning long polling. A startup signal aborts initialization and runtime startup rolls back. After readiness, an unexpected fatal polling exit requests safe runtime shutdown; the CLI does not silently leave a non-polling runtime active.
- A SHA-256-derived, non-secret lock filename is created exclusively under the supervisor state directory. Its mode is `0600` and its content is only the owner PID. A second harnessd process sharing that state directory is rejected. A stale owner is removed only when the PID is demonstrably absent; ambiguous or unrecoverable lock/recovery state fails closed.
- `SIGINT`/`SIGTERM` stop the runtime. Polling stop, initialization, and notification shutdown are awaited within bounded deadlines. The lock is released only after polling termination is confirmed; incomplete cleanup retains ownership rather than allowing a second poller. Telegram API conflicts with an unrelated poller are treated as fatal; this local lock does not prevent another program from using the same bot token.
- Persisted session rows are not sufficient to prove that a Pi process is live. While the supervisor is alive, core provides bounded native-session recovery and sends the fixed status events above; Telegram only presents these events and does not own retry policy. After an unclean supervisor exit, this milestone does not reattach or restart prior processes.

## Non-goals and related contracts

Groups/channels, inline keyboard/callback actions, persistent chat selection/event history, per-user session ownership, automatic input retries, Telegram-owned watchdog policy, recovery after supervisor restart, sandboxing, and secret-wallet behavior are not provided by this surface. CLI environment loading and user-level service management are defined by [CLI configuration](cli-configuration.md) and [user service](user-service.md). See [core session management](core-session-management.md) and [Pi RPC harness](pi-rpc-harness.md).
