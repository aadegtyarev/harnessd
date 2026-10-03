# Surface contract: CLI configuration

## Boundary and ownership

`src/cli.ts` owns startup configuration loading, validation, command dispatch, and composition of the runtime. Telegram authorization/presentation is defined by [Telegram transport](telegram-transport.md); service lifecycle operations are defined by [user service](user-service.md).

## Configuration loading and precedence

- Runtime startup reads an optional `.env` from the process current working directory before validating required Telegram settings. `harnessd --help` does not read or require configuration and its private-chat command summary includes `/resume [sessionId]`. Service uninstall does not read `.env`; service install has the stricter requirements in the user-service contract.
- The file uses Node's dotenv parser, not shell execution. Variables already present in the launching process are not overwritten by `.env`. A missing file is allowed; other read failures produce a safe error without dumping file contents or values.
- Required configuration is `HARNESSD_TELEGRAM_BOT_TOKEN` and a nonempty comma-separated `HARNESSD_TELEGRAM_ALLOWED_USER_IDS` containing positive safe integers. Optional settings are `HARNESSD_PI_EXECUTABLE` (default `pi`), `HARNESSD_STATE_DIR` (core resolution rules), `HARNESSD_EXECUTION_MODE` (default `direct`), and `HARNESSD_DEFAULT_CWD`.
- The CLI never logs credential values or the complete environment. Values loaded into the supervisor environment are not implicitly passed to Pi; the child-process environment contract remains [explicit and empty by default](process-provider.md).

## Default workspace

`HARNESSD_DEFAULT_CWD` is used for Telegram `/new` only when the command has no explicit path. An explicit `/new <cwd>` takes precedence. If the variable is absent, the process current working directory remains the default. The chosen path is passed through core's normal canonicalization and existing-directory/read/execute validation; invalid paths fail session creation rather than weakening core validation. Relative paths resolve against the process current working directory; absolute paths are recommended, especially for a service.

## Compatibility and related contracts

Configuration loading does not change trusted `direct` execution, fail-closed `isolated` selection, state-directory privacy, or no-automatic-resend behavior. See [Telegram transport](telegram-transport.md), [core session management](core-session-management.md), [process provider](process-provider.md), and [user service](user-service.md).
