# Feature contract: Claude Code harness

- Status: approved
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

## Non-goals

- No Claude-specific core/transport branches where generic schemas suffice; no implicit session migration, model/permission fallback, unsupported reload/dynamic commands, or unverified cancellation.
- No production database migration or deployment under this contract; these require separate approval.

## Affected surface contracts

- [Core session management](../surfaces/core-session-management.md)
- [Telegram transport](../surfaces/telegram-transport.md)
- [CLI configuration](../surfaces/cli-configuration.md)
- [Process provider](../surfaces/process-provider.md)
- [Pi RPC harness](../surfaces/pi-rpc-harness.md)

## Acceptance and validation

- Verify canonical IDs/aliases, default and explicit option inheritance, immutable session harness identity, and additive migration behavior with focused tests.
- Verify exact-cwd `/new @alias` and panel choice; capability-driven UI, model/effort/all-six-permission restart-resume, manual permission prompt, bypass confirmation, and conditional verified cancel.
- Test bounded stream-json launch/resume with original session ID, allowlisted environment, generic session MCP file send/security, and absent usage as unavailable; confirm Claude has no reload/dynamic commands and no fallback/retry/credential reads.
- Run an isolated live Claude smoke covering creation, stream, resume, permission flow and safe cancellation where supported. Run applicable project test/typecheck/build/lint/format/version and diff checks; production migration/deploy/restart are separately approved gates.
