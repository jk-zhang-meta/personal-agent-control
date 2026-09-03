# Verification Contract and Record

This document defines the observable contract for the current public-Core,
private-Profile, and Derived Runtime architecture. Historical monolithic and
Core-mutation results are intentionally omitted; Git history remains the source
for those superseded revisions. A result applies only to the exact working tree
or commit that produced it.

## Completion rule

PAC is healthy only when all applicable source, ownership, runtime, projection,
and recovery checks pass together. A passing unit test cannot compensate for a
failed lock, path, Plugin, rollback, or live-host check. Optional tests must be
identified as optional rather than silently counted as acceptance.

`activation.ready` is a transaction-staging signal, not a healthy result. It
may be true only when every ordinary invariant passes and the sole remaining
condition is an exact, structurally verified Codex hook whose host trust state
is `untrusted` or `modified`. `ok` remains false, strict doctor remains red, and
deployment is incomplete until the exact current hook hash is trusted and a
real host high-impact canary proves enforcement while ordinary-work canaries
pass without PAC intervention.

## State-layer invariants

| Layer | Required invariant | Primary oracle |
|---|---|---|
| Public Core | Reviewed workflow, generated adapters, Core APM graph, catalogs, and provenance match the exact source revision | source-integrity manifest, Rulesync drift, schema/catalog checks, Gitleaks |
| Editable Profile workspace | Real Git worktree below HOME; closed layout; changes validate before commit; publishing is private and explicit | Profile workspace tests, Git HEAD, `gh repo view` after authorized publication |
| Active Profile | Descriptor names repository, safe ref, and full locked commit; cached checkout is clean, tracked, immutable, and schema-valid | `pac profile status`, commit/path/digest/catalog checks |
| Derived Runtime | Reproducible from Core plus optional locked Profile; no runtime artifact is canonical source | `pac status`, `pac doctor`, lock/hash/ownership/projection checks |

The editable workspace and active Profile are deliberately different. An
uncommitted workspace edit must not affect `pac apply`; activation occurs only
after validation and a Git commit. The descriptor and immutable cache must not
be edited as an authoring surface.

## Responsibility checks

### Rulesync

- Compiles only public common workflow in a temporary HOME.
- Generated Codex and Claude artifacts exactly match reviewed source.
- Profile bootstrap, context, Skills, and Plugins never become Rulesync input.
- No direct Rulesync write targets the real user HOME.

### APM

- Exact APM version matches the pinned toolchain.
- Core `apm.yml` and lock semantically match the Core runtime lock and every
  deployed file hash.
- A non-empty Profile APM manifest has a lock; an empty graph has no stale lock.
- Profile dependencies frozen-install into the repository/commit-keyed Profile
  runtime, and discovered identities match the Profile lock.
- Missing or drifted Core/Profile runtime content makes status fail closed.
- PAC does not maintain a second source-resolution or dependency-solving table.

### Git and `gh`

- Normal apply uses the descriptor's full commit and never follows its moving
  ref.
- `pac profile update` is the only remote-ref activation path.
- `pac profile sync` commits, pulls with `--ff-only`, pushes, and activates the
  exact resulting commit.
- `pac profile publish` uses `gh` only after explicit publication authority and
  creates a private repository.
- Credential-bearing repository locators, unsafe refs, moved expected commits,
  untracked consumed content, and dirty immutable caches fail closed.

### Native Plugins

- Core and Profile Plugin rows merge append-only; duplicate Plugin,
  marketplace, provider, or bundled-Skill identities fail closed.
- PAC calls each selected host's native Plugin mechanism and verifies the native
  registration/cache result rather than flattening the package into Skills.
- A runtime-generated Plugin manifest rewrite is accepted only when it matches
  the strict, semantics-preserving normalization contract; arbitrary source
  edits, index changes, and untracked files still fail closed.
- Hooks, MCP servers, Apps, authentication, sessions, and unrelated native
  state stay host-owned.
- Removal touches only state whose prior ownership and exact identity are
  proven.

### PAC overlay, routing, transaction, and adapters

- Core/Profile capability overlays are append-only and cannot shadow identities.
- Embedded Profile Skills match frontmatter identity, content digest, and host
  targets; Profile APM Skills derive identity from the lock.
- A `context:<id>` row resolves only to an ordinary non-symlink Markdown file
  inside the immutable Profile. SQLite contains its routing metadata and exact
  load path, never its body.
- Resolver results honor host, visibility, kind, category, and activation
  semantics; `kind.context` is selectable and default discovery includes it.
- The private bootstrap is copied from the active commit with digest ownership;
  an unmanaged collision or modified managed file blocks apply.
- Codex/Claude adapters and Skill links are reconciled only for
  `enabled hosts intersect operation scope`.
- PAC-owned links point to the expected neutral roots; same-named unmanaged
  directories or different links are preserved and block conflicting apply.

## Update semantics

The following paths must remain distinct in tests and operator output:

| Command | Permitted change | Must not change implicitly |
|---|---|---|
| `pac apply` | Reconcile Derived Runtime from current desired state | Core revision, Profile ref/commit, editable workspace |
| `pac self-update` | Fast-forward the clean Core checkout | Profile source or personal package choices |
| `pac profile update` | Resolve, validate, and select a newer commit from the active Profile ref | Editable workspace or Core |
| `pac profile sync` | Validate/commit and Git-sync the editable workspace, then activate its exact commit | Core |
| `pac skill add\|remove\|update` | Profile workspace APM manifest, lock, routing leaf, commit, and derived installation | Core APM manifest/lock |
| `pac plugin add\|remove` | Profile enable/disable overlay, commit, and native host reconciliation | Core Plugin declarations or host-owned unrelated state |

An update is complete only after validation, one backup, reconciliation,
resolver rebuild, status/doctor checks, and a receipt. A remote publication or
Git commit is durable history and is not undone by runtime rollback.

## Rollback semantics

Before the first managed mutation, one transaction snapshot must include every
owned surface that can change, including:

- machine host activation;
- active Profile descriptor;
- private bootstrap and its ownership record;
- managed instruction/reviewer adapters;
- Skill ownership, neutral view, and target-filtered host links;
- managed Plugin source/marketplace/registration/cache surfaces; and
- resolver database removal/rebuild state.

A late failure restores that same snapshot and reports whether rollback and
resolver recovery succeeded. `pac rollback [BACKUP]` uses the explicit snapshot
argument or the private `last-backup` pointer, then records a new rollback receipt.
Rollback does not rewrite the public Core, editable Profile Git history,
immutable Profile cache, authentication, sessions, unrelated Skills, or
unmanaged Plugin data. Synchronization is not treated as backup.

## Current evidence

Targeted hook-staging checks run on Linux x86-64 on 2026-09-03:

- the hot-update regression staged policy revision A, captured its generated
  command, staged and activated revision B, then executed both captured
  commands successfully while status validated B;
- the backup/restore round trip preserved a digest-named policy file;
- the real PAC apply path reconciled an exact scan guard, observed Codex's
  camelCase `hooks/list` entry as `untrusted`, retained the installation as
  explicitly non-healthy staged state, then converged to healthy only after
  the same key/hash was reported trusted;
- the built-in doctor accepted only `healthy + exit 0` or one fully bound
  pending Codex trust action with `exit 1`; forged pending metadata and a
  payload/exit-code mismatch both failed; and
- staged state propagated through JSON, the operation receipt, and human
  output without using the word `complete` or triggering rollback.

Targeted checks run on Linux x86-64 on 2026-08-07:

- `node --test tests/capability-resolver.test.mjs tests/profile-catalog.test.mjs tests/profile-context-routing.test.mjs`: 22 passed, 0 failed, and the optional 10,000-capability smoke was skipped.
- `node --test tests/profile-apm.test.mjs`: 3 passed, 0 failed. This covers
  no-Profile/empty-graph short-circuiting without APM access, provisional
  identity derivation from the Profile lock, and fail-closed missing runtime.
- `node --test tests/profile-apm.test.mjs tests/profile-bootstrap.test.mjs tests/profile-context-routing.test.mjs tests/profile-workspace.test.mjs`: 10 passed,
  0 failed, covering the joined Profile authoring, bootstrap, context, and APM
  responsibility seams.

An earlier split candidate passed `mise run check`, but that run predates the
final editable-workspace, Profile APM, private-bootstrap, and context-routing
refinements. It is supporting evidence, not final release acceptance.

## Required final gate

Before release or live installation of a new revision:

1. run `mise run check` from a clean, exact source revision;
2. exercise the Profile workspace, bootstrap, Profile APM, context routing,
   attach/update/detach, native Plugin, host-scope, drift, and late-failure
   rollback paths in isolated HOME fixtures;
3. run an independent read-only review against an immutable commit or complete
   working-tree digest;
4. install Core-only from an anonymous clean clone of the public history;
5. attach a private Profile through authenticated Git and verify ordinary
   apply remains pinned while explicit sync/update advances it;
6. run full-history secret/provenance/license checks on the public repository;
7. verify both supported hosts on their native Linux/macOS environments; and
8. report every skipped or unavailable oracle rather than claiming completion.

No commit, push, publication, host replacement, or deletion is implied by a
passing local gate; each external effect still requires its exact authority.
