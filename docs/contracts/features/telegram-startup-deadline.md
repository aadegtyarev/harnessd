# Telegram startup deadline

Status: approved

## Goal and scenarios
Bound Telegram initialization so persistent network failures or a stalled initialization cannot leave the service silently active but unable to poll. On deadline, abort initialization, fail startup and allow the service manager to restart it. Normal initialization and externally requested shutdown retain their existing behavior.

## Non-goals
No changes to polling protocol, normal delivery, rate-limit policy, persistence, or watchdog. Investigate HTTP 429 separately before proposing changes.

## Affected surfaces
- [Telegram transport](../surfaces/telegram-transport.md)
- [User service](../surfaces/user-service.md)
- [Package release](../surfaces/package-release.md)

## Constraints and acceptance
- Abort initialization on deadline; ensure startup fails with a safe diagnostic and cleanup respects existing polling lock ownership rules even if underlying calls do not settle.
- No overlapping pollers or retry of user input. Externally aborted startup continues to roll back.
- Successful startup still polls; tests cover deadline, abort, cleanup and a subsequent successful start.
- Patch release and dated changelog entry.

## Validation
Targeted tests, npm test, typecheck, build, lint, format:check, version:check and git diff --check; PR and remote checks before merge.
