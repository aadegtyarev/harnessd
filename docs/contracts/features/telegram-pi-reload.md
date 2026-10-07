# Feature contract: Telegram Pi reload

Status: approved for implementation

## Goal

Provide an authorized private Telegram `/reload` command that reloads Pi resources in the current selected session, without changing session selection or restarting any process.

## Scenarios

- A selected, attached, live, idle reload-capable session reloads once; success confirms session name/full ID and unchanged selection.
- Missing, stopped, stale, unattached, unsupported, or busy targets receive fixed safe guidance. Busy includes active turns, outstanding/queued/canceling inputs, compaction, recovery, and reload.
- Selection changes before dispatch abort the operation. Concurrent requests are rejected as already running, not queued. Post-dispatch completion remains bound to the original session.
- Only a correlated successful completion of the injected extension command confirms success. Extension errors, non-handled dispositions, timeout, and process exit are safe failure/uncertain results; never retry or reveal raw details.
- The extension is injected on both launch and resume and remains available after its own reload and repeated use.

## Non-goals

No harnessd service, Pi process, or session restart; no session creation/resume/selection change; no model input, `InputId`, subprocess, retry, persistence, or unrelated command changes.

## Affected surfaces

- [Telegram transport](../surfaces/telegram-transport.md)
- [Core session management](../surfaces/core-session-management.md)
- [Pi RPC harness](../surfaces/pi-rpc-harness.md)

## Interfaces and constraints

`HarnessControl.reload` is typed. Core serializes reload per session and revalidates selected identity, live attachment, idleness, and capability immediately before dispatch. The Pi RPC harness invokes an internal injected extension command and requires a `handled` success disposition, correlated to that command path and event stream. The extension calls `await ctx.reload()` and returns immediately without reusing the old context. New files have one responsibility and are at most 100 lines. Replies and errors use fixed safe Russian text; unsupported capability fails explicitly.

## Acceptance criteria

Tests cover every scenario above, including active/queued/canceling/recovery busy states, selection race, duplicate request, exactly one RPC, extension-error false success, and absence of model/input/subprocess/retry side effects. Launch and resume injection and post-reload repeat are verified.

## Validation

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, and `git diff --check`. Do not push, open a PR, merge, deploy, or restart a service in this task.
