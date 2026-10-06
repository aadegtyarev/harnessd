# Confirmed findings: input, lifecycle, delivery

## F06 — P2: Reply handling differs between text and media

**Evidence:** text reply not matching active name prompt is rejected before command/submit (`src/telegram-transport.ts:1283–1288`). `onMedia` does not check `reply_to_message` or pending name flow (`1444–1548`).

**Impact / flows:** Reply to final answer with clarification or `/status` is rejected, requiring resend. A document/photo reply to name prompt, including stale prompt, can instead submit to selected Pi session. Transport surface promises stale replies are not submitted.

**Recommended behavior:** classify known name-prompt replies consistently for text/media: only expected text accepted; stale name replies never go to Pi. Define ordinary assistant-reply routing explicitly; do not silently change session.

**Steps:** ordinary clarification 2 sends→1; unintended media submit remains 1→1 but is prevented.

## F07 — P2: ForceReply loses recovery context and `/skip` is required

**Evidence:** pending flow removed before validation/execution (`src/telegram-transport.ts:2037–2039`); invalid-name/create failure returns error only (`2046–2073`). Up to eight name prompts coexist (`2018–2028`). Unnamed creation requires `/skip` (`2386,2397,2050–2052`).

**Impact / flows:** overlong name fails then corrected reply is stale; double-tap creates independent prompts/sessions; unnamed create requires command knowledge. Failed flow loses target/cwd, canceling one prompt does not cancel others.

**Recommended behavior:** one active name flow per chat; explicitly end older prompts. Retain flow or reissue ForceReply after validation failure. Add “Without a name” and “Cancel” buttons and show target/cwd.

**Steps:** details rename → invalid → reopen rename → corrected reply 4→3. Home create + `/skip` 2→1 with button. Named create 2→2.

## F08 — P2: lifecycle actions lack state-aware next step

**Evidence:** `/stop` clears selection but only says stopped (`src/telegram-transport.ts:1882–1904`); `/resume` does not select (`1840–1861,3498–3509`). Home exposes model/effort/delete (`2238–2246`); delete requires stopped (`src/core/session-manager.ts:107–123`); model/effort on stopped returns `SessionNotFoundError` (`608–634`). Details gates Stop/Resume by state (`src/telegram-transport.ts:3179–3183`).

**Impact / flows:** stop → resume lacks ID; resume A still leaves another selection; stopped A → Model gives “not found”; running A → Delete → confirmation then refusal. Distinct states (existing/running/selected/control-capable) are conflated.

**Recommended behavior:** preserve `/resume` semantics but say resumed-not-selected and offer Select. After stop, say selection cleared and offer select/resume. Stopped controls explain running Pi requirement and contextual resume; gate deletion before confirmation. Combined actions require separate contract approval.

**Steps:** stop → failed resume → `/use A` → resume 4→2 with contextual resume-and-select. Stopped model error → resume → model → choose 4→2. Running delete's two futile actions→0.

## F09 — P2: panel edit failure is invisible

**Evidence:** edit/send helper returns false on transient failure (`src/telegram-transport.ts:2260–2300`); main callers ignore result (`2247,3079–3101,3415,3495,3635`). Test `test/telegram-transport.test.ts:1150–1172` checks no duplicate panel, not user feedback.

**Impact / flow:** core selection/model succeeds but stale UI remains; user cannot distinguish successful action from failed action and may repeat it. `/menu` refresh can be invisible.

**Recommended behavior:** preserve no-duplicate behavior. Report operation outcome separately from presentation failure (“Model changed; panel did not refresh; check status/refresh”). Report `/menu` refresh failure.

**Steps:** operation + manual `/status` 2→1 for known outcome; status check remains needed if control outcome is unknown.

## F10 — P2: after deselection, skipped output can look delivered

**Evidence:** final output targets selected recipients only (`src/telegram-transport.ts:3902–3912`); queued output skips after selection change (`4083–4103`). `finishLiveActivities` checks queue success, not delivery of this session's answer (`2905–2941`). Test `test/telegram-transport.test.ts:821–872` confirms old bubble deletion; `2574–2617` confirms output suppression.

**Impact / flow:** start A → select B → A completes → A output skipped, bubble removed as if normal finish. Transport has no history, so result location is unclear.

**Recommended behavior:** keep selected-only delivery; distinguish completed from shown and retain session-labelled outcome: “Turn completed; answer not shown because another session is selected.” Select-A button must not promise retrieval of skipped text. History requires separate scope.

**Steps:** A input + switch B 2→2; replace uncertain search with explanation.

## F11 — P2: new work is accepted after event reply channel fails

**Evidence:** send failure marks queue failed (`src/telegram-transport.ts:4096–4102`); later enqueue exits (`3961–3962`) with no `/menu` or selection reset. Submit continues (`1290–1309`). Bubble can report failed delivery (`2928–2936`) but not that future replies are disabled until restart. Test `test/telegram-transport.test.ts:2806–2821` verifies later notifications drop.

**Impact / flow:** transient timeout → network recovers → new work accepted by Pi → answer discarded due to old failed queue. Existing contract deliberately disables queue until restart; issue is transparency/recovery UX, not changing that policy.

**Recommended behavior:** explicitly say event channel is disabled until service restart and give operator action. Warn before next submit until approved recovery exists. Any future re-enable permits only new events; never resend uncertain output.

**Steps:** Telegram-only recovery currently unavailable; after approved recovery, 1 action. Prevent unwarned future submits: each 1→0.

## F12 — P2: media download has no total deadline/progress and holds session lock

**Evidence:** download runs inside session inbox lock (`src/telegram-transport.ts:1477–1582`); `getFile`/`fetch` lacks applied deadline/abort (`1490–1498`). Activity begins only after save (`1514–1520`). Text submit/resume takes same lock (`2137–2144`).

**Impact / flow:** send document → network/body stalls silently → next text or resume for session waits behind lock. Size limit is not time limit.

**Recommended behavior:** bounded deadline and abort, early “receiving attachment” state, explicit timeout stating no submit occurred. Avoid holding session-critical lock during network phase if inbox/lifecycle safety remains enforced at commit.

**Steps:** upload 1→1; indefinite wait becomes bounded timeout and optional one manual retry.
