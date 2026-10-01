# Surface contract: core session management

## Boundary and ownership

The core owns stable session identity, working-directory validation, session metadata and lifecycle decisions. It consumes harness/process functionality through adapter ports and does not import transport or harness implementations. Transports request core operations; they do not own session state.

## Observable operations

- Create a session for a declared harness and existing local working directory; return its supervisor ID and current state.
- List and inspect sessions using supervisor IDs, independently of their workspace paths.
- Stop a session explicitly; an operator-requested stop is terminal and must not be restarted by recovery logic.
- Submit input through core-owned, supervisor-ID-addressed routing to the matching harness instance. Unsupported operations fail with a structured capability error; core never silently substitutes an adapter.
- Core validates a session ID and canonical `cwd` before persisting a starting record or invoking a harness launcher. On successful launch it persists running status and optional native session ID; launch failure persists failed status. Stop shuts down an available instance then records terminal stopped status.
- Session metadata is stored in SQLite under a supervisor-owned state directory, independent of `cwd`. Resolution order is explicit configured path, `HARNESSD_STATE_DIR`, `$XDG_STATE_HOME/harnessd`, then `~/.local/state/harnessd`; the process working directory is never used to select state.
- Resolve a requested `cwd` to its canonical path before starting any harness. Reject nonexistent, non-directory, or inaccessible paths without starting a harness. Any accessible existing directory is valid, including broad parent directories.

## Interfaces and compatibility

- Session, input, and adapter identities are stable opaque IDs; consumers must not infer identity from `cwd` or native harness IDs.
- Core ports declare capabilities. Adapters may provide fewer capabilities; calls to unsupported operations return an explicit error. Harness launch, stop, and input submission are checked independently.
- Harness-native session IDs are optional adapter-owned metadata, separate from supervisor IDs.

## Failure, security, and limits

- Invalid paths, missing adapters, unsupported capabilities, duplicate/malformed IDs, and persistence failures produce explicit errors. Invalid paths fail before launch; failed startup is not reported as running.
- State is never intentionally written under a selected workspace merely because it is the session `cwd`.
- Direct harness execution is trusted and runs with the supervisor user's operating-system permissions; `cwd` is not a sandbox or security boundary.
- Supervisor-managed credential values are not stored in session metadata or intentionally passed by core to harnesses. This does not guarantee that a same-user harness cannot read ambient credentials or write secret material into its workspace/output/network traffic.

## Non-goals

- Transport authentication/presentation, harness wire protocols, operating-system process supervision, watchdog/recovery policy, process isolation, or secret-wallet operations are defined by their own surfaces.

## Related contracts

- [Harnessd v1](../features/harnessd-v1.md)
