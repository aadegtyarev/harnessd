# Telegram typing single-flight

Status: complete; verified and independently reviewed

## Goal and scenarios
Reduce duplicate and overlapping Telegram `sendChatAction` calls without increasing the existing four-second refresh cadence. Coalesce typing intents per chat, allow at most one unresolved raw typing call per chat, and honor valid Telegram 429 `retry_after` before any next typing attempt for that chat. Continue showing typing for chats selecting an active session; stop on deselection, settlement, error or shutdown, and resume on reselect.

## Boundaries and non-goals
Do not change message delivery, panel/card scheduling, callback/cancellation responsiveness, general API rate limits, or Telegram authorization. No bot-wide limiter or change of typing refresh interval.

## Affected surfaces
- [Telegram transport](../surfaces/telegram-transport.md)
- [Package release](../surfaces/package-release.md)

## Constraints and acceptance
- Distinct chats remain independent. Multiple concurrent triggers for one chat coalesce; slow or timed-out raw calls are not overlapped, even if they ignore abort. Honor valid 429 cooldowns including a late response after local deadline; do not shorten a valid cooldown.
- Selection and session lifecycle determine eligibility at dispatch; shutdown, deselection and settlement suppress stale continuations. Unconfirmed calls do not block unrelated API operations or shutdown beyond existing bounds. Per-chat ownership is capped at 256 entries, retaining active/in-flight or unexpired cooldown entries until safe retirement; when full, new chat typing is omitted rather than violating existing ownership. A stuck raw call retains its entry until settlement or shutdown.
- Tests cover normal refresh cadence, coalescing, slow and late calls, cooldown, selection/lifecycle transitions, shutdown, distinct chats and preservation of other operations. No production Telegram requests in tests.
- Release with version bump and dated changelog; no deployment without separate explicit approval.

## Validation
Targeted tests, full npm test, typecheck, build, lint, format:check, version:check, npm pack --dry-run and git diff --check; independent review and required PR checks.
