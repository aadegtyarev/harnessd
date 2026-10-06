# Confirmed findings: files, recovery, discovery

## F13 — P2: file errors offer mismatched or unavailable recovery

**Evidence:** structural inbox-inside-workspace rejection (`src/telegram-inbox.ts:213–235`) becomes “Please try again later” (`src/telegram-transport.ts:1573–1578`); test `test/telegram-transport.test.ts:2136–2154`. Quota says delete files or wait (`1567–1572`), but cleanup skips running sessions (`src/telegram-inbox.ts:183–197`) and Telegram has no inbox cleanup command. `/send` collapses absent file/path restriction/delivery failure into one regular-file/cwd/size hint (`src/telegram-transport.ts:1390–1431,1630–1638`).

**Impact / flow:** configuration rejection → retry later → same failure; quota in running session → wait but cleanup cannot occur; successful `/send` followed by Telegram timeout → user is told to fix file.

**Recommended behavior:** safe reason codes and distinct messages: unavailable file, outside workspace, size, inbox configuration, quota, uncertain delivery. For quota explain actual cleanup condition and available route (another session/operator); inbox-management capability needs separate scope.

**Steps:** useless retry 2→1 to identify cause. Telegram quota cleanup currently unavailable; do not promise one-button resolution.

## F15 — P2: successful cancellation appears as send error

**Evidence:** Pi RPC emits `failed` with detail `Input canceled` (`src/harness/pi-rpc-harness.ts:1204–1206`). Activity updater receives only ID/state (`src/telegram-transport.ts:3764–3777`); maps failed to `Ошибка отправки` (`2828–2835`). Separate detail and slash response say cancellation requested (`1924`).

**Impact / flow:** accepted request → `/cancel inputId` → abort succeeds → bubble says send error while separate reply says cancel.

**Recommended behavior:** retain core `failed` state, but map cancellation detail/reason to “Canceled at your request.” Keep multiple-outstanding refusal explicit; no unsupported per-input cancel button.

**Steps:** cancel 1→1; follow-up “what happened?” +1→0 with clear result.

## F16 — P3: onboarding/help omit main workflow and language is inconsistent

**Evidence:** catalog has `/help` but no `/start` (`src/command-catalog.ts:36–185`); `/help` prints usages only (`src/telegram-transport.ts:1694–1696`); unknown command returns generic invalid (`1929`). RU panel alongside EN commands/status/mixed activity (catalog `51–181`; transport `737–753,2621–2658`).

**Impact / flow:** Telegram Start sends `/start` → invalid → `/help` list lacks selection, `👀`, queued, stop/resume, folders. Discovery begins with an error; terms require README.

**Recommended behavior:** `/start` and `/help` explain choose/create → send text/file → observe; offer Open panel, Sessions, New session; retain compact advanced slash reference. Choose consistent language while preserving technical IDs/model keys.

**Steps:** `/start` → `/help` → `/menu` 3→2 with welcome + panel button; if `/start` opens panel, 1.

## F18 — P2: destructive confirmation is not bound to active confirmation flow

**Evidence:** `action:confirm-stop/delete:<id>` executes by known SessionId (`src/telegram-transport.ts:2456–2469`); ID validation checks format/known set only (`2501–2505`). Cancel only renders list (`2471–2472`); there is no active one-shot token, expected lifecycle, or invalidation.

**Impact / flow:** open stop confirmation A → cancel → delayed old callback still stops known A; old confirm can stop a new run after stop/resume. Core still protects deletion of live session.

**Recommended behavior:** token bound to chat/message/session/action/generation; invalidate on cancel/completion; recheck expected state, request fresh confirmation if context changed.

**Steps:** ordinary action + confirmation 2→2. Stale tap after cancel 1→1 with refusal, not side effect; fresh intent requires fresh confirmation (appropriate safety).
