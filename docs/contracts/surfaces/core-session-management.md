# Surface contract: core session management

## Boundary and ownership

The core owns stable session identity, working-directory validation, session metadata and lifecycle decisions. It consumes harness/process functionality through adapter ports and does not import transport or harness implementations. The application runtime composes core with process, harness, and transport adapters; transports request core operations but do not own session state.

## Observable operations

- Create a session for a declared harness and existing local working directory; return its supervisor ID and current state.
- List and inspect sessions using supervisor IDs, independently of their workspace paths.
- Stop a session explicitly; an operator-requested stop is terminal and must not be restarted by recovery logic.
- Close the manager during runtime shutdown: wait for in-flight launches, attempt to stop every live instance and join its event pump, retain all session records, and aggregate cleanup errors only after attempting all instances. Already terminal session records are unchanged.
- Submit input through core-owned, supervisor-ID-addressed routing to the matching harness instance. Return the generated `InputId` only after the harness accepts the input.
- Cancel an accepted input by its `SessionId` and `InputId`, routed to the matching live harness instance after checking its declared `harness.cancel` capability. Unsupported cancellation fails explicitly; core never substitutes an adapter.
- Subscribe to live `HarnessEvent` notifications from all running instances. Each event is tagged with the originating supervisor `SessionId`; per-session order is preserved and one observer failure cannot block the harness or other observers. The core does not await asynchronous observer work; synchronous observers must return promptly. Stopping a session terminates its event pump; events arriving during shutdown may not be forwarded.
- Core validates a session ID and canonical `cwd` before persisting a starting record or invoking a harness launcher. On successful launch it persists running status and optional native session ID; launch failure persists failed status. A stop concurrent with startup waits for startup/cleanup to settle, then shuts down the available instance and records terminal stopped status; startup cannot overwrite that stop. If recording a successful start fails and shutdown also fails, core retains the instance for an explicit stop retry and reports both errors.
- Session metadata is stored in SQLite under a supervisor-owned state directory, independent of `cwd`. Resolution order is explicit configured path, `HARNESSD_STATE_DIR`, `$XDG_STATE_HOME/harnessd`, then `~/.local/state/harnessd`; all configured paths must be fully qualified absolute paths (including a drive or valid UNC share on Windows), so the process working directory is never used to select state. On POSIX, the state directory must be owned by the current user and grant no group/other access; insecure existing directories are rejected, not silently changed.
- Resolve a requested `cwd` to its canonical path before starting any harness. Reject nonexistent, non-directory, or inaccessible paths without starting a harness. Any accessible existing directory is valid, including broad parent directories.

## Interfaces and compatibility

- Session, input, and adapter identities are stable opaque IDs; consumers must not infer identity from `cwd` or native harness IDs. Harness events include output, status, error, and input-delivery variants. Input-delivery events carry the existing `InputEvent` input ID, state, and optional detail; states are pending, accepted, completed, uncertain, or failed. Core forwards live events only; it does not persist an input/event history.
- Core ports declare capabilities. Adapters may provide fewer capabilities; calls to unsupported operations return an explicit error. Harness launch, stop, input submission, and cancellation are checked independently.
- Harness-native session IDs are optional adapter-owned metadata, separate from supervisor IDs.

## Failure, security, and limits

- Invalid paths, missing adapters, unsupported capabilities, duplicate/malformed IDs, and persistence failures produce explicit errors. Invalid paths fail before launch; failed startup is not reported as running. An unexpected harness event-stream failure is surfaced as a generic session-scoped error event without exposing the underlying exception.
- State is never intentionally written under a selected workspace merely because it is the session `cwd`. POSIX state-directory ownership and mode are checked before opening SQLite; Windows ACLs are platform-managed and are not verified by core.
- Direct harness execution is trusted and runs with the supervisor user's operating-system permissions; `cwd` is not a sandbox or security boundary.
- Supervisor-managed credential values are not stored in session metadata or intentionally passed by core to harnesses. This does not guarantee that a same-user harness cannot read ambient credentials or write secret material into its workspace/output/network traffic.

## Non-goals

- Transport authentication/presentation, harness wire protocols, operating-system process supervision, watchdog/recovery policy, process isolation, or secret-wallet operations are defined by their own surfaces.

## Related contracts

- [Harnessd v1](../features/harnessd-v1.md)
- [Pi RPC harness](pi-rpc-harness.md)
