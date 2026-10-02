# harnessd

harnessd runs a locally supervised Pi RPC session service and exposes it through one Telegram bot using long polling.

## Telegram setup

Set `HARNESSD_TELEGRAM_BOT_TOKEN` and `HARNESSD_TELEGRAM_ALLOWED_USER_IDS` (comma-separated positive numeric Telegram user IDs), then build with `npm run build` and run `node dist/src/cli.js` or install the package's `harnessd` executable. `HARNESSD_PI_EXECUTABLE` defaults to `pi`. `HARNESSD_STATE_DIR` is optional; when absent the core resolves its standard supervisor-owned state directory. `HARNESSD_EXECUTION_MODE` defaults to `direct` (trusted; `cwd` is not a sandbox). The CLI currently has no isolation provider, so `isolated` fails safely rather than falling back. Run `harnessd --help` for the command list.

Only allowlisted users in private chats can interact. Each chat's selected session exists only in memory; use `/use <sessionId>` after a service restart. All allowlisted operators share local session authority. `/new [cwd]` uses the service's starting directory by default. Plain text is submitted to the selected session. Inputs reported as uncertain are never resent automatically.

The service permits one polling process per bot token (sharing the configured state directory), claims an exclusive token-derived lock, and releases it only after polling stops. Fatal polling failure requests runtime shutdown; `SIGINT` and `SIGTERM` stop the runtime. While the supervisor is alive, core watches explicit Pi process exits, drains final events, and makes at most three native-session resume attempts after 250 ms, 1 s, and 4 s; it never falls back to a fresh session or resends uncertain input. After an unclean supervisor exit, persisted session rows may be stale: this CLI does not reattach or restart prior processes. Direct Pi execution is trusted, runs with the supervisor user's OS permissions, and `cwd` is not a sandbox. Allowlisted operators may receive harness output, which can contain workspace data.

For development, run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, and `npm run format:check`.
