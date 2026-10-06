# Confirmed findings: truth, context, navigation

## F01 — P1: uncertain delivery is presented as Pi rejection

**Evidence:** `src/telegram-transport.ts:1312–1327` sets “Pi did not accept the message” for any failed submit; media equivalent `1530–1544`. Pi RPC throws `UncertainInputDeliveryError` on lost response (`src/harness/pi-rpc-harness.ts:1125–1137`); runtime preserves `InputId` (`src/application-runtime.ts:443–456`). Separate diagnostic correctly says uncertain/not resent (`src/telegram-transport.ts:827–835`). Test `test/telegram-transport.test.ts:1867–1901` checks diagnostic uncertainty, not bubble wording.

**Impact / flow:** Pi may accept and execute after lost acknowledgment, while the bubble says it did not. Conflicting feedback invites a manual duplicate.

**Recommended behavior:** distinguish definite rejection, uncertain delivery, and unavailable session. Say acknowledgment was not received, Pi may have accepted it, no automatic retry occurred; include original `InputId` and caution before new input.

**Steps:** submit/result 1→1; potential manual duplicate +1→0 (frequency unmeasured).

## F02 — P1: delete confirmation omits incoming files

**Evidence:** confirmation promises “only harnessd metadata” (`src/telegram-transport.ts:3563–3567`), but deletion calls `inbox.removeSessionUnderLock` (`1104–1128`) and recursively removes inbox files (`src/telegram-inbox.ts:150–167`). Test `test/telegram-transport.test.ts:2173–2196` verifies uploaded file removal and workspace preservation.

**Impact / flow:** stopped session has received documents → user confirms “metadata only” → inbox attachments are irreversibly removed. Pi files and workspace do remain.

**Recommended behavior:** disclose deletion of record and received inbox attachments, while stating Pi-native files/workspace remain. Label button “Delete record and attachments.”

**Steps:** delete + confirmation 2→2; no reduction needed.

## F03 — P2: list failure clears saved selection

**Evidence:** `src/telegram-transport.ts:2163–2177` converts failed list to empty sessions and clears selected session; `clearSelected` removes volatile and persisted choice (`1234–1250`).

**Impact / flow:** A selected → transient storage list failure on `/menu` → A treated as deleted → after recovery text no longer routes to A. A failed read changes state without proving absence.

**Recommended behavior:** clear only after successful authoritative list or confirmed `SESSION_NOT_FOUND`; on list failure report refresh error and preserve selection.

**Steps:** after failure, `/menu` → Sessions → A recovery 3→0; optional refresh 1→1.

## F04 — P2: panel mixes selected, preview, and creation-directory context

**Evidence:** preview B supplies cwd/status/usage (`src/telegram-transport.ts:2184–2220`); stop/delete target selected A (`2242–2246`), as do model/effort (`3322,3422`). New-session creation uses chat navigation directory (`2380–2386`), not displayed session cwd; generic name prompt omits that directory (`2386,2397`).

**Impact / flow:** selected A, preview B; visible B information beside controls acting on A. Alternatively displayed cwd X while creation happens in hidden navigation directory Y. User cannot infer target from context.

**Recommended behavior:** distinguish “Selected A—messages go here” from “Preview B”; label control targets; show “New session folder: Y,” including in prompt.

**Steps:** correct action 1→1; inspect hidden folder via folders + back 2→0. Repair of incorrectly created session unestimated.

## F05 — P2: folder callback uses fresh index, not displayed target

**Evidence:** buttons encode `folder:open:<index>` (`src/telegram-transport.ts:3220–3243`); callback takes that index in a fresh listing (`3292–3313`); entries can be resorted (`src/telegram-filesystem.ts:101–105`).

**Impact / flow:** display `[b/, c/]`; create `a/`; tap displayed `b/` index 0 → opens `a/`. Old callback can also apply to a changed chat directory.

**Recommended behavior:** opaque token bound to parent/path snapshot and screen generation; on mismatch refresh rather than reinterpret index. Do not expose full filesystem path in callback.

**Steps:** wrong transition + parent + correct folder 3→1 with current token; stale token refresh + selection 2.

## F14 — P2: activity and `/status` omit session identity

**Evidence:** activity header/input/model/usage omit name and SessionId (`src/telegram-transport.ts:2621–2658`); `/status` also omits identity (`737–753`). An old session bubble may continue after switching; test `test/telegram-transport.test.ts:821–872`.

**Impact / flow:** run A and B with same cwd/model; two similar bubbles and status cannot be associated reliably. InputId is not SessionId; folder path is not identity.

**Recommended behavior:** show `Name · full SessionId` consistently; indicate “currently selected” versus “running in background” after switch. Do not substitute cwd for stable ID.

**Steps:** `/status` + `/inspect` to identify 2→1; two-bubble workflow same action count, less ambiguity.

## F17 — P2: resource catalogs lack enough choice context

**Evidence:** session buttons show name and first 8 ID characters (`src/telegram-transport.ts:603–607,3132–3140`), summaries omit cwd/status/current marker (`3148–3153`). Duplicate names are allowed; unnamed sessions show mostly ID. Folder UI truncates the first 100 entries before filtering directories (`src/telegram-filesystem.ts:101–119`; `src/telegram-transport.ts:3217–3222`); pages cannot reach folders beyond cutoff.

**Impact / flow:** duplicate/unnamed sessions require opening each detail. A folder after entry 100 is absent from panel navigation, despite honest truncation notice.

**Recommended behavior:** show current marker, short cwd and lifecycle in session list. Use directory-only bounded listing or actionable path access/instruction (`/cd <path>`); disclose limits.

**Steps:** details → back → select 3→1 with sufficient summary; hidden folder becomes one path input after actionable hint. No page-count fix can reveal a pre-truncation omission.
