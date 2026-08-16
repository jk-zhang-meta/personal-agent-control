# Architecture

## Objective

Personal Agent Control is a small configuration control plane, not an agent
runtime, package manager, VCS client, or Plugin runtime. A public Core gives
multiple agent hosts one reviewed common workflow, catalog, host contract, and
repeatable deployment path. An optional private Configuration Profile adds
personal bootstrap, context, Skill dependencies, and Plugin choices without
making the Core private. Profile provider selections and wildcard Skill targets
follow the Agent set supported by the installed Core.

The design optimizes for four properties:

1. deterministic rules that must always load;
2. progressive disclosure for detailed methods and private facts;
3. exactly one writer for every installed path; and
4. no per-agent copy of a dependency that can be shared safely.

## Responsibility boundaries

PAC composes mature tools rather than reimplementing their control planes:

| Owner | Sole responsibility in this system | Explicitly not its responsibility |
|---|---|---|
| Rulesync | Compile the public, common workflow into reviewed Codex and Claude instruction artifacts | Profile content, Skill installation, host deployment, or runtime mutation |
| Microsoft APM | Resolve, lock, update, and frozen-install the Core and Profile portable Skill dependency graphs | Capability routing, host projections, native Plugins, or transactions |
| Git and `gh` | Identify Profile revisions; clone/fetch immutable commits; synchronize an editable workspace; create and push a private Profile repository | Installed-state reconciliation or Skill/Plugin activation |
| Agent-native Plugin/MCP mechanisms | Run Plugin bundles, Hooks, MCP servers, Apps, and host caches | Portable standalone Skill packaging or cross-Agent desired state |
| PAC | Declare supported Agents and provider adapters; validate overlays; coordinate one transaction; reconcile host-native configuration/projections; verify and restore owned state | Re-resolving packages, inventing a VCS protocol, compiling Profile rules, or emulating a Plugin/MCP runtime |
| Chezmoi and mise | Deploy reviewed host files and provide the pinned machine toolchain | Capability policy or user-specific desired state |

This assignment is a design constraint. PAC may call these tools and adapt
their outputs, but it must not grow a second package solver, workflow compiler,
Git synchronizer, or Plugin implementation.

## Layers

```text
Source layer
├── public Core checkout
│   ├── common Rulesync workflow and reviewed generated adapters
│   ├── Core APM manifest + lock
│   └── public capability, Plugin, provider, and supported-Agent declarations
└── optional private Profile
    ├── editable Git workspace + workspace descriptor
    ├── immutable active descriptor: repository + ref + locked commit
    └── immutable cached checkout at that commit

Derived Runtime layer
├── Chezmoi host instruction/reviewer projections
├── mise pinned shared tools
├── APM Core runtime + separate content-addressed Profile APM runtime
├── PAC-owned neutral Skill view + target-filtered host links
├── host-native Plugin registrations and caches
├── host-native MCP provider configuration selected by the Profile
├── PAC-installed private bootstrap
└── metadata-only capability SQLite index
```

The Core and Profile are canonical source state. Everything in Derived Runtime
is reproducible and disposable. An editable Profile workspace is never the
active Profile merely because it has uncommitted files: PAC validates and
commits it, then activates the exact resulting commit through the immutable
descriptor. Likewise, an immutable cached checkout is never edited in place.

### Deterministic always-on layer

`.rulesync/rules/00-kernel.md` contains only stable cross-task invariants:
source and target verification, scope and authority boundaries, main-agent
ownership, proportional native orchestration, a capability-agnostic discovery
protocol, private and external-effect boundaries, completion criteria, and an
adaptive human-reviewability contract. It names no installed Skill, Plugin,
domain, model, or host API.

Generic communication defaults that safely apply to every user remain in the
Core rules. The compiled kernel contains one stable conditional instruction to
read `~/.config/personal-agent-control/profile-bootstrap.md` when present. PAC
installs that short private bootstrap from the locked Profile with digest-based
ownership; larger interests, machine facts, storage routes, and credential
locators remain progressively loaded Profile context or Skills. A Profile
cannot contribute top-level Hooks, scripts, or Rulesync rules.
Explicitly locked Skills may contain invoked helper scripts, and enabled native
Plugins retain their reviewed Hook/MCP/App surfaces.

The section ABI and a 120-line/900-word kernel ceiling are repository
governance guards, not claims of a universal model optimum. A global rule is
admitted only when it is cross-host, cross-project, stable, behaviorally
necessary, testable, and not better enforced by a project instruction, Skill,
agent, Hook, permission, configuration, or tool.

Rulesync compiles these inputs into `generated/codex/AGENTS.md` and
`generated/claude/CLAUDE.md`. The generated files are reviewed and committed;
Rulesync is never allowed to generate directly into a real user home.

The response contract is deliberately layered. The kernel supplies only
result-first ordering, evidence and uncertainty placement, progressive detail,
and the human-versus-machine output boundary. Task Skills and reviewer agents
own specialized schemas such as citation ledgers or severity-ranked findings;
an invocation or API owns exact JSON when a program, rather than a person, is
the consumer.

### Progressive capability layer

Every detailed method is a native Agent Skill. Runtime names do not identify
where a Skill came from. Core `packages/skills/apm.yml` and its reviewed lock
declare the public dependency graph. A Profile may declare its own independent
`packages/skills/apm.yml` and lock; APM frozen-installs that graph into a
content-addressed Profile runtime keyed by repository and commit. PAC validates
the discovered identities and overlays their verified roots into the common
neutral view. Profile dependencies must use repository references; local paths
are rejected because the Profile is a cross-machine layer. Neither graph
mutates the other. PPT Master v4.3.0 is the sole
Core materializer exception
because APM 0.28.0 rejects the very large lock it generates for that package
under its own YAML expansion safety budget. PAC still installs that exception
from its exact commit and verifies the full installed tree digest. A Profile may
also carry a small content-addressed private Skill directly; this is Profile
data, not a second PAC dependency solver.

The Core `catalog/capabilities.jsonl` and optional Profile overlay provide
routing, target support, visibility, aliases, triggers, anti-triggers, and
activation policy. They cannot
invent a Skill: the resolver joins it to the installed, frontmatter-validated
inventory. Profile rows are append-only additions: any duplicate Skill,
capability, or Plugin identity conflicts with Core or another Profile row and
fails closed. The physical store may
contain the whole reviewed catalog, but PAC exposes names only to enabled,
supported hosts. A host-view change therefore repairs links without reacquiring
upstream content.

`host-conditioned` means one shared Skill contains a small host-aware branch or
uses whichever equivalent native facility is present. `portable-with-sidecars`
means the core is shared while optional integrations may differ. A genuinely
exclusive Skill is assigned one host target and is never projected to the
other. No current Skill requires two physical copies or a separate install-level
entrypoint, so v1 deliberately has no adapter tree. Add such a thin adapter only
after a real Skill cannot express the difference safely inside one shared
contract.

Routing has three distinct owners:

1. the global kernel defines one capability-agnostic discovery and arbitration
   protocol;
2. each Skill's concise description is the host-native ordinary selector; and
3. thin domain routes such as `software-workflow` compose leaves only where
   repeated evaluation demonstrates a real coordination need.

Zero-miss safety and authority semantics remain in the kernel, while their
detailed procedures live in Skills and deterministic enforcement belongs to
native Hooks, permissions, configuration, CI, or other host controls. A Skill
name is never used as a security boundary.

The Core APM manifest and lock remain the source of public portable package
provenance and placement. `catalog/taxonomy.json` supplies the reviewable
category tree, while the merged Core/Profile capability rows supply
nonexclusive many-to-many routing metadata for installed identities.
Provider/child relationships come from the merged Plugin inventory. Adding a
leaf changes these bounded data files, not the global kernel.

Native descriptions remain the ordinary selector. When no Skill is clearly
applicable, several domains overlap, the active catalog is too large to inspect
reliably, or the user asks what is installed, `capability-resolver` performs an
explicit read-only lookup. It combines exact names and aliases, category-tree
membership, word FTS, and substring fallback under hard host, kind, and
visibility filters. Task text can automatically match several taxonomy
categories; categories are evidence channels rather than an exclusive branch
choice. Stable reciprocal-rank fusion produces a small result set with the
catalog revision and structured evidence naming the channel, request fragment,
matched metadata field and value, and category path when applicable. A wrong
category hint cannot hide a relevant global text match.

The resolver models one capability record format without flattening runtime
semantics. A Skill resolves to its exact `SKILL.md`; a Profile context resolves
to the exact regular Markdown path inside the immutable Profile; a subagent
resolves to a native delegation target; and a Plugin is a provider whose bundled Skills
share the globally unique v1 identifier form `skill:<name>`; strict metadata
validation rejects a collision rather than inventing a provider namespace.
Machine dependencies in `catalog/tools.tsv` are not task capabilities. Future
Apps and MCP providers fail closed: they are absent from v1 lookup until a
reviewed runtime overlay defines their host-native handles and activation.

Index construction reads only bounded catalog rows, routing/taxonomy metadata,
and each installed Skill's frontmatter name and description. Profile context
bodies remain outside SQLite; only their routing metadata and exact load path
are stored. The index never contains a Skill body, Plugin runtime data,
conversation content, credentials, or other host state.

The active catalog is deliberately curated rather than unbounded. Current
hosts expose every active Skill's metadata before loading its body; packaging
or namespacing does not remove that cost. If specialist Skills grow enough to
trigger host truncation or omission, they must move to project, role, or phase
scopes and be enabled as packs. Low-frequency one-off Skills may be used from
an exact reviewed source without permanent global installation. No second
automatic semantic-routing engine is introduced: the local resolver is an
advisory on-demand index and cannot execute, install, enable, authorize, or
schedule anything.

Use a native Plugin only when a capability needs a package-level runtime, hooks,
MCP, host manifests, or another lifecycle that an independent Skill cannot
preserve. The Core and optional Profile `catalog/plugins.tsv` files record
Plugin identity, marketplace, immutable Git commit and tree, version, target
hosts, license, visibility, and the complete bundled-Skill inventory. One
checkout under
`~/.local/share/agent-plugins/sources/<marketplace>` is the source authority;
Codex and Claude then create their required native caches. Those caches are
projections, not duplicate Skill sources.

The public Core native Plugin is `context-mode`, whose Skills require hooks and
an MCP runtime. The private `automated-rebuttal-workflow` Plugin and its
host-specific confirmation adapter belong to the Configuration Profile.
Draw.io exposes no
Plugin-only facility, so PAC materializes its identical upstream Skill once and
records a one-time native-Plugin-to-Skill migration. System-bundled Skills and
uninstalled marketplace source trees remain host-owned exclusions.

Native marketplace identity includes its source path. Session launchers and
other companion tools may consume PAC's installed Plugin, but must not register
or update a second `context-mode` marketplace. A launcher that bundles the same
Plugin is therefore incompatible until that ownership is disabled or removed.

Upstream source trees are not vendored. Tag acquisitions are checked against
their resolved commit and Vercel source/ref/path identity. Every installed tree
must also match the catalogued deterministic content digest. Repositories
without a stable release are accepted only by an explicit immutable commit
archive plus that same digest. Private facts live one reference level
below `personal-environment` and are loaded only when a task needs them.

The existing monolithic Git history contains private Profile material and is
not a safe publication source. A public Core release must start from a fresh,
allowlisted history after content, secret, provenance, and license audit. Never
change the old repository's visibility and assume deletion or `.gitignore`
removed its historical private data.

### Optional durable execution seam

PAC remains a configuration control plane. It may install, configure, project,
and verify a durable runtime extension, but it does not execute user tasks,
provide a `pac run` command, or own workflow state. At task time,
`graph-workflow` is the sole coordinator only for graph-worthy work. It is an
escalation path, not a final stage through which ordinary answers, serial edits,
simple edit-then-test work, or one bounded parallel wave must pass.

The task-facing Interface stays provider-neutral. An ordinary request returns
its result through the active host. A durable request returns an opaque run
reference that can later be inspected or signalled with input, approval, or
cancellation. Provider-specific thread, checkpoint, queue, and database details
remain behind the execution-surface Seam. The default `NativeHostAdapter` uses
the active host's plan, task, delegation, and resume facilities. An optional
`DurableRuntimeAdapter`, initially LangGraph for application-level durable
research graphs, satisfies the same graph contract when native state cannot
meet the required lifetime or sharing semantics.

Execution selection is hybrid and explainable. The host model may extract task
facts and recommend an execution surface, but a deterministic policy makes the
final choice:

1. an explicit durable request selects the configured durable Adapter;
2. an explicit native request is accepted only when it does not contradict a
   required durability guarantee;
3. automatic durable selection requires at least one hard workflow-control
   need: automatic continuation across a host or process restart, shared
   workflow state across people or machines, continuation after an external
   event beyond the session, scheduled control flow, or required
   checkpoint/replay semantics; and
4. every other task stays native.

Apparent complexity, step count, agent count, a model's duration estimate, or a
single scheduler-owned long computation is not sufficient to select a durable
runtime. If a hard workflow-durability requirement exists but its Adapter is
unavailable, incompatible, or unauthenticated, the
request fails closed with the unmet guarantee; it never silently restarts as a
native task. Provider submission, a successful node return, or a worker's
completion claim is likewise not verified completion. The coordinator must
check the declared artifact and oracle before advancing authoritative state.

Runtime and durable project state keep separate writers:

| State or artifact | Sole authority |
|---|---|
| PAC extension source, version, projection, and machine activation | PAC's existing install transaction |
| Endpoint selection and credential locator | Configuration Profile and host-native authentication |
| Native task, session, and worker state | Active Codex or Claude host |
| Durable run, dependency, checkpoint, interrupt, and attempt state | Selected durable runtime and its persistent store |
| Graph definition, state schema, workflow version, research protocol, and completion oracles | Verified project root |
| Datasets, models, logs, and large generated artifacts | Project-declared artifact or data store |
| GPU, cluster, or batch-job lifecycle | External compute scheduler |

The durable runtime's run reference is the only cross-session cursor; PAC does
not mirror it into a second task database. A multi-person project uses one
shared durable deployment per project or trust domain, with thin per-user host
Adapters and independently authenticated identities, rather than one server per
user. An in-memory store does not satisfy restart survival, and a per-user local
store does not satisfy shared-state ownership.

Scientific graph state contains immutable artifact references and digests, not
large datasets, models, data frames, logs, or binaries. Each external experiment
records the workflow and code revision, environment identity, data and model
versions, parameters and seeds, compute job identity, artifact references and
digests, and oracle result. External submissions and other side effects use a
provider-supported idempotency identity or reconcile an existing job or artifact
before retrying. If submission may have succeeded but no reliable identity can
be recovered, the outcome is ambiguous and PAC does not submit again blindly.
Checkpoint recovery is not treated as scientific provenance or as an artifact
backup.

Adoption proceeds in four evidence gates: shadow recommendations with no
automatic submission; one explicitly selected durable research pilot; automatic
routing for hard needs only after restart, duplicate-effect, authorization,
backup, and recovery tests pass; and wider shared deployment only after
retention, schema migration, quota, and operational ownership are established.
No stage adds a general scheduler or a second PAC task ledger.

### Result-bearing operation seam

PAC separates workflow progress, compute-job lifecycle, and result validity.
The active host or approved workflow runtime owns control state; Slurm,
Kubernetes, or another external scheduler owns compute state; and the
project-declared artifact store owns result bytes. None can substitute for the
others, and PAC stores no fourth mutable status record.

The provider-neutral conceptual Interface is intentionally small:

```text
start(run intent) -> stable run reference
inspect(stable run reference) -> execution-and-result snapshot
cancel(stable run reference, expected revision) -> snapshot
```

This contract does not add a Core execution implementation. The first real
Adapter and its deterministic fake belong in the Project that owns the workload.
Only repeated use across at least two Projects justifies extracting a stateless,
PAC-managed Plugin. Provider-specific arrays, retries, dependencies, queues,
checkpoints, and child tasks remain behind the scheduler Seam.

For a result-bearing request, verified completion requires all of:

```text
authoritative execution terminal success
+ exact-attempt result evidence exists
+ declared result oracle passes
= verified result
```

Submission, a run reference, queued/running state, logs, partial metrics, and
successful process exit are progress evidence only. A bounded artifact-publish
grace may keep a terminal-successful run active; afterward a missing, stale,
misattributed, incomplete, malformed, non-finite, or digest-invalid result is a
result failure. An unavailable scheduler or artifact store is indeterminate,
not inferred success or failure. A negative or neutral scientific finding is a
verified result when its evidence passes the oracle.

Each semantic attempt has an immutable identity and isolated output namespace.
The project publishes its final manifest atomically after all required output is
stable. The manifest binds the run identity and specification digest to code,
configuration, data/model/randomness provenance, required metrics, artifact
references and digests, oracle version, and completion time. Exact fields and
validators stay project-owned because only the Project knows what constitutes a
valid scientific result.

Graph nodes consume this contract rather than duplicating scheduler children.
A submission-only node may complete with a stable run reference. A
result-bearing node remains active until exact-run evidence is verified; only
then may it unlock fan-in. One linear idea-to-code-to-result path remains native
and inline. Graph escalation is reserved for material fan-out/fan-in, repeated
dependency waves, or durable automatic workflow control.

### Configuration Profile layer

The Core works without a Profile. Profile authoring and Profile activation are
separate:

- `~/.config/personal-agent-control/profile-workspace.json` points to one
  editable Git workspace, normally under
  `~/.local/share/personal-agent-profile-workspaces/`. `pac profile init`
  creates or adopts it; `pac skill add|remove|update` and
  `pac plugin add|remove` change this workspace, validate it, commit it, and
  activate only that full commit.
- `pac profile publish OWNER/REPOSITORY` uses `gh` to create a private remote
  and push the validated workspace. `pac profile sync` commits, pulls with
  `--ff-only`, pushes, and activates the resulting commit. Git remains the
  authority for repository history and synchronization.
- `~/.config/personal-agent-control/profile.json` is the immutable active
  descriptor: repository locator, requested ref, and full locked commit.
  Accepted revisions are cached at
  `~/.local/share/personal-agent-profiles/<repo-hash>/<commit>`.

Normal `pac apply` consumes only the descriptor's cached commit and never
follows a moving ref or reads uncommitted workspace state. `pac profile update`
is the explicit remote-ref refresh operation; it resolves, validates, and then
atomically selects a newer commit. Workspace sync and active-Profile update are
therefore distinct operations.

A Profile is a bounded declarative package:

```text
pac-profile.json
bootstrap.md                    # optional bounded private bootstrap
context/**/*.md                 # optional progressively loaded context
skills/<name>/...               # optional embedded content-addressed Skill
packages/skills/apm.yml         # optional Profile APM graph
packages/skills/apm.lock.yaml   # required iff that graph is non-empty
catalog/plugins.tsv             # optional
catalog/capabilities.jsonl      # optional
README.md, LICENSE, LICENSE.md  # optional metadata
```

Unknown top-level content, including top-level Hooks, scripts, and Rulesync
rules, is rejected; explicitly locked Skill and Plugin payloads retain their
native capability surfaces. The Core validates the Profile schema, safe paths,
frontmatter, catalog closure, and unique identities before making it active.
Core and Profile catalogs merge append-only; a duplicate or attempted override
fails closed rather than shadowing reviewed Core behavior.
Every embedded `pac-profile.json` Skill entry includes a content digest and a
non-empty `targets` list drawn from `codex` and `claude`; projection, collision,
backup, status, and doctor logic use that same host contract. Profile APM
dependencies derive their identities and deployed roots from APM's lock and
runtime lock. Context rows must use `context:<id>` and reference a regular,
non-symlink Markdown file inside the Profile.

Repository authentication is delegated to Git/SSH credential facilities. The
Profile may record locators for secrets, private storage, and machines, but its
repository locator cannot embed credentials. Attach, update, workspace-backed
mutation, and detach participate in PAC's normal backup, reconciliation,
verification, and rollback transaction.
Detach retains immutable cached commits and recoverable transaction snapshots;
it does not promise secure deletion.

### Host adapter layer

Host configuration is not standardized enough to share a single global file.
The two v1 adapters therefore produce native targets:

| Host | Always-on target | Subagent target | Skill discovery |
|---|---|---|---|
| Codex CLI | `~/.codex/AGENTS.md` | `~/.codex/agents/independent-reviewer.toml` | filtered links under `~/.agents/skills`; native Plugin CLI |
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/agents/independent-reviewer.md` | filtered links under `~/.claude/skills`; native Plugin CLI |

Host selection has three deliberately separate layers:

1. versioned `pac.json` is the supported-host registry and cross-machine
   fallback, not one computer's mutable state;
2. `~/.config/personal-agent-control/machine.json` records the hosts enabled on
   this machine; and
3. `--hosts` narrows one operation without enabling a disabled host.

The active set for one command is therefore `enabled intersect scope`. Status
and doctor audit host-specific adapters, projections, and Plugins only for that
active set. A selected but inactive host is never activated; during a mutation
PAC may only retire state recorded as PAC-owned for that host. The
first Chezmoi apply seeds the machine activation once from `PAC_AGENTS`; later
applies never overwrite it. PAC asks Chezmoi to reconcile the exact native
instruction and reviewer files for an enabled host, records their installed
digests, and retires only a previously owned, unmodified adapter when that host
is disabled. This keeps host changes local, leaves the PAC Git checkout clean,
and preserves unrelated files for an inactive host.

Authentication, sessions, history, permissions, Plugin runtime state, logs, and
caches stay host-owned. PAC reconciles only the declared Plugin installation and
marketplace source through each host's native CLI. In particular, normal installation does not redirect `CODEX_HOME`
or `CLAUDE_CONFIG_DIR`; those broad variables are suitable for isolated tests,
not for locating one Markdown file.

### Machine dependency layer

Chezmoi downloads one checksum-pinned mise binary for the verified platform.
`mise.toml` and `mise.lock` then install exact top-level versions for the union
of actual catalog needs once under the machine's mise data directory. Binary
backends retain platform checksums and provenance in `mise.lock`; mise's npm
and pipx backends retain only their exact top-level versions. Codex and Claude
use the same Node, Rulesync, Skills CLI, uv, skills-ref, ripgrep, ShellCheck,
and Gitleaks installations. Upstream Skills do not add global runtimes
through PAC: task-specific prerequisites, including those used by PPT Master,
are handled by the upstream Skill when that route is invoked. npm and pipx
transitive closures for the control-plane tools remain owned by the mature
Aube and uv installation paths instead of a custom resolver; this backend
limit is documented rather than represented as a stronger lock.

Agent Skills do not have a standardized executable dependency schema. The
reviewed `required-tools` fields in both Skill catalogs are therefore the
authority; every token must appear in `catalog/tools.tsv`. Git, curl, and tar
form the irreducible public Core acquisition set. SSH is additionally required
when an attached Profile or selected private Plugin uses it. The installer
cannot install the tools needed to fetch and start itself, so preflight verifies
the applicable subset. Every other managed tool is pinned in `mise.toml`.

### Runtime and secret layer

The optional Configuration Profile contains secret locators, not plaintext
credentials. The public Core contains neither. At runtime
an agent retrieves a required value from the user's keychain, SSH agent,
authenticated CLI, or exact private OneDrive source. Host auth/session state is
never copied to GitHub or OneDrive by this system.

Agent task runtime, environments, task indexes, models, logs, and generated data
remain outside synchronized canonical roots, normally under a task-specific
`~/.agent-work/runtime/` directory. Rebuildable control-plane caches, including
the capability index, live under `~/.cache/personal-agent-control/` and are not
backed up.

## One-writer ownership

`catalog/owners.tsv` is the machine-readable review surface. Its important
invariant is that no two tools own the same target:

- Rulesync owns only compilation in a temporary HOME.
- Chezmoi owns global instruction files, native reviewer definitions, and the
  mise binary.
- APM owns dependency resolution, locks, and frozen package deployment for both
  the Core graph and the independently locked Profile graph. PAC coordinates
  those outputs, verifies runtime locks, and owns only the merged neutral view
  plus filtered Codex and Claude discovery links. Vercel Skills remains the one
  reviewed PPT Master exception.
- Git owns Profile commit identity and acquisition; Git plus `gh` own editable
  workspace synchronization and private publication. PAC owns the workspace
  and active-descriptor schemas, immutable cache placement, validation, and
  atomic selection. Normal apply never updates a ref or writes into a cached
  checkout.
- PAC owns the derived capability index under
  `~/.cache/personal-agent-control/`; it is atomically rebuilt from reviewed
  routing metadata, bounded installed Skill frontmatter, and Profile context
  load paths; it is intentionally not backed up and contains no context body.
- mise owns the shared tool store.
- Codex and Claude native Plugin mechanisms own registration, Hooks, MCP/App
  lifecycles, and caches. PAC owns only the merged desired Plugin overlay,
  pinned source identity, adapter invocation, and prior-ownership evidence.
  Hosts also retain auth, sessions, and unrelated settings.

Rulesync Skill generation is disabled because it would create physical copies
per host. APM 0.28.0 deploys the frozen dependency graph with `--root` and
`--target agent-skills` into `~/.local/share/agent-skills`. Its expanded runtime
lock is semantically matched to the canonical lock and supplies per-file hashes
for drift checks. Vercel Skills 1.5.22 runs only in an isolated synthetic home
for PPT Master; PAC fetches the exact reviewed commit first and verifies the
complete resulting tree. mise and all host processes keep their real home and
configuration roots.

Profile APM Skills first enter an isolated, content-addressed APM runtime after
the Profile checkout, manifest, and lock are verified. PAC adapts those
verified roots into the neutral view. Embedded Profile Skills enter through the
same bounded overlay seam after digest validation. Neither path mutates the
Core APM manifest, adds a second Rulesync compiler input, or executes
Profile-supplied installation code.

PAC then reconciles `~/.agents/skills/<name>` for selected Codex targets and
`~/.claude/skills/<name>` for selected Claude targets. Every managed entry is a
symlink to the neutral physical tree. Installing Claude first creates the store
and only Claude-compatible links; adding Codex later adds its filtered links
without downloading or copying content. The reverse order converges to the same
layout.

Every exact name in the combined catalog is reserved by this repository while
installed; there is no provenance prefix or namespace. A private ownership
manifest records physical catalog ownership so a removed or renamed Skill is
backed up and retired from the neutral store. Projection ownership is narrower:
PAC removes only a symlink whose exact target is its generated neutral-store
target. A same-named directory or different link is preserved and, when it
conflicts with an enabled target, blocks apply for inspection.

## Apply and recovery sequence

```text
resolve source-supported hosts, local machine activation, operation scope,
the immutable active Profile descriptor, and its exact cached commit
        ↓
validate Core, Profile schema/catalog/path closure, and ownership preconditions
        ↓
augment one backup with every managed adapter, bootstrap, Skill view/link,
Profile descriptor, and managed Plugin registration/cache that may change
        ↓
Chezmoi applies or retires reviewed generated adapters for active host scope
        ↓
mise installs the pinned shared control-plane dependency graph
        ↓
APM installs the frozen Core package graph into the neutral store
        ↓
PAC materializes and verifies the exact-commit PPT Master exception
        ↓
APM frozen-installs the Profile package graph into its content-addressed runtime,
if attached; PAC verifies and overlays Profile APM and embedded Skill roots
        ↓
PAC reconciles target-filtered Codex and Claude symlinks
        ↓
PAC invokes native host CLIs to reconcile pinned Plugin marketplaces and packages
        ↓
PAC atomically rebuilds the derived capability index
        ↓
doctor verifies bytes, native reviewer files, the ownership manifest,
the Core and Profile APM semantic/runtime locks and deployed hashes, the PPT
tree digest, Profile descriptor/commit/schema/integrity when attached, the
private bootstrap, both host projections,
absence of unmanaged user Skills, merged native Plugin identity,
bundled-Skill inventories, capability-index revision and integrity, external
source declarations, and the tool graph
```

PAC therefore wraps installed-state reconciliation in a single-writer
transaction. Before mutation it snapshots the exact managed HOME paths,
machine activation, active Profile descriptor, private bootstrap and ownership,
native-adapter ownership, isolated Chezmoi state, Skill ownership/projections,
and managed Plugin surfaces under
`~/.agent-work/backups/personal-agent-control/`. A failed apply restores the
pre-operation installed state and active descriptor. Explicit `pac rollback`
uses its snapshot argument or the private `last-backup` pointer, then writes a
new rollback receipt. Editable Profile history and versioned Core source are
not rewritten by runtime rollback. Managed Plugin source checkouts, native
registration files, and only the catalogued marketplace cache subtrees are restored together;
authentication, sessions, unrelated Skills, and Plugin data remain outside the
surface.
Apply, backup, doctor, and restore reject symlinks in managed path ancestors
before mutation; this prevents a discovery or store root from redirecting an
operation outside the declared HOME-relative target.

Restore also removes the exact derived capability database and its SQLite
journal, WAL, and shared-memory sidecars after the snapshot succeeds. PAC
rebuilds the cache immediately when the restored neutral runtime contains its
semantic lock. A snapshot from before any runtime existed leaves the cache
absent and reports that rebuild as intentionally skipped.

Update commands preserve these boundaries:

- `pac self-update` is the explicit fast-forward-only Core source update and
  refuses a dirty or mismatched checkout.
- `pac profile update` advances only the active Profile from its recorded
  remote ref; ordinary apply remains pinned.
- `pac profile sync` synchronizes the editable workspace and activates its
  validated commit.
- `pac skill add|remove|update` changes the Profile APM manifest/lock in the
  editable workspace, never the public Core checkout.
- `pac plugin add|remove` changes Profile enable/disable overlay state; Plugin
  packages still reconcile through each host's native mechanism.

Each update validates before selection, reconciles under one backup, runs the
same status/doctor oracle, and restores installed state on failure. A published
Git commit is durable history and is not erased by PAC rollback; correcting or
reverting that history remains a Git operation.

## Extension contract

Adding a host requires all of the following before it is called supported:

1. official instruction, Skill, subagent, precedence, and config-root semantics;
2. a generated or hand-reviewed adapter with a unique ownership surface;
3. an explicit compatibility mapping and a filtered discovery projection to the
   shared physical store;
4. isolated install, drift, positive-trigger, negative-trigger, and real-host
   behavior tests; and
5. an update to the host matrix and recovery set.

New Skills also require a distinct description contract, near-miss negative
trigger cases, and a decision whether they belong in the small global active
set or a narrower project, Configuration Profile, or Plugin scope. Trigger
evaluation must run
against the complete intended active set, not only against the Skill in
isolation.

Generator support alone is insufficient. Host-specific model, tool, permission,
or effort fields must not be converted through a lossy generic format.
