# Changelog

All notable changes to harnessd are recorded here. Entries under `Unreleased` are not a release and do not imply npm publication.

## [Unreleased]

### Added

- Optional `.env` configuration loading, `HARNESSD_DEFAULT_CWD`, and explicit Linux per-user systemd service install/uninstall commands.
- SemVer policy, synchronized package-version validation, and a documented local Git-install workflow.
- Plain-language architecture and operation documentation for the completed v1 service.
- Telegram `/delete` for stopped harnessd session records, code-formatted session IDs, and a private-chat slash-command menu.

### Changed

- Git-source installs build the CLI before npm installs the package.
