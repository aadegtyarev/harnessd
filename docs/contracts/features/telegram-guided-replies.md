# Feature contract: Telegram guided replies

**Status:** complete for final verification

## Goal

Make ordinary Telegram replies useful while ensuring text and media directed at naming prompts never accidentally submit to Pi.

## Scenarios

- Text and media reply to a reliably correlated bot output: send to selected session if it is the source; if different, ask to send to source, selected, or cancel. Unknown source routes to selected.
- Naming prompts are one-at-a-time per chat; replacement explicitly supersedes the prior prompt. Stale replies, including media and replies after restart, never submit to Pi.
- Invalid names preserve/reissue the flow. Create offers unnamed creation and cancel; rename offers cancel, with name clearing remaining separate. Every prompt identifies the exact target and cwd.
- Chats remain isolated. Naming prompt replies and slash commands are not mistaken for ordinary message routing.

## Non-goals

Changing session selection; persistent mapping of Telegram messages; reply history; automatic resend; behavior outside Telegram transport.

## Affected surface

- [Telegram transport](../surfaces/telegram-transport.md)

## Constraints

- Correlation is volatile, bounded, and only records relevant bot outputs/activity. Callback payloads use short opaque tokens and are bound to chat and intent; cleanup and restart invalidate stale state.
- Preserve current selection unless the operator explicitly changes it through existing controls. Never silently reroute a reply to a different session.

## Acceptance criteria

- Text/media reply routing passes for same-session, different-session choices, and unknown source.
- Superseded and post-restart name-prompt text/media replies never submit to Pi; active invalid-name retry, unnamed/cancel, rename-cancel, and multi-chat flows work.
- Reply choices cannot mutate selection or invoke a stale/foreign callback.

## Validation

Targeted Telegram transport tests plus `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, and `git diff --check`.
