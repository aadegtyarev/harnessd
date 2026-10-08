# Feature contract: Claude Code harness

- Status: approved (Stage C, separately approved Telegram UX pass, and Stage E generic session-scoped MCP `send_file`)
- Goal: add Claude Code as a first-class generic harness without coupling Claude behavior into core or Telegram.

## User-visible behavior

- Offer canonical harness IDs `pi-rpc` and `claude-code`, with aliases `pi` and `claude`. Configuration chooses a default harness; expose Claude model, effort, and all six permission catalogs/defaults.
- `/new @alias <exact cwd>` selects a harness without changing the exact cwd; the session panel also offers harness selection. UI controls and actions are driven by declared capabilities.
- Each session retains its immutable harness ID. Harness choice/options inherit from `default` unless explicitly set; Claude model, effort, and each permission setting change via idle restart-and-resume of the same native session.
- Support manual Telegram permission prompts and an explicit confirmation for bypass permissions. Show cancellation only when interrupt support is verified.
- Provide generic agent file delivery through session-scoped MCP, reusing existing transport security rules.

## Interfaces and constraints

- Use a future-proof multi-harness adapter/descriptor architecture. Core and transport must not branch on Claude identity when descriptor, capability, or generic adapter-options schemas suffice.
- Store generic bounded, non-secret per-session adapter overrides with inheritance (`default`) versus explicit values. Immutable `harnessId` and options require an additive SQLite migration; production migration requires separate approval.
- Launch and resume Claude using bounded `stream-json`; resume must retain the original Claude session ID. Bound protocol input/output and child environment; pass only allowlisted environment values.
- Do not advertise reload for Claude; Pi retains dynamic commands, Claude does not. Usage absent from Claude is unavailable, never synthesized.
- Never read credentials. No automatic fallback to another harness, retry, or credential discovery.

## Separately approved Telegram UX pass (Stage C)

- Bare `/cancel` invokes the selected Pi session's current active-run cancellation, distinct from exact `/cancel <inputId>`. The current-run operation aborts the active run while preserving Pi-native queued inputs; exact-ID cancellation retains its ambiguity protections. Native authorization and session routing remain unchanged. Claude hides and refuses cancel through descriptor capability checks.
- Telegram distinguishes transport acceptance, Pi queueing behind busy work, and model consumption. When Pi is blocked in a `bg_wait`-like state, an ordinary message is explicitly reported as queued, not consumed. Bare `/cancel` releases/cancels that selected session's active input so the conversation can continue. No hidden replay occurs; neither cancellation nor uncertainty automatically reruns the queued message or background task.
- Dynamic Pi `/cost` returns its bounded actual command result to Telegram, not merely dispatch acknowledgement. Pi prompt acknowledgements contain disposition only; correlate the exact `pi-ad-session-usage:report` custom message to one outstanding `/cost`, requiring a handled disposition and bounded result window. Use fixed safe errors, quarantine after uncertainty so late results cannot be mistaken for a later command, and never replay/rerun; do not expose raw protocol or internal details.
- Stage C did not include MCP `send_file`; the separately approved Stage E scope below supersedes that limitation.

## Separately approved Stage E: generic session-scoped MCP `send_file`

- Expose exactly one `send_file` MCP tool to Claude only when the runtime supplies the generic `AgentFileSendHandler`; forward the exact session ID, workspace-relative path, and optional caption once through a per-launch loopback bearer bridge.
- Use Claude's official `--mcp-config` JSON, `--strict-mcp-config`, and `--allowedTools` mechanisms with a bounded local stdio MCP server. The MCP server exposes no transport identities, credentials, or internal details; errors are fixed and safe, delivery is never retried, and bridge/process resources are cleaned on startup failure, exit, and shutdown.
- Keep handler selection transport-neutral and share it between Pi and Claude. No live Claude/model calls are part of validation.

## Non-goals

- No Claude-specific core/transport branches where generic schemas suffice; no implicit session migration, model/permission fallback, unsupported reload/dynamic commands, or unverified cancellation.
- No production database migration or deployment under this contract; these require separate approval.

## Affected surface contracts

- [Core session management](../surfaces/core-session-management.md)
- [Telegram transport](../surfaces/telegram-transport.md)
- [CLI configuration](../surfaces/cli-configuration.md)
- [Process provider](../surfaces/process-provider.md)
- [Pi RPC harness](../surfaces/pi-rpc-harness.md)

## Affected surface contracts

- [Core session management](../surfaces/core-session-management.md)
- [Telegram transport](../surfaces/telegram-transport.md)
- [Pi RPC harness](../surfaces/pi-rpc-harness.md)

## Acceptance and validation

- Verify canonical IDs/aliases, default and explicit option inheritance, immutable session harness identity, and additive migration behavior with focused tests.
- Verify exact-cwd `/new @alias` and panel choice; capability-driven UI, model/effort/all-six-permission restart-resume, manual permission prompt, bypass confirmation, and conditional verified cancel.
- Test bounded stream-json launch/resume with original session ID, allowlisted environment, generic session MCP file send/security, and absent usage as unavailable; confirm Claude has no reload/dynamic commands and no fallback/retry/credential reads.
- Run deterministic regressions for bare and explicit Telegram cancellation, busy/queued input status and continuation without replay, and `/cost` exact result correlation, timeout, late response, and no rerun. Run an isolated live Claude smoke covering creation, stream, resume, permission flow and safe cancellation where supported. Run applicable project test/typecheck/build/lint/format/version and diff checks; production migration/deploy/restart are separately approved gates.
