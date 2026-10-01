# Surface contract: direct Node process provider

## Boundary, consumers, and ownership

The process-provider boundary offers reusable local child-process launch and signal delivery for future adapters. `NodeProcessProvider` implements the core `ProcessProvider` port and is exported from `src/process/`; it is not wired into session management, a harness, or the CLI.

## Inputs, outputs, and guarantees

- Launch receives an executable, exact argument vector, cwd, optional replacement environment, and optional stdio mode. It uses Node `spawn` with `shell: false` and passes only the provided environment; omitted environment is empty rather than inherited. Node's ambient environment pass-through keys (`NODE_V8_COVERAGE` and z/OS runtime variables) are masked unless explicitly provided. When Node's permission model is active, Node may propagate its permission flags through `NODE_OPTIONS` to preserve that runtime restriction.
- Stdio defaults to `ignore` to preserve existing callers; the handle's stdin, stdout, and stderr are null in that mode. Explicit `pipe` mode returns the child's real writable stdin and readable stdout/stderr streams. Other runtime values are rejected explicitly.
- Launch resolves only after Node reports the OS spawn-success event. Startup failures reject. A handle has an opaque provider-generated process ID, an exit promise containing the OS exit code and signal, and `sendSignal`. Stream end/close and child exit are independent lifecycle observations; the caller owns closing stdin and draining stdout/stderr. Streams use Node backpressure semantics, and the provider neither buffers nor captures/logs output. Consumers must drain output as appropriate to avoid blocking the child.
- Signals must be recognized by the current Node platform. Invalid signals and unsuccessful delivery reject explicitly.
- The provider declares `process.launch` and `process.signal`. Executable arguments and environment values are not logged.

## Security limits and non-goals

Execution is direct and trusted with the supervisor user's OS permissions; cwd is not a sandbox. The provider does not capture output, launch through a shell, automatically terminate/retry/escalate, supervise or restart processes, or guarantee identical signal behavior across operating systems. The process primitive alone is not end-to-end session execution.

## Related contracts

- [Core session management](core-session-management.md)
- [Harnessd v1](../features/harnessd-v1.md)
- [Pi RPC harness](pi-rpc-harness.md)
