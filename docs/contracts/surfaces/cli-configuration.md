# Surface contract: CLI configuration

## Boundary and ownership

`src/cli.ts` owns startup configuration loading, validation, command dispatch, and composition of the runtime. `src/command-catalog.ts` owns user-facing command visibility; CLI help renders its CLI-visible entries. Telegram authorization/presentation is defined by [Telegram transport](telegram-transport.md); service lifecycle operations are defined by [user service](user-service.md).

## Configuration loading and precedence

- Runtime startup reads an optional `.env` from the process current working directory before validating required Telegram settings. `harnessd --help` does not read or require configuration; its private-chat command summary is generated from the CLI-visible command catalog, including `/resume`, `/ls`, and `/cd`. Service uninstall does not read `.env`; service install has the stricter requirements in the user-service contract.
- The file uses Node's dotenv parser, not shell execution. Variables already present in the launching process are not overwritten by `.env`. A missing file is allowed; other read failures produce a safe error without dumping file contents or values.
- Required configuration is `HARNESSD_TELEGRAM_BOT_TOKEN` and a nonempty comma-separated `HARNESSD_TELEGRAM_ALLOWED_USER_IDS` containing positive safe integers. Optional settings are `HARNESSD_PI_EXECUTABLE` (default `pi`), `HARNESSD_STATE_DIR` (core resolution rules), `HARNESSD_EXECUTION_MODE` (default `direct`), and `HARNESSD_HOME` (initial Telegram working directory; default system root `/`).
- The CLI never logs credential values or the complete environment. Values loaded into the supervisor environment are not implicitly passed to Pi; the child-process environment contract remains [explicit and empty by default](process-provider.md).

## Initial Telegram working directory

`HARNESSD_HOME`, when set, must resolve to an existing accessible directory and selects the initial per-chat navigation directory and the default cwd for `/new` without a path. Relative values resolve against the process current working directory. If unset, the initial directory is `/`. It is a starting location, not a filesystem boundary: Telegram `/ls`, `/cd`, and `/new` may use any path accessible to the supervisor's OS user.

Per-chat navigation is volatile. `/cd` changes the directory used by later relative paths and by `/new` without an explicit path; running sessions are unaffected. Explicit relative `/new <path>` values resolve from the chat's current directory, and absolute paths are accepted. `~` and `~/...` always expand to the OS user's home directory, independently of `HARNESSD_HOME`. Paths undergo the core's ordinary cwd validation before session creation; no filesystem sandbox is provided.

## Compatibility and related contracts

Configuration loading does not change trusted `direct` execution, fail-closed `isolated` selection, state-directory privacy, or no-automatic-resend behavior. See [Telegram transport](telegram-transport.md), [core session management](core-session-management.md), [process provider](process-provider.md), and [user service](user-service.md).
