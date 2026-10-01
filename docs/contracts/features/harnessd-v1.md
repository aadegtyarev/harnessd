# harnessd v1 feature contract

**Status:** approved for implementation
**Repository:** `Hobby/harnessd` (`aadegtyarev/harnessd`, private GitHub repo)
**License:** MIT

## Goal

Provide a locally supervised, multi-session coding-agent service with independent transport and harness adapters. Telegram and Pi are the first adapters, not core dependencies.

## Scenarios and guarantees

- An authenticated operator can create, list, select, inspect, message, cancel, and stop sessions through Telegram.
- Each session has a stable supervisor ID, a selected harness adapter, a native harness session identifier when available, and its own working directory.
- The operator may select any existing local directory as `cwd`; the supervisor resolves it to a canonical path and reports inaccessible or invalid paths without starting a process.
- The supervisor launches one harness process per session in v1. A crash in one session does not stop other sessions.
- A watchdog records process failure and restarts the harness when recovery is supported, using bounded backoff. It resumes the saved native session where possible. An input whose acceptance or completion is uncertain is marked `uncertain` and is never automatically resent, even after notification; an operator must explicitly submit a new input. An operator-requested stop is terminal and is not restarted by the watchdog.
- Transport adapters and harness adapters are independent modules. Multiple transports may address the same supervisor session; they do not own session lifecycle or duplicate session state.
- Every adapter declares its capabilities. Unsupported operations fail explicitly. Harness-specific features such as skills and subagents may be supplied by plugins for that harness and are not assumed to be portable.
- Telegram uses one bot account and one polling owner. V1 accepts only updates from allowlisted numeric user IDs in private chats. Authorization and chat type are checked for every command, message, and callback before session state or actions are exposed; group and channel updates are rejected before core dispatch.
- Session metadata and recovery state use a supervisor-owned state directory selected independently of `cwd`; the supervisor does not derive its state location from or intentionally create bookkeeping inside a workspace. A broad `cwd` such as the user's home or filesystem root may contain that state directory. Supervisor-managed credentials are excluded from session metadata and supervisor logs and are not intentionally passed to harnesses by core. V1 makes no guarantee that a direct, same-user harness cannot read ambient user credentials or write user-provided/harness-visible secret material into its workspace, transcript, output, or network traffic.
- The v1 direct execution mode is explicitly identified as trusted: without a sandbox the harness has the supervisor user's OS permissions, including access to files outside `cwd`.

## Interfaces and constraints

- Core owns session identity, lifecycle, persistence, dispatch, and process supervision.
- A transport adapter translates its protocol, authentication and presentation into core operations and events.
- A harness adapter owns launch, native-session resume, input delivery, event decoding, cancellation, and shutdown to the extent supported by its harness. It exposes those differences as capabilities.
- A process-isolation provider is a separate launch boundary. The architecture must permit a future bubblewrap-like provider; selecting isolation must fail closed if unavailable and must never silently fall back to direct execution.
- A secret provider is separate from both transports and harnesses. The architecture must permit future scoped secret operations without making a wallet or raw secret values available to the model by default. v1 does not implement a wallet.
- v1 implements Telegram transport and Pi harness support. Other transports, Codex, Claude Code, sandboxing, and secret-wallet behavior are not implemented in this feature.

## Non-goals

- Public network listener, multi-host supervision, group/topic Telegram support, or automatic retry of uncertain work.
- Claiming that allowlisted Telegram access or output redaction isolates a harness from the supervisor user's other files or secrets.
- Treating bubblewrap filesystem namespaces as network isolation or as protection against kernel vulnerabilities and same-UID access.

## Affected surfaces

- [Core session management](../surfaces/core-session-management.md) — implemented in the bounded core-foundation milestone; this does not complete the broader v1 transport, harness, watchdog, isolation, or secret-provider scope.
- [Direct Node process provider](../surfaces/process-provider.md) — a standalone process primitive; it does not complete end-to-end session execution.
- Transport, harness-adapter, and process-isolation surfaces will be documented as their later milestones are implemented.

## Acceptance and validation

- Telegram authorization and private-chat type are checked for every update; unauthorized users and updates from groups/channels cannot enumerate sessions or trigger core actions.
- Two sessions with different working directories and native IDs route input, events, cancellation, and process failure independently.
- A mock transport can use core session operations without importing Telegram code; a mock harness can be supervised without changing core or transport code.
- Pi RPC acceptance, event streaming, cancellation, native-session resume, child exit, and bounded restart behavior are exercised. Simulate a crash after input submission but before acceptance confirmation; recovery must surface `uncertain` and must not resend it. Explicit operator stop must not trigger restart.
- Invalid or inaccessible `cwd` fails before process launch; any valid accessible directory is accepted, including broad parent directories. State remains in its configured supervisor-owned location rather than being relocated into the selected `cwd`.
- Missing adapter capabilities, failed startup, failed recovery, and unavailable selected isolation produce explicit safe errors and never silent no-ops or fallback.
- Verify supervisor-managed credential values do not appear in supervisor metadata/logs and state is written only under the supervisor-owned state path. Test known credential values; do not claim universal detection of secrets in harness-produced content.
- Run the repository's formatter, static checks, unit/integration tests, and end-to-end Telegram/Pi smoke checks established during implementation; report any unavailable live checks.
