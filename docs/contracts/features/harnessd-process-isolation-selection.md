# Feature contract: fail-closed process isolation selection

**Status:** Approved for implementation by the user
**Repository:** `Hobby/harnessd`

## Goal

Complete the v1 process-isolation selection boundary without implementing a sandbox. Preserve trusted direct execution while ensuring that an explicit isolated-mode request cannot silently run through the direct Node provider.

## Scenarios and guarantees

- Existing callers and the CLI default to `direct`, preserving current behavior. Direct execution is explicitly identified as trusted and `cwd` is not presented as a security boundary.
- `ApplicationRuntime` accepts an explicit execution mode (`direct` or `isolated`) and an optional injected `ProcessProvider`.
- In `isolated` mode, the runtime uses only the injected provider when it declares `process.isolation`, `process.launch`, and `process.signal`. If the provider is absent or lacks any required capability, startup fails with a stable, safe isolation-unavailable error before opening session storage, starting transports, or launching a process.
- The CLI reads `HARNESSD_EXECUTION_MODE` (`direct` or `isolated`, default `direct`). Because the shipped CLI does not register an isolation provider, requesting `isolated` fails explicitly and safely; it never falls back to direct execution.
- Invalid mode values fail before runtime side effects. Provider selection does not cross the harness/process/transport boundaries.

## Non-goals

- Implementing bubblewrap or any other sandbox, filesystem/network isolation policy, or a provider that claims isolation without enforcing it.
- Changing direct execution permissions/environment semantics, supervisor-restart recovery, secret-wallet implementation, Telegram polling behavior, or harness RPC.
- Implementing secret-grant workflows; the existing `SecretProvider` port remains an architectural seam and wallet behavior remains outside v1.

## Affected surface contracts

- [`docs/contracts/features/harnessd-v1.md`](harnessd-v1.md)
- [`docs/contracts/surfaces/process-provider.md`](../surfaces/process-provider.md)
- [`docs/contracts/surfaces/core-session-management.md`](../surfaces/core-session-management.md)
- [`docs/contracts/surfaces/pi-rpc-harness.md`](../surfaces/pi-rpc-harness.md)
- [`docs/contracts/surfaces/telegram-transport.md`](../surfaces/telegram-transport.md)

## Interfaces and constraints

- Runtime composition selects one `ProcessProvider`; Pi RPC continues to consume only the generic process port.
- `process.isolation` is an explicit provider guarantee, independently checked from `process.launch` and `process.signal`. Unsupported or unavailable isolation fails closed.
- The default remains direct for compatibility, but CLI help and durable docs label it trusted. Project configuration must not imply that direct execution is sandboxed.
- Safe startup diagnostics exclude environment values, executable arguments, and raw provider errors.

## Acceptance and validation

- Tests show omitted/explicit `direct` preserve current provider composition and behavior.
- Tests show `isolated` with no provider, missing `process.isolation`, or missing launch/signal capabilities rejects before storage open, transport start, or any process launch; no direct fallback occurs.
- A provider declaring all required capabilities is passed unchanged to `PiRpcHarnessAdapter` in isolated mode.
- CLI tests cover default, both accepted values, and invalid values without exposing configuration details.
- Run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, and `git diff --check`.
