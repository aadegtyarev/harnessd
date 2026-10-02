# harnessd v1 feature contract

**Status:** implemented; automated acceptance verified; live Telegram smoke unavailable without dedicated test credentials
**Repository:** `Hobby/harnessd` (`aadegtyarev/harnessd`, private GitHub repo)
**License:** MIT

## Goal

Provide a locally supervised, multi-session coding-agent service with independent transport and harness adapters. Telegram and Pi are the first adapters, not core dependencies.

## Scenarios and guarantees

- An authenticated operator can create, list, select, inspect, message, cancel, and stop sessions through Telegram.
- Each session has a stable supervisor ID, a selected harness adapter, a native harness session identifier when available, and its own working directory.
- The operator may select any existing local directory as `cwd`; the supervisor resolves it to a canonical path and reports inaccessible or invalid paths without starting a process.
- The supervisor launches one harness process per session in v1. A crash in one session does not stop other sessions.
- While `SessionManager` remains alive, it observes explicit process exit (not event-stream EOF), drains final events, and makes at most three native-session `resume` calls per supervisor `SessionId` with 250 ms, 1 s, and 4 s delays. The lifetime budget does not reset after a successful resume. Recovery requires a declared/implemented resume capability and saved native ID; there is no fresh-launch fallback. An input whose acceptance or completion is uncertain is marked `uncertain` with its original `InputId` and is never automatically resent; an operator must explicitly submit new work. An operator-requested stop and manager close are terminal and dominate recovery races. Recovery after supervisor process restart is not provided.
- Transport adapters and harness adapters are independent modules. Multiple transports may address the same supervisor session; they do not own session lifecycle or duplicate session state.
- Every adapter declares its capabilities. Unsupported operations fail explicitly. Harness-specific features such as skills and subagents may be supplied by plugins for that harness and are not assumed to be portable.
- Telegram uses one bot account and one polling owner. V1 accepts only updates from allowlisted numeric user IDs in private chats. Authorization and chat type are checked for every command, message, and callback before session state or actions are exposed; group and channel updates are rejected before core dispatch.
- Session metadata and recovery state use a supervisor-owned state directory selected independently of `cwd`; the supervisor does not derive its state location from or intentionally create bookkeeping inside a workspace. A broad `cwd` such as the user's home or filesystem root may contain that state directory. Supervisor-managed credentials are excluded from session metadata and supervisor logs and are not intentionally passed to harnesses by core. V1 makes no guarantee that a direct, same-user harness cannot read ambient user credentials or write user-provided/harness-visible secret material into its workspace, transcript, output, or network traffic.
- The v1 direct execution mode is explicitly identified as trusted: without a sandbox the harness has the supervisor user's OS permissions, including access to files outside `cwd`.
- Runtime execution selection defaults to direct. Isolated mode requires an injected process provider declaring `process.isolation`, `process.launch`, and `process.signal`; missing support fails before storage or transport startup and never falls back to direct. The runtime rejects caller-supplied harness arrays in isolated mode because it cannot guarantee their provider. The shipped CLI exposes `HARNESSD_EXECUTION_MODE` but has no isolation provider registration, so isolated selection fails safely.

## Interfaces and constraints

- Core owns session identity, lifecycle, persistence, dispatch, and bounded in-process process-exit recovery.
- A transport adapter translates its protocol, authentication and presentation into core operations and events.
- A harness adapter owns launch, native-session resume, input delivery, event decoding, cancellation, and shutdown to the extent supported by its harness. It exposes those differences as capabilities.
- A process-isolation provider is a separate launch boundary. The architecture permits a future bubblewrap-like provider; selecting isolation must fail closed if unavailable and must never silently fall back to direct execution. `process.isolation` is checked independently from `process.launch` and `process.signal`; the default Node provider does not claim isolation.
- A secret provider is separate from both transports and harnesses. The architecture must permit future scoped secret operations without making a wallet or raw secret values available to the model by default. v1 does not implement a wallet.
- v1 implements Telegram transport and Pi harness support. Other transports, Codex, Claude Code, sandboxing, and secret-wallet behavior are not implemented in this feature.

## Non-goals

- Public network listener, multi-host supervision, recovery after the supervisor process itself restarts, group/topic Telegram support, or automatic retry of uncertain work.
- Claiming that allowlisted Telegram access or output redaction isolates a harness from the supervisor user's other files or secrets.
- Treating bubblewrap filesystem namespaces as network isolation or as protection against kernel vulnerabilities and same-UID access.

## Affected surfaces

- [Core session management](../surfaces/core-session-management.md) — implements session lifecycle and bounded in-process watchdog recovery; process isolation and secret-provider scope remain separate.
- [Direct Node process provider](../surfaces/process-provider.md) — a standalone process primitive; it does not complete end-to-end session execution.
- [Transport adapter](../surfaces/transport-adapter.md) defines the adapter-neutral request/result/event boundary; [Telegram transport and CLI](../surfaces/telegram-transport.md) implement allowlisted private-chat operation and safe watchdog-status presentation. Transport adapters do not own recovery policy.
- Pi RPC harness support is implemented, including explicit process-exit observation and native-session resume. Recovery after supervisor restart, process isolation, and secret-provider behavior remain separate approved v1 scope and do not imply sandboxing or automatic input resend.

## Acceptance and validation

- Telegram authorization and private-chat type are checked for every update; unauthorized users and updates from groups/channels cannot enumerate sessions or trigger core actions.
- Two sessions with different working directories and native IDs route input, events, cancellation, and process failure independently.
- A mock transport can use core session operations without importing Telegram code; a mock harness can be supervised without changing core or transport code.
- Pi RPC acceptance, event streaming, cancellation, native-session resume, child exit, and bounded in-process recovery are exercised. Tests cover explicit exit versus event EOF, event draining, exact native-session identity, the three retry delays and lifetime budget, recovery failure isolation, and success/failure status ordering. Simulate a crash after input submission but before a terminal delivery event; recovery must surface `uncertain` with the original `InputId` and must not resend it. Explicit operator stop and manager close must prevent restart even when racing with recovery.
- Invalid or inaccessible `cwd` fails before process launch; any valid accessible directory is accepted, including broad parent directories. State remains in its configured supervisor-owned location rather than being relocated into the selected `cwd`.
- Missing adapter capabilities, failed startup, failed recovery, and unavailable selected isolation produce explicit safe errors and never silent no-ops or fallback.
- Verify supervisor-managed credential values do not appear in supervisor metadata/logs and state is written only under the supervisor-owned state path. Test known credential values; do not claim universal detection of secrets in harness-produced content.
- Run the repository's formatter, static checks, unit/integration tests, and end-to-end Telegram/Pi smoke checks established during implementation; report any unavailable live checks.

## Verification record

- PRs #1–#10 are merged to `main`. On merged commit `9f553abbeb3fa090e0a2b811d4a188fe8e8e25f3`, `npm test` passed (130 tests), and typecheck, build, lint, format check, and `git diff --check` passed.
- PR #9 and PR #10 received independent GPT-6.1-sol high reviews with no blocking findings. The v1 closure audit found and closed the missing distinct-workspace/native-ID and credential-sentinel regression evidence in PR #10.
- A safe Pi RPC smoke using temporary HOME/workspace/state reached readiness and shut down without sending a prompt; this does not verify real prompt acceptance, cancellation, or crash-mid-input recovery.
- Live Telegram smoke was not run because dedicated non-production test credentials were unavailable. Production credentials were not used. GitHub has no configured status checks.
