# Feature contract: Telegram activity bubble coalescing

Status: approved for implementation

## Goal

Project a compact, truthful activity bubble in which every visible line conveys a distinguishable user action, state, or result. Add the last meaningful update time.

## Affected surface

- [Telegram transport and CLI](../surfaces/telegram-transport.md): Telegram transport/activity projection; tests.

## Visible behavior

- Semantic child status comes from the safe allowlisted notification/status parser. Use one slot per safe role or approved display label (for example, `Worker: выполняется/завершён/ошибка`); an optional safe label may be shown.
- Show meaningful ordinary tools only. For each exact `toolCallId`, replace its row in place on running → done/failed; never add tool history.
- Show `Ещё завершено: N` only for omitted distinct meaningful operations.

## Suppression and safety

- Suppress generic `subagent · workflow`; subagent management/status/list/wait/steer/resume/control calls unless they have an approved safe display label; rows duplicated by a semantic child slot; duplicate events; terminal → running regressions; heartbeat; unchanged polling; unknown end; and raw arguments/IDs.
- Retain existing redaction, truncation, and 4096-character defenses. Never expose internal IDs or raw arguments. Exact tool-call updates replace their active row with its terminal state.
- Suppressed events consume neither row bounds, overflow count, nor update timestamp.

## Bounds and time

- At most six meaningful operation rows. Keep active and failed rows ahead of older successes.
- Footer format: `Обновлено: HH:mm:ss`, in host local time (not relative). Update only when the projected semantic model changes: thinking transition, meaningful tool/child state, visible notice/input/status/usage. Duplicate events and identical polling do not update it.
- Inject clock/formatter for deterministic time and timezone tests.

## Acceptance criteria

- Reproduce the screenshot scenario: two sequential child runs do not create alternating `workflow …`/`✓` spam; every visible line is meaningful.
- Exact duplicate events are idempotent, including timestamp stability. Running → terminal replaces one row and changes the timestamp.
- Verify semantic child slots, suppression table, six-row bound and overflow count for omitted distinct meaningful operations, and distinct active/failed semantics ahead of older successes.
- Verify deterministic local-time formatting across timezones and meaningful-only timestamp updates.

## Non-goals

- No `/reload` changes; raw reasoning or tool output; new Pi protocol, process behavior, or persistence; or service restart.
- Service installation after merge must not restart or activate the service.

## Validation

- Add/adjust activity projection tests for all acceptance criteria, using an injected deterministic clock/formatter.
- Run focused tests and the project validation suite (`npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, `git diff --check`).
