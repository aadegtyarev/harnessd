# Surface contract: core session management

## Boundary and ownership

The core owns stable session identity, working-directory validation, session metadata and lifecycle decisions. It consumes harness/process functionality through adapter ports and does not import transport or harness implementations. Transports request core operations; they do not own session state.

## Observable operations

- Create a session for a declared harness and existing local working directory; return its supervisor ID and current state.
- List and inspect sessions using supervisor IDs, independently of their workspace paths.
- Stop a session explicitly; an operator-requested stop is terminal and must not be restarted by recovery logic.
- Submit input through core-owned, supervisor-ID-addressed routing to the matching harness instance. Unsupported operations fail with a structured capability error; core never silently substitutes an adapter.
- Core validates a session ID and canonical `cwd` before persisting a starting record or invoking a harness launcher. On successful launch it persists running status and optional native session ID; launch failure persists failed status. A stop concurrent with startup waits for startup/cleanup to settle, then shuts down the available instance and records terminal stopped status; startup cannot overwrite that stop. If recording a successful start fails and shutdown also fails, core retains the instance for an explicit stop retry and reports both errors.
- Session metadata is stored in SQLite under a supervisor-owned state directory, independent of `cwd`. Resolution order is explicit configured path, `HARNESSD_STATE_DIR`, `$XDG_STATE_HOME/harnessd`, then `~/.local/state/harnessd`; all configured paths must be absolute, so the process working directory is never used to select state. On POSIX, the state directory must be owned by the current user and grant no group/other access; insecure existing directories are rejected, not silently changed.
- Resolve a requested `cwd` to its canonical path before starting any harness. Reject nonexistent, non-directory, or inaccessible paths without starting a harness. Any accessible existing directory is valid, including broad parent directories.

## Interfaces and compatibility

- Session, input, and adapter identities are stable opaque IDs; consumers must not infer identity from `cwd` or native harness IDs.
- Core ports declare capabilities. Adapters may provide fewer capabilities; calls to unsupported operations return an explicit error. Harness launch, stop, and input submission are checked independently.
- Harness-native session IDs are optional adapter-owned metadata, separate from supervisor IDs.

## Failure, security, and limits

- Invalid paths, missing adapters, unsupported capabilities, duplicate/malformed IDs, and persistence failures produce explicit errors. Invalid paths fail before launch; failed startup is not reported as running.
- State is never intentionally written under a selected workspace merely because it is the session `cwd`. POSIX state-directory ownership and mode are checked before opening SQLite; Windows ACLs are platform-managed and are not verified by core.
- Direct harness execution is trusted and runs with the supervisor user's operating-system permissions; `cwd` is not a sandbox or security boundary.
- Supervisor-managed credential values are not stored in session metadata or intentionally passed by core to harnesses. This does not guarantee that a same-user harness cannot read ambient credentials or write secret material into its workspace/output/network traffic.

## Non-goals

- Transport authentication/presentation, harness wire protocols, operating-system process supervision, watchdog/recovery policy, process isolation, or secret-wallet operations are defined by their own surfaces.

## Related contracts

- [Harnessd v1](../features/harnessd-v1.md)
