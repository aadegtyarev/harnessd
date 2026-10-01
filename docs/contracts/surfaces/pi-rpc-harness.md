# Surface contract: Pi RPC harness

## Boundary and ownership

`PiRpcHarnessAdapter` in `src/harness/` owns Pi RPC process arguments, JSONL framing, command correlation, event decoding, prompt delivery, cancellation, and bounded shutdown. It consumes the generic `ProcessProvider`; Pi protocol details do not enter the process-provider port. It advertises launch, stop, resume, cancel, and input-submit capabilities. `SessionManager` routes input cancellation and forwards live harness events. The application runtime composes it with the process provider and configured transports; Telegram and CLI entrypoints remain future slices.

## Observable behavior

- Launches one Pi CLI process per instance with `--mode rpc`, pipe stdio, configured cwd, and optional replacement environment. The process provider must declare `process.launch` and `process.signal`; missing pipe streams fail launch.
- Readiness requires correlated `get_state` within the configured startup bound. The exact returned `data.sessionId` is exposed as `nativeSessionId`. Resume requires a native ID, passes it exactly as `--session <id>`, and rejects if readiness returns a different ID; the adapter never uses `--session-id`. Adapter-controlled session/mode flags, including `--no-session`, `--continue`/`-c`, `--resume`/`-r`, and `--fork`, cannot be overridden in configured args.
- Sends one prompt at a time. It emits pending, accepted after successful RPC acknowledgement, completed at `agent_settled` (or immediately after a successful `handled` disposition), failed on definite rejection, and uncertain when the prompt response is lost or the process exits while active. It never automatically retries. After uncertainty, another prompt is rejected until Pi settles or the instance is restarted. A timeout after prompt write throws `UncertainInputDeliveryError` carrying `InputId` without prompt content.
- Text deltas produce output events; agent lifecycle produces status events. A correlated response must contain a string ID/command and boolean success; malformed acknowledgements fail the protocol and leave prompt delivery uncertain. Dialog extension UI requests are answered with `cancelled: true` and reported as unsupported errors.
- RPC stdout is strict LF-delimited JSONL; CRLF is accepted. UTF-8 chunk boundaries are handled; U+2028/U+2029 do not delimit records. Oversized or malformed records fail explicitly and trigger bounded process cleanup. Process exit does not finalize events until stdout reaches EOF, allowing final records and acknowledgements to drain; a bounded exit-drain timeout makes missing EOF explicit. Stderr is continuously drained and neither logged nor retained. Unsupported extension UI requests emit errors; supported dialog requests are cancelled with a matching response so Pi does not stall.
- Shutdown closes stdin, waits a bounded interval, then drains stdout to EOF before finalizing; TERM and KILL waits are bounded. Protocol/process failure also initiates bounded child cleanup; shutdown remains idempotent.

## Errors, privacy, and limitations

Startup, command, protocol, process, and shutdown failures reject or emit explicit events. Timeout values must be positive integers no greater than Node's timer maximum (2,147,483,647 ms); record-size limit must be from 1 byte through 64 MiB. Diagnostic text does not contain prompt contents or stderr. Cancellation uses RPC `abort`; `agent_settled` may arrive before the abort response, so delivery is held until that response: successful abort reports failed with canceled detail, rejected abort reports completion if already settled, and lost abort response reports uncertain. Only one cancellation may be in flight per input, and abort replies are bound to their originating `InputId`. Core has no cancelled state. Process termination and recovery are not supervised beyond bounded shutdown; there is no persistence, restart/watchdog, extension UI forwarding, or delivery retry.

## Related contracts

- [Core session management](core-session-management.md)
- [Direct Node process provider](process-provider.md)
- [Harnessd v1](../features/harnessd-v1.md)
