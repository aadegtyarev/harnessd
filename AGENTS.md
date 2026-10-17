# Project instructions

<!-- BEGIN ad-pi-addons contract workflow -->
## Contracts and feature work
- Read `docs/contracts/meta-contract.md` before implementing or reviewing a feature.
- Before implementation, agree on and save the approved feature contract under `docs/contracts/features/`; identify and read affected `docs/contracts/surfaces/` contracts.
- Give the exact contract paths to the planner, implementer, and reviewer. If working directly, use the same contracts as the source of truth.
- If implementation reveals a changed surface or acceptance scope, stop and get approval before proceeding. After verification, update affected surface contracts, mark the feature contract complete for final verification, then delete the temporary feature-contract file.
- Preserve existing instructions and surface contracts; never overwrite or delete them silently. Feature contracts are temporary task artifacts and must not remain after verified completion.
- Use available subagent roles only when configured. For nontrivial codebase or documentation reconnaissance, delegate bounded, read-only investigation to a suitable configured role when available; request relevant source paths and concise evidence, not whole-document dumps. Keep trivial lookups direct. The parent owns scope, decisions, synthesis, verification, and user communication. If no suitable role is available, work directly from the same contracts and checks, and state if independent review cannot be obtained. This rule does not require named Pi skills.
- End every task with a concise user-facing report of what changed, checks and outcomes, and remaining risks or blockers. Do not finish with tool output alone or end silently; this rule requires no installed skills.
<!-- END ad-pi-addons contract workflow -->

## Git workflow
- Before code changes, verify the target branch and worktree, then create a task-specific branch from the up-to-date target; do not implement directly on `main`. Keep unrelated existing changes out of the task branch/PR unless approved.
- Commit meaningful verified increments during implementation.
- At completion, push the branch and open a PR to `main`; merge only when applicable local validation and all required remote checks are green, required review is clear, and no blockers/conflicts remain. Do not wait for a separate merge confirmation. For changes to runtime or installed package behavior: before merge, bump the version in the same PR (`npm version patch|minor --no-git-tag-version`, dated `CHANGELOG.md` entry; see `docs/contracts/surfaces/package-release.md`) and run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run version:check`, and `git diff --check`; after merge, create the annotated `vX.Y.Z` tag on the merged commit and push it.
- Do not merge while required checks are pending/failing or blocking review remains. If remote access/checks block delivery, report that and leave the change unmerged.
- After a successful merge that changes runtime or installed package behavior, both installing the merged version and restarting `harnessd.service` wait for the operator's explicit go for that deployment (2026-10-17: no standing authorization); until then report "merged vX.Y.Z, deployment pending". Documentation/backlog-only PRs do not require a production restart. Use the documented exact-commit local Git install procedure in `README.md`, then verify the service is active. Never inspect or print `.env`, Telegram credentials, or other production secrets during deployment.
- Ask before deploying changes that require a database/schema migration, destructive production state changes, unavoidable service downtime, or carry material production risk not covered by validation. If the documented safe deployment procedure is unavailable or deployment fails, stop and report the blocker without claiming production was updated or attempting an unapproved rollback.

## Project-specific commands and conventions
- Stack and important paths: Node.js 24+, TypeScript strict ESM (`NodeNext`); npm. Core adapter contracts live in `src/core/`, CLI entrypoint in `src/cli.ts`, and tests in `test/`.
- Tests / typecheck / build: `npm test`, `npm run typecheck`, `npm run build`.
- Formatting and style: Biome; `npm run lint` checks formatting and lint rules, `npm run format` applies formatting.
- Project-specific constraints: Keep transport, harness, process-provider, and secret-provider boundaries independent. Unsupported adapter capabilities must fail explicitly; do not silently fall back. Do not implement Telegram polling, persistence/schema, harness RPC, process supervision, or watchdog behavior without approved feature scope.
