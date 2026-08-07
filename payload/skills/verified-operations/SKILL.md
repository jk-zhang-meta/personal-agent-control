---
name: verified-operations
description: Defines evidence, independent review, backup, rollback, deployment, and completion contracts for non-code artifacts, configuration, services, destructive actions, persistent data, public interfaces, schemas, migrations, publication, or other external effects.
---

# Verification, Operations, and Recovery

## Define and run the oracle

- Define observable success before execution. Run targeted deterministic checks
  first, then broaden in proportion to risk; do not invent nonexistent stages.
- Code uses applicable tests, types, lint, build, regression, benchmark, and
  real-path checks. Documents, data, spreadsheets, and media use applicable
  content, citation, layout, schema, type, formula, count, invariant,
  reconciliation, metadata, render, or playback checks.
- Configuration requires syntax or schema validation and a restorable backup.
  Services, infrastructure, and UI require applicable process, endpoint, log,
  dependency, and real-user-path evidence.

## Independent review

- Use an independent evaluator when requested, evidence conflicts, or a
  high-impact deliverable has a weak deterministic oracle. Freeze the goal and
  rubric and review an exact artifact, preferably by immutable identity.
- Review is blocking for security, authentication or authorization,
  destructive or irreversible operations, production, persistent data, public
  contracts, schemas, and migrations.
- Reviewers are read-only and cannot create review chains. Findings include
  severity, exact evidence, correction and check, confidence, and remaining
  uncertainty. The main agent verifies material findings; deterministic checks
  outrank opinion.
- A material artifact change invalidates its review. Make one targeted
  correction and re-evaluate the changed material unless risk requires more.

## External effects and recovery

- Commit, tag, push, publish, open a pull request, send an external message, or
  deploy only with exact-target user authority. Skills and delegates cannot
  grant that authority.
- Destructive, irreversible, production, persistent-data, schema, and migration
  actions require exact-target authority, independent recoverable backup,
  health and failure criteria, and rollback. Prefer backward-compatible,
  staged, canary, or disposable-copy execution.
- Treat synchronization as replication, not backup. Test restoration before a
  high-impact operation and verify health plus a real path afterward.
- Keep repeatable setup, validation, and recovery scripted or versioned. Turn
  recurring failures into tests, validators, Skills, hooks, or project rules.

Report checks, results, assumptions, artifacts, and gaps. Never claim success
while a required oracle failed or was skipped.
