# harnessd

harnessd is a **local supervisor for Pi coding-agent sessions**. You control it from a Telegram bot in private chats; it creates one Pi RPC process per session and keeps session metadata in a separate local state directory.

It is currently being tested from Git, not published to npm. The manifest and lockfile remain at `0.1.0`; the first stable `1.0.0` release is deferred until owner testing is approved.

## What it does

- Accepts commands and prompts from allowlisted Telegram users in private chats only.
- Creates, lists, selects, inspects, cancels, and stops independent Pi sessions.
- Routes output and status events back to the selected chat.
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

For example, configure the two required Telegram values in your local environment, then run:

```sh
harnessd
```

The Pi child does **not** inherit the supervisor's full environment. Exporting a model/API key in the shell that starts harnessd therefore does not guarantee Pi receives it. Use Pi's supported configuration mechanism; this CLI does not currently expose a Pi child-environment option.

## Telegram commands

Only allowlisted users in private chats can interact. All allowlisted operators share local session authority.

| Command | Purpose |
| --- | --- |
| `/help` | Show available commands. |
| `/sessions` | List sessions. |
| `/new [cwd]` | Create a session in `cwd`; defaults to the service's starting directory. |
| `/use <sessionId>` | Select a session for this private chat. |
| `/inspect [sessionId]` | Inspect the selected or named session. |
| `/stop [sessionId]` | Stop the selected or named session. |
| `/cancel <inputId>` | Cancel an accepted input in the selected session. |

Plain text is sent to the selected session. Chat selection is in memory only. A restarted service does not reattach prior Pi processes; old session rows may appear stale, and `/use` cannot restore those sessions. The supervisor accepts any existing accessible directory as `cwd`, but `cwd` is not a security boundary.

## Sessions, recovery, and uncertainty

While harnessd is alive, the core watches explicit Pi process exit, drains final events, and may attempt native-session resume up to three times per session after 250 ms, 1 s, and 4 s. It uses the exact saved native session ID and never starts a fresh session as a fallback.

If prompt delivery is uncertain, harnessd reports the original `InputId` and **does not resend the prompt**. A later manual submission is new work and could duplicate an operation if Pi completed the original prompt. After an unclean supervisor exit, stored session rows may be stale; this CLI does not reattach or restart prior Pi processes.

## Trust and limitations

- `direct` runs Pi with the supervisor user's operating-system permissions. There is no sandbox: Pi may access files outside `cwd` that the user can access.
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

The package remains private. See the [package-release contract](docs/contracts/surfaces/package-release.md) before preparing a version bump or distribution change.
