# Hypotheses and evidence gaps

Hypotheses below are explicitly **not confirmed defects**. They must not be read as findings.

## Unconfirmed hypotheses

1. **Frequency of accidental retries after silent panel failure:** F09 shows ambiguity in code; actual repeats/cost were not measured.
2. **Bot API edit/rate-limit overload:** event-driven activity and stats timer may hit limits, but live traces and `retry_after` were not examined. Needs load scenario; no current failure asserted.
3. **Photo support for selected model:** transport passes photo image content; live Pi/model capability and provider errors were not checked. No false vision promise asserted.
4. **Model/effort changes during a run:** Pi semantics for current versus next turn are unknown; current RPC selection does not establish a specific turn effect.
5. **Pinned panel/ForceReply usability by client:** Android/iOS/Desktop, long labels, reply UI, and repinning were not tested.
6. **Short SessionId label collisions:** truncation is confirmed; actual duplicate first-eight-character IDs are not. F17 stands independently on missing cwd/status.
7. **Retrieval of skipped answer:** no transport history exists; safe retrieval from Pi-native history was not checked. “Show last answer” is not a confirmed solution.

## Validation and coverage gaps

- Source audit did not run `npm test`, typecheck, build, lint, or `git diff --check`; referenced tests are inspected assertions, not executed checks.
- No live Telegram/Pi operations, fault injection, latency measurement, or load test.
- Telegram official documentation was checked using a supplied research artifact, not direct HTTP retrieval in the audit session.
- No production incident frequency, error rate, timings, or user interviews support the step/impact estimates. Step counts are logical reproducible routes, not measured statistics.
- Existing tests cover authorization, selection persistence, no resend, output formatting, and bounded delivery well, but do not close the identified seam scenarios:
  - failed list with a still-existing selected session;
  - uncertain headline in activity bubble; exact delete confirmation;
  - ordinary Reply and media Reply to name prompt; name retry after validation failure;
  - folder listing drift; old confirmation after cancel/resume;
  - skipped versus delivered output; stalled download; event-channel recovery.
- Media test helpers do not model `reply_to_message` on uploads (`test/telegram-transport.test.ts:281–332`); existing media tests therefore do not refute F06.
- Restart tests cover selection/panel restoration, not full return from old name prompts/activity bubbles after service restart.
- Future work needs targeted regression tests per slice, then project gates. Any live tests should use test bot and temporary workspace/state, without production credentials or automatic retries of uncertain inputs.

## Cross-scenario consistency

| Seam | Findings | Consistent rule |
|---|---|---|
| Acceptance ≠ start ≠ completion ≠ answer delivery | F01, F10, F11, F15 | Separate input, run, and Telegram delivery states. |
| Selected ≠ preview ≠ running ≠ navigation cwd | F04, F08 | Name each target in screen/action. |
| Ordinary Reply ≠ name prompt reply | F06, F07 | Classify text/media reply before submit. |
| Existing resource ≠ current intent | F05, F18 | Snapshot/generation token and safe stale path. |
| Failed read ≠ absent data | F03, F08 | Failed reads do not clear selection; stopped is not “not found.” |
| Core success ≠ UI edit success | F09 | Report operation and presentation separately. |
| “Try later” ≠ recovery | F11–F13 | Recovery matches cause and can actually be performed. |
| Session identity | F14, F17 | Name + stable full ID; cwd is additional context. |
| RU panel ≠ EN slash/diagnostics | F16 | Consistent language; technical detail may be secondary. |

**Review summary:** 2 P1, 15 P2, 1 P3; no P0. No findings were fixed in the read-only audit. Review verdict: OK with notes for completing audit, not permission to merge/deploy implementation. P1 issues precede release; later slices need approved contracts and validation.
