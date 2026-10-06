# Ordered backlog and product questions

These are proposed future slices, not approved implementation scope. Preserve current guarantees: no automatic resend, shared operator authority, explicit resume does not select, selected-only events, cwd is not sandbox, and no persistent event history. Changes to those guarantees require a separate feature contract.

## Ordered feature slices

1. **Truthful outcomes and consequences (before release):** F01 uncertainty vs rejection in text/media; F02 full delete scope; F15 cancellation presentation. Test bubble/diagnostic agreement and delete wording. Keep no-resend and core delivery-state set. Outcome: no false non-delivery or incomplete deletion promise.
2. **Stable choice and panel context:** F03 failed list preserves selection; F04 separates selected/preview/navigation cwd; F14 identity in status/activity; F17 useful session choice. Test two chats, same cwd/name/model, storage failure. Outcome: choose correct target without control slash checks.
3. **Current buttons and confirmations:** F05 snapshot-bound folder callbacks; F18 one-time tokens, cancel/expiry/generation. Test directory insertion between render/tap and old confirmation after cancel/resume. Do not expand delete rights or filesystem boundary. Outcome: displayed target/intent cannot be reinterpreted.
4. **Guided input without traps:** F06 uniform text/media Reply policy; F07 one active name flow, retry after validation failure, bounded unnamed/cancel buttons instead of mandatory `/skip`. Test stale media Reply, assistant Reply, invalid/duplicate create, restart during prompt. Outcome: free text stays free; bounded choices are buttons.
5. **State-aware lifecycle and controls:** F08 explain stopped/failed/stale-running and available next steps; show selection after stop/resume; contextual resume for model/effort; check delete eligibility before confirmation. Combined “resume and select” only after semantic approval; no reattachment/fresh fallback. Outcome: fewer known-failing actions and manual ID copies.
6. **Delivery, progress, recovery:** F09 report operation separate from panel edit; F10 distinguish completed/not shown; F11 visible disabled event channel and operator recovery, then explicit approved re-enable for new events; F12 bounded download, early progress, reduce lock occupancy. Test successful core + failed edit, switch before settlement, transient send failure + later submit, stalled download. Outcome: silence no longer implies non-acceptance; avoid unnoticed work without reply.
7. **File recovery, navigation, onboarding:** F13 typed safe file errors and truthful quota cleanup; F17 directory-only listing or actionable path on truncation; F16 `/start`, concise `/help`, consistent language. Inbox management, if needed, is a separately scoped capability/safety contract. Outcome: discover and recover without README.

## Product questions

1. During preview, is selected A or preview B the active context? Can preview actions live on a separate card?
2. Should `New session` use navigation cwd or selected-session cwd? Which default must be visible?
3. Is “Resume and select” needed while independent `/resume` semantics remain?
4. Should ordinary Reply route to selected session or original assistant-message session? Silent reroute is unsafe.
5. Should background-session results appear after deselection? If not, what outcome remains and how retrieve without event history?
6. With event channel disabled, block new submits, warn, or allow with explicit confirmation?
7. Is Telegram inbox cleanup needed, or operator-only? How explain quota for running sessions?
8. Confirm single active name flow? Should abandoned prompts expire?
9. What is the primary UI language; should English remain only for model keys/expandable diagnostics?
10. How expose shared authority (one operator can stop/resume another's selected session); is more visibility needed?
