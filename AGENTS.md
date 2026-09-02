# Personal Agent Control project contract

## Scope and source of truth

This file covers the public PAC Core repository. Canonical workflow inputs live
under .rulesync/rules and .rulesync/agents; source modules, catalogs, payload
Skills, and pinned manifests are reviewed Git state. Files under generated/ and
host projections are derived: edit their canonical source and regenerate them.
Core is public; do not place private Profile facts, credentials, or machine-only
locators here.

## Operating constraints

- PAC is a control plane, not a second agent runtime, package solver, router,
  scheduler, or native Plugin/MCP implementation. It may install one explicitly
  marked, fail-closed PreToolUse scan-guard fragment in each host config; the
  host remains owner of every other hook, setting, Plugin, and MCP field.
- Never build or run the full test suite in a synchronized OneDrive checkout.
  Use a WSL-local clone/runtime under ~/.agent-work and keep generated indexes,
  logs, caches, and intermediates outside source.
- Preserve one owner per installed path and the fail-closed provider, Profile,
  host, lock, and rollback boundaries documented in docs/ARCHITECTURE.md.
- Use bounded, explicit roots for discovery; do not add recursive filesystem-wide
  scans or unreviewed network/update behavior.
- Raw `rg`/`find`/equivalent directory traversal is denied by the host gate.
  Directory discovery must use the local workspace index or the PAC
  `resource-guard` route with one registered local root and its caps; small
  exact-file reads still require an explicit result/file-size bound.
- Keep public catalogs free of private Profile paths and secret-bearing values.

## Request scope routing

- Treat a new user-supplied constraint as project-scoped by default when a
  verified repository is active: record repository, subtree, command, test,
  generated-file, dependency, or storage rules in this contract, an ADR, or
  the project ledger.
- Change PAC Core/Profile or record a global preference only when the user
  explicitly says global/all projects/PAC or describes a repository-independent
  rule. Keep ambiguous wording as an inferred project candidate; do not promote
  it merely because it is repeated or appears reusable.
- Reserve machine scope for an explicitly cross-project host fact and task
  scope for a temporary instruction. Existing explicit global policy remains
  higher authority than this routing heuristic.

## Verification oracles

- Fast source checks: git diff --check, node --check on changed .mjs files, and
  the relevant targeted node --test file.
- Full gate: run mise run check from this repository's pinned tool environment;
  success requires integrity, catalog, generated-adapter, shell, secret,
  dependency, and test checks together.
- Rules changes require ./scripts/render.sh --check after regeneration.
- Compare failures with the documented baseline in docs/VERIFICATION.md; do not
  treat a pre-existing environment failure as a regression without the baseline.
- A release is not complete until the exact commit, generated diff, and skipped
  or unavailable oracles are recorded.

## Workflow and completion

Keep a compact task ledger and receipts in the WSL-local PAC runtime, not this
repository. Record design changes in docs/DECISIONS.md and durable evidence in
docs/RESEARCH.md or docs/VERIFICATION.md. Use reversible edits, inspect the
diff, run the narrow oracle first, then the full gate when tools are available.
Do not push, publish, or change a host unless the user names the exact target.

Completion means canonical source, generated adapters, catalogs, manifests,
tests, and integrity receipts agree at one Git commit, with remaining risks
explicitly reported.

## Map

PAC entrypoint: bin/pac -> src/cli.mjs -> src/commands.mjs. Rulesync inputs are
.rulesync/; host adapters are generated/. Runtime ownership and transactions
are in src/, while capability metadata and provider declarations are in
catalog/. Read docs/ARCHITECTURE.md for boundaries, docs/INSTALL.md for
installation, and docs/VERIFICATION.md for the acceptance contract.
