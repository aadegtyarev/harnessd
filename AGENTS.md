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

## Project-specific commands and conventions
- Stack and important paths: Node.js 24+, TypeScript strict ESM (`NodeNext`); npm. Core adapter contracts live in `src/core/`, CLI entrypoint in `src/cli.ts`, and tests in `test/`.
- Tests / typecheck / build: `npm test`, `npm run typecheck`, `npm run build`.
- Formatting and style: Biome; `npm run lint` checks formatting and lint rules, `npm run format` applies formatting.
- Project-specific constraints: Keep transport, harness, process-provider, and secret-provider boundaries independent. Unsupported adapter capabilities must fail explicitly; do not silently fall back. Do not implement Telegram polling, persistence/schema, harness RPC, process supervision, or watchdog behavior without approved feature scope.
