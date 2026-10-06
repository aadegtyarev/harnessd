# Feature contract: Telegram interface UX audit

**Status:** approved

## Goal

Complete a read-only Telegram interface audit for logic defects, weak or misleading feedback, and avoidable user steps.

## Scope and scenarios

Audit `/menu`; session browse/select/create/name/rename; folders; start/stop/resume/delete; model/effort; text/files; activity/errors/recovery; ForceReply/callbacks/confirmations; slash help; restart recovery; language/terminology/IDs.

## Deliverable

A read-only report on `gpt-6.1-sol:high` with a scenario map, confirmed issues with exact evidence, P0–P3 priority, impact, recommended behavior, step reduction, ordered backlog, and product questions.

## Non-goals

Code changes, implementation, Mini App, architecture rewrite, or changing durable surface contracts based only on hypotheses.

## Affected surface contracts

- [Telegram transport](../surfaces/telegram-transport.md)
- [Transport adapter](../surfaces/transport-adapter.md)
- [Core session management](../surfaces/core-session-management.md)
- [Pi RPC harness](../surfaces/pi-rpc-harness.md)
- [CLI configuration](../surfaces/cli-configuration.md)

## Constraints

Audit behavior against source, tests, contracts, and official Telegram documentation; distinguish confirmed evidence from hypotheses. Do not read or touch secrets or `.env`.

## Acceptance criteria

- Report covers the scoped scenarios and clearly ties every confirmed issue to exact evidence, priority, user impact, and recommended behavior.
- Report includes step-reduction analysis, an ordered backlog, and explicit product questions; it does not present hypotheses as confirmed defects.
- No implementation or durable surface-contract change is made as part of the audit.

## Validation

Independent evidence-based audit against source/tests/contracts and official Telegram docs; audit report consistency check; `git diff --check`.

## Temporary lifecycle

Retain this approved contract during the audit and any subsequently approved implementation planning. Do not update durable surface contracts until behavior is implemented and verified.
