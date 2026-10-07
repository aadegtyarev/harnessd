# Feature contract: Telegram subagent status redaction

Status: approved for implementation

## Goal and user-visible behavior

Hide internal async subagent status envelopes while presenting a tightly normalized status in the existing attributed activity bubble.

## Expected scenarios

- Exact service-envelope lines are parsed safely across streamed chunks and never exposed.
- A valid snapshot selects the last `runs[]` item with `kind: 'subagent'`; only normalized role and state may render.
- Malformed, unsupported, empty, prose-lookalike, and code-lookalike content stays hidden or preserved as specified below.
- Status coalesces into one attributed activity bubble, never creates a new message, and does not alter background runs or final-answer delivery.

## Non-goals

No child/status expansion, raw payload logging, new message types, persistence, or changes to attribution, chunking, overflow, or resend behavior.

## Affected surface-contract links

- [Telegram transport and CLI](../surfaces/telegram-transport.md)

## Interfaces and constraints

- Recognize exact `PI_SUBAGENT_ASYNC_JSON:` service-envelope lines with optional surrounding whitespace and optional exact `Pi:` prefix; marker/JSON may span chunks. Do not recognize prose, inline, or fenced-code lookalikes.
- The accepted schema is top-level `{kind:'pi-subagents.async-status-snapshot',runs:[{kind:'subagent',label:'scout',state:'running'}]}`. Ignore every other field, including IDs, timestamps, activity, capabilities, omissions, and children. Never log or render raw content.
- Normalize labels case-insensitively to Scout, Worker, Reviewer, or Researcher; otherwise use `Помощник`. Map pending/queued→`ожидает`, running/active→`выполняется`, completed/succeeded→`завершён`, failed/error/stopped→`ошибка`; unknown state uses `Задача помощника: обновляется`.
- For malformed/unsupported/empty envelopes, hide the envelope without changing the bubble. For valid snapshots, show only the last relevant run's normalized status in the single existing activity-bubble status slot for an attributed Telegram turn. Never create a separate message or background-run bubble.
- Coalesce to the latest value; identical values do not cause edits beyond existing debounce/throttle. Status remains until normal settlement cleanup. A widget-only turn has no final answer; widget plus text preserves real text.
- Preserve attribution, footer, chunking, overflow, and no-resend behavior. Sentinel IDs must be absent from every sent/edited payload.

## Acceptance criteria

- Deterministic tests cover schema and normalization, malformed/empty handling, split chunks, lookalikes, coalescing, terminal lifecycle, attributed/background delivery, widget-only/text, 100 identical updates without 100 edits or overflow, and absence of sentinel IDs in all sent/edited payloads.
- Full project test, typecheck, build, lint, format, version, and diff checks pass.

## Validation

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, and `git diff --check`.
