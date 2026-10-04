# Surface contract: package versioning and distribution

## Boundary and ownership

This surface defines the package identity, version compatibility promise, local installation, and release handoff for `harnessd`. `package.json` owns the package version and executable entry point; `package-lock.json` records the same root package version and dependency graph. Maintainers approve version changes and releases. This contract does not publish or deploy the service.

## Version policy

- Versions follow Semantic Versioning `MAJOR.MINOR.PATCH`, optionally with standard prerelease and build metadata identifiers.
- `MAJOR` changes when an upgrade requires a consumer to adapt to an incompatible CLI, environment, package, or documented behavior change.
- `MINOR` adds backward-compatible functionality; `PATCH` fixes backward-compatible defects. Pre-1.0 versions do not promise the stable compatibility guarantees of `1.0.0`.
- Prerelease identifiers such as `alpha.1`, `beta.1`, and `rc.1` identify a candidate and do not claim a stable release. Build metadata does not affect SemVer precedence.
- Change versions for releases, not for every feature branch or pull request. `package.json.version`, `package-lock.json.version`, and `package-lock.json.packages[""].version` must agree.

## Local installation and package contents

- The supported owner-test flow installs a Git URL into a non-global local npm prefix or consumer project. npm runs the package `prepare` lifecycle to build TypeScript output before installing the dependency. Global installation directly from a Git URL is not claimed in this phase. Installing the npm package never modifies system services; an owner may explicitly use `harnessd service install` for a Linux per-user systemd unit after preparing `.env`.
- The declared `harnessd` binary and every module it imports under `dist/src` must be included in the package payload, so a future approved registry installation can link the CLI without building from Git source. The CLI recognizes direct execution by comparing resolved module and entry-point paths, so both `node <cli.js>` and npm's `.bin` symlink invoke the command (including `--help`).
- The package allowlist includes runtime output, user-facing documentation, and the published package surface contracts; tests, local state, credentials, caches, and inbox data are not distributable package contents.
- Private Git installation requires the user's normal repository access. Never place access tokens or other credentials in a saved Git URL or documentation example.
- `npm pack --dry-run` is the local payload check. A Git install smoke uses a pinned commit in a disposable temporary prefix and invokes `harnessd --help`; it does not start Telegram polling or Pi.

## Release procedure

1. Obtain owner approval for the release and target SemVer version. The first stable `1.0.0` release requires owner signoff after local product testing.
2. In a release PR, use `npm version <major|minor|patch|prerelease> --no-git-tag-version`, review the matching manifest/lockfile updates, and add a dated `CHANGELOG.md` entry. Run the full project checks, version check, and package dry-run; obtain independent review.
3. Merge the approved release PR. Create the annotated `vX.Y.Z` tag only from the approved merged `main` commit, and push it only with release approval.
4. npm publication is a separate, explicitly approved action. The current package is private (`private: true`); do not change visibility, registry access, or publish as part of ordinary version bumps.

## Current status and limits

The package is `0.1.0`, `private: true`, and intended for local Git-based owner testing. It is not currently published to npm. GitHub Actions CI validates pull requests targeting `main` and pushes to `main`; it does not create tags, GitHub Releases, deployments, or npm publications. Publication visibility, credentials, ownership, and release approval must be decided before any future npm release.

## Related contracts

- [Core session management](core-session-management.md)
- [Pi RPC harness](pi-rpc-harness.md)
- [Direct Node process provider](process-provider.md)
- [Transport adapter](transport-adapter.md)
- [Telegram transport and CLI](telegram-transport.md)
- [CLI configuration](cli-configuration.md)
- [Per-user systemd service](user-service.md)
