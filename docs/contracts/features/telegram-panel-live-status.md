# Feature contract: Telegram panel live status

**Status:** Approved for implementation
**Branch:** `feat/telegram-panel-live-status`

## Goal

Show truthful, useful live status for the session currently previewed by each authorized private-chat panel, without confusing it with the independently selected ordinary-message destination. The panel refreshes promptly while limiting Telegram edits and never presents cached/stale values as current.

## Affected surface

- [Telegram transport and CLI](../surfaces/telegram-transport.md)

## User-visible scenarios

- Panel labels preview and selected session separately. Status belongs to preview only.
- Lifecycle comes from core. Live fields (model, effort, usage, context) come from Pi `session_status`; busy/idle comes from authoritative agent events. Reload/recovery operation state is shown while applicable.
- Render lifecycle taxonomy: `idle`, `busy`, `reloading`, `starting`, `recovering`, `stopped`, `failed`, `stale`, `live unavailable`, `offline` (only for confirmed absence).
- Startup is stale until queried. A stale persisted running record is not proof of a live process. Missing individual metrics are unavailable; transient status-query failure is generic live-unavailable. Cached values are never labeled current.
- Refresh preview on its agent start/settled events, recovery/fatal/exit events, and explicit create/resume/stop/delete/reload/preview-selection/menu actions. Events for non-preview sessions never edit this panel.

## Interfaces and constraints

- Query only the current preview; do not broaden into session polling or alter core lifecycle/recovery ownership. Keep preview and selection independent.
- Serialize edits per chat with a trailing newest-wins coalescer and generation guards. Enforce 500 ms minimum spacing and 2 s maximum wait for waiting/coalescing before API dispatch readiness. This maximum wait excludes time blocked behind an already in-flight strict single-flight Telegram edit: that call is neither overlapped nor canceled by the maximum-wait deadline and retains its existing ≤5 s API timeout. Once it completes, dispatch the newest queued render next, subject to the 500 ms spacing rule. Flush terminal lifecycle and explicit user actions.
- Deduplicate when both rendered text and keyboard are identical. Preserve existing Telegram failure semantics; do not retry failed edits.
- Local `Обновлено: HH:mm:ss` advances only when visible semantic lifecycle, activity, model, effort, usage, context, or availability changes—not on duplicate events/polls.
- Retain authorization, HTML escaping, output truncation, and bounded query/API deadlines. Keep state in memory only; never persist live status or claim cached data is current.

## Non-goals

No persistent live metrics/history; no background polling of all sessions; no Pi process liveness inference from records; no Telegram-owned retries, watchdog, recovery, process supervision, or lifecycle policy; no change to selected-session routing or core/Pi contracts beyond consuming existing status/events.

## Acceptance criteria

- With preview != selected, every live value and action/status refresh refers to preview; selected destination remains separately labeled and unchanged.
- Startup status remains stale until the current preview query resolves; confirmed absence alone yields offline. Missing metrics and transient query errors render unavailable without fabricated zeroes or stale values.
- Slow query followed by preview change cannot overwrite the newer preview; generation guards prevent late results/edits. Non-preview events cause no panel edit.
- Event/action bursts produce newest-wins output, respect spacing and maximum wait, and terminal/explicit flushes; unchanged text+keyboard produce no edit.
- Update time changes exactly with visible semantic changes. Authorization, escaping, truncation, deadlines, and existing no-retry Telegram failures remain intact.
- Verify event, query, transition, race, burst, stale, error, selection-mismatch, and dedup cases with automated tests; run project checks and `git diff --check`.

## Delivery constraint

After verified implementation and review, install the exact approved commit using the documented local Git install procedure in `README.md`; do not restart `harnessd.service` for this feature.
