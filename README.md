# harnessd

harnessd is a **local supervisor for Pi coding-agent sessions**. You control it from a Telegram bot in private chats; it creates one Pi RPC process per session and keeps session metadata in a separate local state directory.

It is currently being tested from Git, not published to npm. The manifest and lockfile remain at `0.1.0`; the first stable `1.0.0` release is deferred until owner testing is approved.

## What it does

- Accepts commands and prompts from allowlisted Telegram users in private chats only.
- Creates, lists, selects, inspects, resumes, cancels, and stops independent Pi sessions.
- Provides a pinned session panel, optional session names, current-session usage, typing indicators, and whole-turn output with formatted Markdown and searchable session IDs.
- Watches Pi process exits and attempts bounded resume of the same native session while harnessd remains running.
- Keeps supervisor metadata in SQLite under a private state directory, independently of each session workspace.

See [Architecture and lifecycle](docs/architecture.md) for a diagram and the detailed request/recovery flow.

## Requirements

- Node.js 24 or later.
- Git, for installation from a repository URL.
- A Pi CLI version that supports `--mode rpc`; `HARNESSD_PI_EXECUTABLE` can point to its absolute path.
- A Telegram bot token and the numeric user IDs allowed to control it.
- `better-sqlite3` uses a native Node addon. npm uses a compatible prebuilt binary where available; otherwise the host needs the native build prerequisites, such as Python 3, `make`, and a C/C++ compiler required by `node-gyp`.

## Install for local testing

The package is private and is not published to npm. The supported non-global local-prefix Git installation runs `prepare` to compile TypeScript into the `dist/` files used by the `harnessd` executable; installing a Git URL globally is not claimed for this testing phase.

Install an exact commit or tag into an isolated local npm prefix from a checkout or an authorized Git remote:

```sh
npm install --prefix "$HOME/.local/share/harnessd" \
  "git+ssh://git@github.com/aadegtyarev/harnessd.git#<commit-sha-or-tag>"
"$HOME/.local/share/harnessd/node_modules/.bin/harnessd" --help
```

For a local clone, use a Git URL (not a plain directory install) so npm exercises the Git `prepare` lifecycle:

```sh
npm install --prefix "$HOME/.local/share/harnessd" \
  "git+file:///absolute/path/to/harnessd#<commit-sha>"
"$HOME/.local/share/harnessd/node_modules/.bin/harnessd" --help
```

The binary is installed under that prefix's `node_modules/.bin`; add that directory to `PATH` if you want to invoke `harnessd` by name.

Private Git remotes require your normal repository access. Do not put access tokens in the URL, shell history, or committed files. The Git install can fetch dependencies; a local Git URL does not make dependency installation network-free.

To work inside a checkout:

```sh
npm ci
npm run version:check
node dist/src/cli.js --help
```

`npm ci` runs `prepare` and builds the CLI. `--help` does not require Telegram credentials or start the runtime.

## Configure and run

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `HARNESSD_TELEGRAM_BOT_TOKEN` | Yes | — | Bot token; keep it out of source control and logs. |
| `HARNESSD_TELEGRAM_ALLOWED_USER_IDS` | Yes | — | Comma-separated positive numeric Telegram user IDs. |
| `HARNESSD_PI_EXECUTABLE` | No | `pi` | Pi CLI executable. An absolute path avoids `PATH` surprises. |
| `HARNESSD_STATE_DIR` | No | `$XDG_STATE_HOME/harnessd`, otherwise `~/.local/state/harnessd` | Absolute supervisor state directory. On POSIX it must be owned by the current user and inaccessible to group/others. |
| `HARNESSD_EXECUTION_MODE` | No | `direct` | `direct` is trusted execution. `isolated` currently fails safely because the CLI has no isolation provider. |
| `HARNESSD_HOME` | No | `/` | Initial folder for Telegram navigation and `/new` without a path. This is not a sandbox or access boundary. `~` always means the OS user's home. |

The CLI loads an optional `.env` file from its current working directory before checking required settings. Values already exported in the shell take precedence. Use Node dotenv syntax; the file is not executed as shell code. Keep credentials out of source control and restrict the file on POSIX:

```sh
chmod 600 .env
```

Example `.env` entries (replace placeholders locally; `.env` is gitignored):

```dotenv
HARNESSD_TELEGRAM_BOT_TOKEN=replace-with-your-bot-token
HARNESSD_TELEGRAM_ALLOWED_USER_IDS=123456789
HARNESSD_HOME=/absolute/path/to/your/workspace
# Prefer an absolute path for services if Pi is not on systemd's PATH.
# HARNESSD_PI_EXECUTABLE=/absolute/path/to/pi
```

Run harnessd from the directory containing that `.env`:

```sh
cd /path/to/harnessd
"$HOME/.local/share/harnessd/node_modules/.bin/harnessd"
```

`HARNESSD_HOME` sets the initial per-chat folder; if unset, navigation starts at `/`. A relative value resolves from the service process's working directory and must name an existing accessible directory. `/cd` can move to any directory accessible to the service user. `/new` without a path uses that chat's current folder, while an explicit relative path is resolved from it. Absolute paths are also accepted. `~` always expands to the operating-system user's home directory, not `HARNESSD_HOME`. Directory navigation is not a sandbox.

The Pi child does **not** inherit the supervisor's full environment, including values loaded from `.env`. Use Pi's supported configuration mechanism; this CLI does not expose a Pi child-environment option.

## Run as a per-user service (Linux)

To install a `systemd --user` service, first put the required Telegram settings in `.env`, then run the install command from the directory containing that file:

```sh
cd /path/to/harnessd
"$HOME/.local/share/harnessd/node_modules/.bin/harnessd" service install
systemctl --user status harnessd.service
journalctl --user -u harnessd.service -f
```

Installation creates a user unit, enables it for the user's `default.target`, and starts it immediately. It does not use `sudo`, create a system-wide service, copy secrets into the unit, or enable lingering. Without systemd lingering, running after logout is not guaranteed. The service does not automatically restart on failure; use `systemctl --user restart harnessd.service` when needed. To remove it:

```sh
"$HOME/.local/share/harnessd/node_modules/.bin/harnessd" service uninstall
```

Package installation itself never creates a service. The service unit uses the installation command's current directory and loads `.env` there. Its unit location follows `XDG_CONFIG_HOME` from the invoking shell, or `~/.config` when unset; use the same shell setting when uninstalling. Values from `.env` do not change the user-manager path. See the [user-service contract](docs/contracts/surfaces/user-service.md) for ownership and failure behavior.

## Telegram commands

Only allowlisted users in private chats can interact. All allowlisted operators share local session authority.

| Command | Purpose |
| --- | --- |
| `/help` | Show available commands. |
| `/menu` | Open the pinned session panel to browse/select sessions, inspect usage, and manage session settings. |
| `/rename [sessionId] <name|--clear>` | Name the selected or explicit session, or clear its name. |
| `/sessions` | List sessions. |
| `/new [cwd]` | Create an unnamed session in `cwd`; defaults to the current folder. The `/menu` create flow can also set a name. |
| `/ls [path]` | List immediate files and folders in the current chat folder or the supplied path. Dotfiles are hidden; output is bounded. |
| `/cd [path]` | Change this chat's folder; relative paths work, and `/cd` without a path goes to the OS user's home. Does not change running sessions. |
| `/send <path>` | Send a regular file from the selected session's working directory (up to 20 MiB). |
| `/use <sessionId>` | Select a session for this private chat. |
| `/resume [sessionId]` | Resume a stopped session by its saved Pi-native ID; defaults to the selected session. |
| `/inspect [sessionId]` | Inspect the selected or named session. |
| `/status` | Show the selected session's folder, model, effort, aggregate tokens, and Pi-estimated cost. |
| `/model` | List models available to the selected running session. |
| `/model <provider/modelId> [effort]` | Select an exact model and optionally set its effort. |
| `/effort` | Show current and available effort levels. |
| `/effort <level>` | Set effort for the selected running session. |
| `/stop [sessionId]` | Stop the selected or named session. |
| `/delete <sessionId>` | Delete a stopped session record from harnessd. |
| `/cancel <inputId>` | Cancel an accepted input in the selected session. |

`/menu` previews sessions with previous/next; only **Choose** changes selection. Selection and folder navigation remain in memory. After service restart, select again; harnessd does not reattach prior Pi processes, so old rows may be stale and `/use` cannot restore them. Completed assistant turns render common Markdown formatting and include a searchable `Name · <full SessionId>` footer with the ID in monospace (no `#`); longer turns use numbered parts.

Session names are optional, limited to 64 Unicode code points, and persisted in harnessd metadata—not Pi-native session data. `/sessions` and `/inspect` show the optional name and a plain searchable `#<full SessionId>` tag. All allowlisted operators share access to these names and sessions.

Plain text goes to the selected session. Telegram shows a typing indicator while Pi is working. Send a document or photo to the chat to save it under the selected session's working directory and submit its path and caption; photos are also passed as image content. Use `/send <path>` to upload a regular file from the selected session's working directory to that chat (maximum 20 MiB); relative paths are resolved from the session directory, and paths outside it are rejected. The selected model must support images to interpret photos, and document inspection depends on Pi's available tools. You can ask the model to send a file; it can use the `send_file` tool to upload a regular file from that session's working directory (maximum 20 MiB) back to the chat that sent the prompt. If it is deliberately stopped, harnessd resumes that same Pi-native session and submits the new text once; it never creates a fresh session as fallback. `/stop` clears selection when it stops the selected session, so use `/use <sessionId>` before `/resume` without an ID or text-driven auto-resume.

`/delete <sessionId>` requires a stopped session and removes only its harnessd SQLite record, not Pi-native files or the working directory. `/status` uses Pi RPC aggregate usage only; it does not read session files or invoke plugin commands. Cost is an estimate, not provider billing, and live model, effort, tokens, and cost are unavailable without a live Pi instance. The command menu is registered through Telegram's `setMyCommands`; on registration failure, manual commands remain available. Any accessible directory is valid as `cwd`, but it is not a security boundary.

## Sessions, recovery, and uncertainty

While harnessd is alive, the core watches explicit Pi process exit, drains final events, and may attempt native-session resume up to three times per session after 250 ms, 1 s, and 4 s. It uses the exact saved native session ID and never starts a fresh session as a fallback.

An operator can resume a deliberately stopped session with `/resume [sessionId]`; it reuses the stored native Pi session ID. If prompt delivery is uncertain, harnessd reports the original `InputId` and **does not resend the prompt**. A later manual submission is new work and could duplicate an operation if Pi completed the original prompt. After an unclean supervisor exit, stored session rows may be stale; this CLI does not reattach or restart prior Pi processes.

## Trust and limitations

- `direct` runs Pi with the supervisor user's operating-system permissions. There is no sandbox: Pi may access files outside `cwd` that the user can access. The `send_file` capability is narrower: harnessd only uploads regular files inside the active session's canonical `cwd` to the requesting authorized chat; the Telegram bot token is not passed to Pi.
- `isolated` is not implemented in this CLI and is rejected before runtime startup; it never silently falls back to direct mode.
- Telegram operators share access to local sessions. Output may include sensitive workspace data and is not universally redacted; a full output queue can cause additional notifications to be omitted.
- Session metadata is stored, but chat selection and event/input history are not persisted.
- The polling lock coordinates harnessd processes that share the same state directory; it cannot prevent an unrelated application from polling the same bot token.
- There is no secret wallet or recovery after supervisor restart.

## Versioning and release

Versions follow [Semantic Versioning](docs/contracts/surfaces/package-release.md). `package.json` is authoritative and the package lock must match. Changes are recorded in [CHANGELOG.md](CHANGELOG.md); the first stable `1.0.0` release and any npm publication require owner testing and explicit release approval. No npm publication or automated release occurs during local testing.

## Development checks

```sh
npm test
npm run typecheck
npm run build
npm run lint
npm run format:check
npm run version:check
npm pack --dry-run
```

The package remains private. See the [package-release contract](docs/contracts/surfaces/package-release.md) before preparing a version bump or distribution change. CLI configuration is specified in [cli-configuration.md](docs/contracts/surfaces/cli-configuration.md).
