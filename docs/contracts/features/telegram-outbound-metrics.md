# Telegram outbound aggregate diagnostics

Status: approved

## Goal and scenarios
Identify potential combined Telegram API request bursts without changing delivery. Count aggregate outbound calls at the grammY API boundary, including startup, polling, presentation, typing and retries. Report bounded per-method request starts, completed result classes, peak simultaneous requests and busiest fixed one-second bucket per periodic interval; synthetic tests reproduce overlapping lanes and bursts.

## Non-goals
No global limiter, retries, pacing, API request changes, chat-level attribution, token rotation, or production deployment. Aggregate counts do not prove Telegram rate-limit or ban causes.

## Affected surfaces
- [Telegram transport](../surfaces/telegram-transport.md)
- [CLI configuration](../surfaces/cli-configuration.md)
- [Package release](../surfaces/package-release.md)

## Interfaces and constraints
- Fixed allowlisted method names and bounded fixed-size result counters. No payload, URL, token, message text, identifier, raw error, exact request timestamps or per-chat data in diagnostics.
- Periodic aggregated journal line at most once per minute while activity exists, plus one final partial-window line on shutdown when activity exists, including 429 counts and in-flight peak; idle periods produce no lines. Stop timers at shutdown and isolate all diagnostic failures from call results, startup and shutdown.
- Count request attempts, not inferred messages, and classify raw responses and thrown errors without altering them. Polling is reported separately by method. Record that a raw request can stay in flight across windows. No behavior changes to ordering, cancellation, deadlines, polling or duplicate handling.
- Tests use synthetic requests only and verify combined bursts, classification, overlapping calls, interval boundaries, idle suppression, shutdown, redaction and logging-failure isolation. Bump minor version for the new diagnostic capability and add dated changelog.

## Validation
Targeted tests plus npm test, typecheck, build, lint, format:check, version:check, package dry-run and git diff --check; independent review and required PR checks before merge.
