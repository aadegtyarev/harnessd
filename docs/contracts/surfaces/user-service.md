# Surface contract: per-user systemd service

## Boundary and ownership

The CLI service commands in `src/user-service.ts` install or remove one harnessd unit for the invoking Linux user. harnessd does not install system-wide services or take ownership of the user's systemd manager. Startup configuration loading is defined by [CLI configuration](cli-configuration.md).

## Commands and observable behavior

- `harnessd service install` installs the unit under `$XDG_CONFIG_HOME/systemd/user` or `~/.config/systemd/user`, runs `systemctl --user daemon-reload`, then `systemctl --user enable --now harnessd.service`. `XDG_CONFIG_HOME` is taken from the invoking process environment, not `.env`; use the same value for install and uninstall.
- `harnessd service uninstall` runs `systemctl --user disable --now harnessd.service`, removes the harnessd-managed unit, and reloads the user manager. It is a no-op when no managed unit exists.
- Install uses the current working directory as the unit's `WorkingDirectory` and the absolute Node executable and CLI entry point of the invoked installation. Run it from the directory containing the intended `.env`. Install requires that `.env` itself contain a nonempty bot token and valid allowed-user IDs; shell-only credentials are not embedded or copied into the unit. The install check parses `.env` into an isolated object and does not mutate process `HOME`/XDG settings.
- The generated unit runs as the invoking user, writes service output to the user journal, and stops with `KillSignal=SIGTERM` and `KillMode=mixed`: `SIGTERM` reaches only the harnessd main process, which marks its session manager closing and stops its Pi children itself; systemd kills any remaining processes after the main process exits or at the 30 s stop timeout. harnessd bounds its own shutdown well below that: Telegram stop uses bounded deadlines, the wait for in-flight requests is capped at 5 s, and each Pi shutdown is bounded by its stop timeouts. Units generated before 0.3.0 lack `KillMode=mixed` (so systemd signalled Pi children directly and their exits looked like crashes); re-running `harnessd service install` from the working directory replaces a harnessd-managed unit with the current one. No automatic restart policy is configured. The unit is enabled for the user's `default.target`; without systemd lingering, operation after logout is not guaranteed.
- Status and logs are inspected with `systemctl --user status harnessd.service` and `journalctl --user -u harnessd.service -f`. Start, stop, and restart may be performed with the corresponding `systemctl --user` commands.

## Safety and failure behavior

- The unit contains executable and working-directory paths only, never `.env` values. The unit file is created with owner-only permissions. POSIX credential `.env` files should also use mode `0600`.
- Install refuses to replace an existing unit that is not marked as harnessd-managed. Uninstall refuses to remove an unmanaged unit. Failed systemd commands are explicit errors; uninstall does not remove the unit if stopping/disabling fails. A failed install may leave the generated unit in place for inspection/retry.
- Commands are supported only on Linux with a working user systemd manager. Unsupported platforms, relative XDG config paths, Node executable paths containing systemd-unsafe characters (control characters, quotes, or backslash), and unavailable systemd operations fail explicitly; there is no `sudo` or fallback to a system-wide service.
- Unit installation/removal never deletes `.env`, SQLite state, workspaces, packages, or other unit files. Service tests use temporary directories and mocked systemctl calls; they never modify the real user manager.
- Graceful shutdown persists selected session metadata; the Telegram transport restores each chat's selection after service restart and resumes a deliberately stopped Pi session only when a new message arrives (or `/resume` is invoked), never at startup. Abrupt supervisor-crash recovery remains out of scope: a session row may be stale and marked `running`; uncertain inputs are never resent. OS service management does not change the transport, harness, process-provider, or isolation contracts.

## Non-goals and related contracts

Automatic service creation during npm installation, Windows/macOS service managers, daemonization outside systemd, login lingering, restart/watchdog policy, supervisor-restart session recovery, and secret management are out of scope. See [package release](package-release.md), [CLI configuration](cli-configuration.md), [Telegram transport](telegram-transport.md), and [core session management](core-session-management.md).
