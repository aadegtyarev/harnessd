# Feature contract: Dynamic Pi extension commands

**Status:** Approved for implementation; contract-only task.
**Branch/base:** `feat/dynamic-pi-commands` at `45e6d40667bb9d2dbb2cde31b0baeca6a13b99bc`.

## Goal

Expose discovered Pi extension commands through Telegram for the chat's selected live session, while preserving native command authority and safe delivery semantics.

## Approved behavior

- Discover and expose extension-source commands only. Prompt templates and skills are excluded. Native harnessd commands always take precedence; collisions are blocked rather than aliased. Native `/reload` remains present, useful in help/menu, and cannot be shadowed.
- `/cost` is the first scenario only if a discovered extension supplies it; do not synthesize it.
- Dispatch only to the chat's selected live session. Never implicitly resume or create a session. Busy dispatch is permitted in accordance with Pi extension-command semantics.
- Dispatch through RPC `prompt` using `/name` plus the exact raw remainder after the command name; preserve its original spacing and do not tokenize or normalize it.
- Treat RPC acceptance/handled disposition conservatively: acknowledge only what is confirmed, without claiming extension completion or user-visible output. Errors are safe and bounded; uncertain/rejected calls are not retried.
- Obtain fresh command inventory at help and at the dispatch boundary. Refresh inventories on readiness, resume, recovery, and reload. Expose selected-session dynamic commands in help.
- Publish per-chat Telegram command menus with native commands first, up to Telegram's 100-command limit, using deterministic truncation. Update menus when selection changes and on new/resume/reload/recovery/stop/delete transitions.
- Never expose Pi `sourceInfo` or its paths.

## Non-goals

Prompt-template/skill execution, synthetic native `/cost`, implicit resume/create, retries, sourceInfo disclosure, changing native command behavior, and broader Pi/RPC features are excluded.

## Affected contracts and paths

- Surface contracts: [Telegram transport](../surfaces/telegram-transport.md), [Pi RPC harness](../surfaces/pi-rpc-harness.md), [core session management](../surfaces/core-session-management.md).
- Expected implementation/test surfaces: `src/command-catalog.ts`, `src/telegram-transport.ts`, `src/harness/pi-rpc-harness.ts`, `src/core/ports.ts`, `src/core/session-manager.ts`, `src/application-runtime.ts`; `test/command-catalog.test.ts`, `test/telegram-transport.test.ts`, `test/pi-rpc-harness.test.ts`, `test/core.test.ts`, `test/application-runtime.test.ts`.

## Acceptance criteria

1. Only discovered extension-source commands are eligible; native names, especially `/reload`, remain native and collisions cannot dispatch to Pi.
2. Help inventories the selected live session freshly; dispatch refreshes inventory and sends the exact raw argument remainder only to the currently selected live session. No selection/stopped target causes safe guidance without resume; busy dispatch follows Pi extension semantics.
3. `/cost` is available only when discovered. Acceptance/handled results make no completion claim; failures are safe and never retried; sourceInfo is never presented.
4. Per-chat menus list native entries first and at most 100 total with deterministic truncation; required lifecycle/selection changes update the relevant menus, keeping `/reload` useful and unshadowed.
5. Tests cover inventory filtering/refresh, collision and reload protection, raw remainder, routing/readiness/busy/error behavior, selected-session help, menu limit/order/truncation, and menu lifecycle updates.

## Validation gates

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, and `git diff --check`. Review the diff against this contract and all three affected surface contracts; update durable surface contracts only after behavior is verified. Live Pi smoke is not an acceptance prerequisite where the existing documented isolated Pi 1.0.4 limitation applies; report it as residual risk if unverified.
