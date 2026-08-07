# Architecture Decisions

Decision date: 2026-08-06.

## ADR-001: Compile canonical policy into native host adapters

### Context

Global instruction discovery, precedence, imports, Skills, subagents, and home
overrides differ across Codex, Claude, and future hosts. Plain Markdown text
that says “read another file” is not a deterministic include on every host.

Options considered:

1. hand-maintain a complete global file for every host;
2. write a custom cross-host compiler; or
3. keep canonical rules and compile reviewed native projections with Rulesync.

### Decision

Use Rulesync 16.7.0 only as a compiler. It runs against a temporary HOME;
generated outputs are allowlisted, reviewed, committed, and then deployed by a
separate owner. Skills are excluded from Rulesync generation, and subagent
sources use explicit host sections instead of lossy conversion.

### Consequences

The policy has one source and can gain adapters without duplicating prose.
Rulesync's direct-write, deletion, conversion, remote-install, and Skill-copy
features are outside its authority. Upgrading Rulesync requires regenerated
fixture review.

## ADR-002: Use isolated Chezmoi state for deployment

### Context

Deployment must work on Linux and macOS, preserve prior global files, support
machine templates, detect drift, and avoid replacing a user's existing dotfile
manager. The previous repository implemented these responsibilities in more
than five thousand lines of bespoke shell.

Options considered:

1. retain and extend the custom transaction installer;
2. use raw symlink and copy scripts;
3. use Home Manager/Nix; or
4. use Chezmoi with a dedicated source and config path.

### Decision

Use Chezmoi 2.72.0 through
`~/.local/share/personal-agent-control` and
`~/.config/personal-agent-control/chezmoi.toml`. This does not take over the
user's default Chezmoi repository. Keep only thin pre-change backup and
post-apply integration scripts for gaps Chezmoi does not own.

### Consequences

Deployment, templating, checksummed externals, diff, update, and drift come from
a mature tool. The system is not physically atomic across all paths, so a
private pre-change snapshot and explicit restore command remain necessary.

## ADR-003: Use one mise dependency graph per machine

### Context

Skills and control-plane tools may require npm CLIs, language runtimes, Python
tools, or GitHub release binaries. Installing a separate tree for each agent is
wasteful and makes version/security review inconsistent.

Options considered:

1. let every host or Skill install its own tools;
2. write a dependency resolver;
3. combine multiple package managers directly; or
4. use one mise graph and its built-in backends.

### Decision

Use mise 2026.8.2 with exact top-level versions and a two-platform asset lock
where the selected backend supports one. The initial union contains only tools
used by the repository and enabled Skills. Aqua-backed tools receive checksum
and provenance verification. npm and pipx backends are version-only in mise's
upstream lock format; reviewed top-level npm registry integrities and the
skills-ref wheel hash are retained in `catalog/tools.tsv` as provenance
evidence. The locked uv node is installed before pipx-backed tools because
mise's pipx backend consumes, but does not bootstrap, uv on a clean machine.

### Consequences

Each tool has one versioned machine installation shared by every agent. mise is
larger than a narrow binary downloader, but avoids separate Node, Python, Aqua,
and ad-hoc GitHub installers as the catalog grows. npm and Python transitive
closures are resolved by mise's mature Aube and uv paths at installation time;
they are not falsely described as repository-frozen. This is an explicit
residual trade-off that avoids introducing a second package manager or custom
resolver. New dependencies require a catalog row, applicable lock update,
provenance review, and both-platform test.

## ADR-004: Materialize once in neutral storage and project filtered host views

The neutral-store and host-projection decision remains active. Its original
Vercel-only acquisition mechanism and three-file catalogs were superseded by
ADR-012's APM graph, single PPT exception, and capability overlay.

### Context

Codex natively discovers `~/.agents/skills`; Claude expects
`~/.claude/skills`. Treating the Codex discovery directory as the physical
catalog leaks every installed Skill to Codex and cannot represent Claude-only
capabilities. A copy per host violates the deduplication requirement.

Options considered:

1. copy each Skill per host;
2. keep the physical catalog in Codex's discovery directory and link Claude;
3. build a custom Skill downloader and compatibility manager; or
4. use Vercel Skills in a synthetic host-neutral HOME, then reconcile filtered
   host links from a separate compatibility catalog.

### Decision

Use a host-neutral physical store at
`~/.local/share/agent-skills/.agents/skills`. PAC, rather than a package engine,
owns the symlinks under `~/.agents/skills` and `~/.claude/skills`. ADR-012 now
defines acquisition through APM plus the PPT exception; frontmatter identity
and `catalog/capabilities.jsonl` define the supported host views.

### Consequences

There is one physical catalog independent of either host, plus two filtered
discovery views. Runtime names do not expose provenance. A host-exclusive Skill
can exist once without being visible to the other host; adding a host or
changing targets need not download content again. Personal rules and necessary
thin routes stay in this repository. Upstream source trees stay out of the
payload and are reacquired from reviewed tags or immutable commits.

The installer must independently verify source declarations, resolved commits,
names, installed content, target coverage, link identity, and absence of legacy
Codex duplicates. A PAC-owned applied-state file pairs the external catalog
identity with a deterministic digest of each installed tree; this supplements
rather than replaces the Vercel materializer lock. A private prior-ownership
manifest closes the CLI's removal gap: catalog-retired names are backed up and
retired from the physical store, while host projections are removed only when
their exact link identity proves PAC ownership. Same-named unrelated Skills
remain untouched. The synthetic
`.agents/skills` nesting is an implementation detail imposed by the upstream
materializer and must not become a host discovery path.

## ADR-005: Keep common-safe and private profile zones in one private v1 repo

Superseded by ADR-016. This record is retained to explain the earlier
monolithic history; it is not the current distribution architecture.

### Context

The system needs portable methods and personal machine/storage knowledge. A
public repository must never receive private locators or secrets, while two
repositories introduce acquisition, revision pairing, and partial-update
complexity before public distribution is needed.

Options considered:

1. one flat private repository;
2. public core plus private overlay immediately; or
3. one private repository with explicit common/private catalog boundaries.

### Decision

Use option 3. `catalog/capabilities.jsonl` labels visibility; private machine
facts stay under `personal-environment`; plaintext credentials remain outside
Git.

### Consequences

Installation is atomic at one repository revision and easy across personal
machines. A future public core is produced by an allowlisted export, never by
changing the repository visibility or relying on `.gitignore` to hide private
history.

## ADR-006: Use native-first task graphs with an optional durable Adapter

### Context

Substantial work benefits from dependency graphs, parallel agents, evaluator
passes, resume, and explicit state. Codex and Claude already expose planning,
task, delegation, and recovery primitives for ordinary interactive work. Some
application-level research workflows additionally must survive host or process
restarts, share authoritative state across people or machines, wait for
out-of-session callbacks or approval, run on a schedule, or preserve
checkpoint/replay semantics. Those are runtime requirements, not evidence that
PAC itself should become a runtime.

Options considered:

1. send every task through one durable graph runtime;
2. let the model choose a runtime without a deterministic policy;
3. require users to select a runtime for every task; or
4. keep native execution as the default and add a provider-neutral Seam for an
   approved durable Adapter when hard requirements demand it.

### Decision

Use option 4. PAC remains a configuration control plane: it may install,
configure, project, and verify an extension, but it neither executes tasks nor
owns their run state. `graph-workflow` is the sole coordinator for graph-worthy
work and bypasses ordinary serial work. Its execution-surface Seam has a native
host Adapter and may gain an optional LangGraph durable Adapter for
application-level durable research graphs. OpenAI Symphony remains a separate
future candidate only for tracker-driven coding automation.

Selection is hybrid. The host model may extract task facts, while a
deterministic policy chooses the Adapter and reports its reason. Native is the
default. Durable execution is selected automatically only for restart survival,
shared cross-person or cross-machine state, an external wait or callback beyond
the session, scheduled execution, or required checkpoint/replay. Complexity,
step count, agent count, and estimated duration are insufficient by themselves.
Users may explicitly request durable execution or native execution, but native
cannot silently satisfy a contradictory durability guarantee.

The selected host or durable runtime is the single authority for graph and run
state. The project root owns graph definitions, schemas, protocols, and oracles;
artifact stores own large scientific outputs; external schedulers own compute
jobs. PAC stores no shadow task ledger. A required durable Adapter that is
unavailable or unauthenticated fails closed rather than falling back. Provider
submission, node return, or worker success is only a claim; declared artifacts
and completion oracles must still pass. The supporting runtime semantics and
alternatives are recorded in the
[official design references](SOURCES.md#optional-durable-runtime-design-references).

### Consequences

Ordinary callers continue to state a task once and use the active host without
runtime ceremony. Durable work returns an opaque run reference that can be
inspected or signalled later without exposing provider-specific identifiers.
The workflow remains portable and avoids rebuilding a scheduler, database,
daemon, or recursive agent framework inside PAC.

Multi-person research uses one authenticated shared durable deployment per
project or trust domain and thin per-user host Adapters, not one server per
user. Checkpoints contain control state and immutable artifact references, not
datasets, models, logs, or other large scientific artifacts. Side effects and
external compute submissions must be idempotent because recovery may re-execute
work.

Rollout is gated: first shadow the policy without submission, then pilot one
explicit durable research graph, then enable hard-rule automatic routing only
after restart, duplicate-effect, authorization, backup, and recovery checks
pass. Wider adoption additionally requires retention, schema-migration, quota,
and operational ownership contracts.

## ADR-007: Install reusable Skills from pinned upstream identities

### Context

The repository uses mature upstream Skills for software structure, review,
debugging, simplicity, frontend work, test-driven development, and presentation production. Copying their source
trees into PAC would enlarge the repository, blur upstream ownership, and make
updates a manual vendoring exercise. Installing the same Skill separately for
each host would violate the single-copy requirement.

Options considered:

1. vendor upstream Skill trees in `payload/skills`;
2. install each dependency separately for Codex and Claude;
3. maintain thin local rewrites under renamed local Skills; or
4. declare immutable public upstream identities and materialize them once at install
   time.

### Decision

Use option 4. The catalog pins Matt Pocock's engineering Skills at `v1.2.2`,
Ponytail at `v4.8.4`, and PPT Master at `v4.3.0`. Anthropic `frontend-design`
and the two selected Vercel React Skills have no suitable release tag, so their
GitHub commit archive and deterministic installed-tree digest are both fixed in
the catalog. The installer fetches each shared source once and Vercel Skills
materializes one physical copy of every selected Skill in the neutral store.

After installation, PAC records the exact catalog identity and a local content
digest for all ten upstream directories. Doctor recomputes those digests, so damaged
or restored-to-old content cannot pass solely because the shared CLI lock still
contains current metadata.

### Consequences

Codex and Claude receive the reviewed upstream workflows without per-agent
copies, while PAC contains only source declarations and installation logic.
Installation requires network access to those public repositories. A release
upgrade changes the catalog tag and resolved commit and must pass normal review
and acceptance checks. PAC does not preinstall a PPT Python environment,
Chromium, wrapper, or other task-specific runtime; the selected upstream Skill
handles its prerequisites on demand.

## ADR-008: Keep the global kernel capability-agnostic

This decision is extended by ADR-011 and ADR-013. Native descriptions remain
the default and the kernel remains capability-agnostic; ADR-011 adds an
on-demand catalog lookup, while ADR-013 adds one generic session-intake section
without naming its optional implementation Skill.

### Context

Every Skill repeated in the global instruction file consumes always-on context
twice: once in that file and once in the host's native Skill catalog. It also
turns the global file into a second registry that drifts as capabilities are
added, renamed, disabled, or moved between profiles. However, relying on model
routing alone is not a deterministic safety boundary, and some domain leaves
still need coordinated composition.

Options considered:

1. list every Skill and composition rule in the global file;
2. name a small permanent set of mandatory Skill gates in the global file;
3. build a custom semantic router over the complete library; or
4. keep one capability-agnostic global protocol, use native descriptions for
   selection, add thin domain composition only after measured failures, and
   enforce zero-miss behavior through stable semantics plus native controls.

### Decision

Use option 4. The kernel names no installed Skill, Plugin, domain, model, or
host API. It tells the main agent to inspect the capabilities exposed by the
current host, select the smallest non-conflicting applicable composition, load
the selected instructions fully, honor explicit user invocation, work directly
when no capability applies, and report a missing required capability.

Stable authority, secret, destructive-action, state-preservation, and
completion semantics remain always-on because losing them would change the
user's cross-project contract. Detailed procedures remain progressively loaded,
and deterministic blocks belong to Hooks, permissions, configuration, CI, or
other native enforcement rather than a Skill name in prose.

Keep the globally visible capability set curated. Future low-frequency or
specialized packs belong at project, role, or phase scope through host-native
profiles, plugins, or selective installation. Packaging and namespacing solve
distribution and name collisions but do not by themselves remove metadata
cost. An automatic routing runtime remains rejected while native scope and
progressive disclosure are sufficient. ADR-011 permits only a read-only,
on-demand resolver for catalog ambiguity and inventory discovery.

### Consequences

Adding, removing, renaming, or regrouping a capability no longer edits the
kernel or generated host instructions. Review keeps active Skill identities out
of the global source without coupling ordinary prose to future common-word
names. The repository check treats the kernel's five headings plus its
120-line/900-word ceiling as a reviewed ABI. Those ceilings
are maintenance budgets, not empirical claims that one more line causes
failure.

As the library grows, active-set selection is the required scaling mechanism.
New descriptions need positive and hard near-miss negative trigger evaluation
in the complete intended catalog; repeated composition failures, not catalog
size alone, justify another domain router. A change to a universal invariant
requires explicit review of this ADR and cross-host regression evidence.

## ADR-009: Use an adaptive response contract, not a universal template

### Context

Agent results must be fast for a person to review, but answers range from one
sentence to long research reports, code changes, audits, and machine-consumed
data. No structure at all can hide outcomes and failures; one mandatory set of
headings creates empty sections, repetitive prose, and poor fit.

Options considered:

1. leave response structure entirely to each model;
2. require one global `Summary / Details / Next Steps` template;
3. create a response-format Skill for every task; or
4. keep a small adaptive contract globally and place specialized schemas at
   the Skill, agent, or invocation boundary.

### Decision

Use option 4. Human-facing responses lead with the answer, decision, or
completed outcome and progressively add only relevant evidence, verification,
material caveats, unverified items, and a real next action. Prose, lists,
tables, citations, and headings are selected by information shape rather than
decoration. Simple answers need no headings. Programmatic consumers receive
the requested schema without surrounding prose.

### Consequences

Every host gains a predictable review order without forcing verbose
boilerplate. Research, review, deployment, and other specialist workflows can
still impose their own stronger formats. Long artifacts stay durable while
chat carries a short result and path. The model must still exercise judgment
about which blocks matter, so representative response-quality evaluation
remains more useful than adding more global formatting rules.

## ADR-010: Manage native Plugins as pinned bundles, not flattened Skills

### Context

Some upstream packages expose Skills together with hooks, MCP servers,
package-level runtimes, or host manifests. Copying only their `skills/`
directories can silently break those dependencies. Installing the source once
per host instead creates duplicate acquisition state and lets versions drift.

Options considered:

1. flatten every package into the neutral standalone Skill store;
2. install each Plugin independently through each host from its remote source;
3. build a PAC Plugin runtime and translate upstream packages; or
4. pin one shared source checkout and delegate projection to each host's native
   Plugin manager.

### Decision

Use option 4 only when Plugin packaging is functionally necessary. The Core and
optional Configuration Profile `catalog/plugins.tsv` files record immutable
source, commit, Git tree, version, targets, license, visibility, and bundled
Skills. PAC validates an append-only merge, then maintains one source
checkout per marketplace, then invokes the Codex or Claude native Plugin CLI.
PAC verifies the resulting native identity but never rewrites hooks, MCP,
runtimes, or host manifests.

PAC is the sole owner of each declared marketplace identity. Companion session
launchers may use the resulting Plugin but may not provision another marketplace
with the same name: native managers bind identity to the source path, so two
otherwise byte-identical installations still conflict.

Use the standalone Skill path when the Plugin wrapper adds no capability.
Accordingly, public `context-mode` remains a Core Plugin and private
`automated-rebuttal-workflow` remains a Configuration Profile Plugin, while the
byte-identical, self-contained Draw.io Skill is materialized once in the neutral
store and its old Plugin registration is retired through a recorded migration.

### Consequences

Acquisition and version intent are centralized without pretending host caches
are portable source. Native caches may exist once per host because their
lifecycle integration is host-specific. Backup captures exact managed
registrations, cache subtrees, shared sources, and ownership state before a
change; restore does not touch Plugin data, authentication, sessions, system
Skills, or unrelated marketplaces. A manually installed Plugin or standalone
user Skill is preserved but blocks doctor as `UNMANAGED` until reviewed and
catalogued or explicitly removed.

## ADR-011: Add an advisory local capability catalog and resolver

### Context

Native Skill descriptions are effective for a small curated set, but a growing
personal catalog introduces three distinct lookup problems: a task can span
several domains, a package-level Plugin can hide the relationship between its
provider and bundled Skills, and users may ask for an inventory rather than a
task route. Putting every name or category in the global kernel would recreate
the drift and context cost rejected by ADR-008.

Options considered:

1. rely only on each host's flat native capability list;
2. place every capability in one strict directory tree and search only the
   selected branch;
3. build a local hybrid index over reviewed taxonomy, catalog/routing metadata,
   and installed Skill discovery metadata, invoked only when needed; or
4. introduce a remote vector service or an Agent-OS-style routing and execution
   control plane.

### Decision

Use option 3. `catalog/taxonomy.json` defines a reviewable category tree and
`catalog/capabilities.jsonl` carries nonexclusive many-to-many
memberships, aliases, positive and negative triggers, visibility, and
activation contracts. Existing Skill, Plugin, and agent inventories remain
authoritative for provenance, provider/child relations, and installation.
Machine dependencies in `catalog/tools.tsv` are deliberately not indexed as
task capabilities.

Index input is bounded discovery metadata only: reviewed catalog and routing
rows, taxonomy labels, and each installed Skill's frontmatter name and
description. Full Skill bodies, Plugin runtime state, conversations, and
credentials never enter the database. Task text may automatically infer
several matching taxonomy categories; no category is an exclusive route.

After standalone Skills and native Plugins are reconciled, the installer uses
the pinned Node runtime to atomically rebuild
`~/.cache/personal-agent-control/capabilities-v1.sqlite`. The index combines
exact-name and alias lookup, category expansion, SQLite word FTS, and substring
fallback. Read-time host, kind, and visibility filters run before stable rank
fusion. Search returns a bounded result with its index revision and structured
evidence identifying the match channel, request fragment, metadata field and
value, and optional category path; it never accepts raw SQL or raw FTS
expressions from the model.

The capability record is shared, but activation remains typed. Skills point to
their exact instruction resource, subagents to native delegation, and Plugins
to native package activation plus their bundled Skill children. Future MCP and
App providers fail closed and remain absent from v1 lookup until a reviewed
runtime overlay defines their host-native handles. Every standalone or
Plugin-bundled Skill leaf uses the globally unique v1 identifier
`skill:<name>`; strict compilation rejects collisions instead of hiding them
behind provider namespaces.

The resolver is itself an ordinary on-demand Skill. Native descriptions stay
the default when a match is clear. The global kernel does not name the resolver
or any other installed capability.

### Consequences

Catalog growth no longer requires a larger global file, and a single query can
recover relevant leaves across several tree branches while explaining why they
matched. Plugin provenance remains visible without flattening bundled Skills.
The generated database is local, replaceable, excluded from backup, and checked
by doctor against the reviewed source revision. Restore removes the database
and its SQLite sidecars only after a successful snapshot restore, then requires
the normal PAC apply to rebuild it from the selected canonical revision before
resolver use or fresh sessions.

PAC now owns taxonomy quality, routing metadata, index compatibility, and
lookup regression tests. The pinned Node SQLite API is isolated behind the
index module and feature-probed because its upstream API is not yet fully
stable. This design adds no daemon, vector database, remote service, custom
package manager, scheduler, automatic router, security boundary, installer, or
execution engine. A later warm/cold catalog tier requires measured native
metadata pressure rather than speculative scale.

## ADR-012: Use Microsoft APM as the portable capability package engine

### Context

PAC previously implemented source discovery, Git pin validation, content
digests, installation, retirement, ownership, and host projection around a
second Skill installer. That duplicated package-manager responsibilities and
made an ordinary Skill addition touch several parallel inventories. Microsoft
APM 0.28.0 now provides a manifest, resolved lock, per-file hashes and owners,
frozen replay, dependency update and uninstall operations, and explicit Codex,
Claude, and Agent Skills targets.

The following alternatives were tested:

1. keep the custom materializer and use APM only as another downloader;
2. let APM global mode write every host directory directly;
3. deploy standalone Skills once through APM's documented `--root` and
   `agent-skills` target, then keep only thin host compatibility links; or
4. flatten native Plugins into ordinary APM primitives.

### Decision

Use option 3 for standalone portable Skills in both source layers. The Core APM
manifest and lock live under Core `packages/skills/`; an optional Profile has an
independent `packages/skills/` manifest and lock. APM deploys the Core graph to
the neutral runtime and the Profile graph to a content-addressed runtime keyed
by Profile repository and commit. PAC verifies both runtime locks, adapts their
installed roots into one neutral view, and exposes target-filtered native host
links. Package acquisition, revision resolution, graph locking, and per-file
deployment ownership come from APM. PAC retains only overlay validation,
visibility, routing, taxonomy, transaction, and host-adapter metadata that APM
does not model.

Use exact APM version 0.28.0 through mise. Every apply is staged, locked,
backed up, replayed without `--force`, verified, and rolled back on failure.
PAC independently validates APM's lock hashes because APM 0.28.0 does not offer
an audit command that correctly targets an arbitrary `--root` deployment.

One reviewed materializer exception remains. PPT Master v4.3.0 contains 12,230
files, mostly native presentation templates. In an isolated install APM wrote a
7.1 MB, 134,890-line lock and then rejected its own output under the safe YAML
alias/expansion budget. PAC must not relax that security limit or discard the
templates. Until APM can represent this package safely, the pinned Vercel
Skills 1.5.22 CLI materializes only `ppt-master` into the same neutral store;
PAC verifies its immutable source identity and full content digest and still
owns plan, backup, projection, removal, and doctor. No other Skill uses this
exception.

Keep native Plugins outside APM. Disposable tests showed that APM can unpack a
Claude-style Plugin into portable primitives but does not register the package
with Codex or Claude and does not reproduce native Plugin cache, Hook, MCP,
App, or runtime semantics. Public `context-mode` therefore continues through
the two native host adapters from one PAC-pinned source checkout. A private
Configuration Profile may append a Plugin such as
`automated-rebuttal-workflow` through the same validated native seam.

### Consequences

There is one versioned Core graph and, when configured, one independently
locked Profile graph, one merged neutral Skill view, one explicitly labelled
large-package exception, and one stable capability tree. Personal
`add|remove|update` operations change only the editable Profile graph and its
capability leaves; they never mutate an installed public Core checkout. APM
remains replaceable behind PAC's command/process seam, but PAC does not invent a
generic package solver.

The thin projection layer remains necessary for host compatibility and for
preserving unmanaged user entries. It may contain links for both hosts, but it
does not reacquire or copy upstream packages. Native Plugin caches may still be
host-specific because that duplication belongs to the host runtime contract.

## ADR-013: Use a proportional requirement-intake gate

### Context

Beginning implementation from a vague request can waste substantial work, but
forcing every clear edit through a full interview or PRD lifecycle creates the
same waste in another form. Codex and Claude already provide native planning
and user-question facilities. Mature specification systems such as GitHub Spec
Kit and Kiro make clarification an explicit quality gate for material
ambiguity, while full brainstorming frameworks add their own document, commit,
and implementation lifecycles.

Options considered:

1. always ask the user to confirm every request before any work;
2. install a mandatory brainstorming/specification lifecycle globally;
3. use a small always-on clarity gate, native host questions for ordinary
   ambiguity, and a separately routed formal-requirements Skill; or
4. rely entirely on model discretion with no stable intake contract.

### Decision

Use option 3. Every new or materially changed request is checked for goal,
scope, exact target, observable completion condition, material constraints, and
external-effect authority. The user's clear explicit request already counts as
confirmation. Read-only discovery resolves known or discoverable facts first;
the agent does not ask the user to repeat them or request ceremonial approval.

If a missing answer can materially change user-visible behavior, architecture,
public contracts, persistent data, the exact target, the success oracle, or an
irreversible/external effect, mutation pauses and the agent asks the smallest
decision-ready question. Questions are one at a time, bounded to five for one
intake, explain the consequence, and offer mutually exclusive choices plus a
recommended default when useful.

Install `softaworks/agent-toolkit`'s MIT-licensed
`requirements-clarity` Skill at immutable commit
`3027f20f3181758385a1bb8c022d4041dfb4de84`, but route it only for an explicit
PRD/specification request or genuinely complex and vague feature work. Its
90-point score is a heuristic, not a proof, and its document write remains
subject to normal write authority. GitHub Spec Kit, Kiro Specs, and
Superpowers remain optional project/full-lifecycle choices rather than global
interceptors.

### Consequences

Clear work remains one-pass and does not wait for a redundant answer. Material
ambiguity is surfaced before expensive mutation, and the resulting answer
becomes the scoped execution contract rather than broad authority. Formal PRD
elicitation is available across Codex and Claude without making every session
pay its interaction and document cost.

## ADR-014: Adopt an adaptive, evidence-preserving response shape

### Context

Agent answers can be technically correct yet difficult to review because the
result is buried under preamble, long unranked lists, repeated recap, or an
empty closing invitation. The MIT-licensed `ayghri/i-have-adhd` project is a
widely adopted cross-host response-shaping Skill with a concrete ten-rule
contract and an emerging paired evaluation harness. Its own issues also expose
failure modes when compression rules are interpreted literally.

Options considered:

1. install its native Plugin and force every response through the complete
   ruleset;
2. copy all ten rules into the always-on kernel;
3. adopt the stable response-shape principles globally, preserve task and
   evidence precedence, and install the upstream Skill as an explicit optional
   mode; or
4. leave response structure entirely unspecified.

### Decision

Use option 3. The global kernel requires the first line to contain the answer,
completed result, current decision, or blocking fact; sequences that the user
must perform are numbered; tangents, ceremonial preamble, redundant recap, and
empty closers are removed; verified progress and completed work stay visible;
and long lists are ranked or split into meaningful groups.

These are presentation rules only. They may never suppress required findings,
evidence, uncertainty, warnings, exact machine schemas, requested explanation,
or task-specific output contracts. Errors are stated matter-of-factly, but an
unknown cause remains unknown and is paired with the next discriminating check
rather than a plausible invention. Time estimates are included only when an
evidence-based estimate is useful. A next action appears only when a real one
exists.

Install the upstream `i-have-adhd` Skill from immutable commit
`2d19ad205eb1d85fc9c3968bdeba4c2116518685` through APM as an explicit-only
style. Do not install its native always-on Hook: that mechanism is currently
Claude-specific and would make host behavior diverge. The portable Skill lets
the user deliberately enable the stronger original mode in either host.

### Consequences

Normal responses become easier to scan without imposing a brittle universal
template. The upstream project's reported 14-case, three-trial evaluation
improved weighted quality from 4.045 to 4.473, but did not pass its own release
gate; open findings show a literal five-item cap can omit relevant content and
an unconditional demand for cause/fix can manufacture certainty. PAC therefore
uses the measured benefits and explicitly guards those regressions rather than
equating popularity with universal correctness.

## ADR-015: Separate supported hosts, machine activation, and operation scope

### Context

Codex and Claude are both supported by one repository, but a particular
machine may intentionally install only one. Storing that choice in versioned
`pac.json` dirties the checkout, creates cross-machine conflicts, and prevents
safe fast-forward self-update. Treating `--hosts` as both activation and scope
has the opposite problem: a diagnostic command can accidentally enable a host,
and every future command must repeat ephemeral state.

Options considered:

1. rewrite versioned `pac.json` for every machine;
2. require `--hosts` on every command and keep no local selection;
3. keep a source-supported registry, a private per-machine enabled set, and a
   separate per-operation scope; or
4. enable every supported host on every machine.

### Decision

Use option 3. `pac.json` declares supported adapters and shared defaults.
`~/.config/personal-agent-control/machine.json` stores the ordered enabled-host
set using schema version 1. `--hosts` can only narrow the current command. PAC
computes `active = enabled intersect scope` for host exposure, doctor, and
status. Mutation scope remains distinct so a disable operation can retire only
the selected host's prior PAC-owned adapter, projection, and Plugin state
without treating that host as active.

The initial Chezmoi selection seeds the local machine activation only when it
is absent. Host install, enable, and disable mutate the machine activation
transactionally and never rewrite `pac.json`. Backups and rollback include the
machine activation and native
adapter ownership. An inactive host retains unrelated native state while PAC
retires only its own verified projections and registrations.

### Consequences

The same clean Git revision can represent Codex-only macOS and Codex-plus-Claude
Linux installations, so self-update remains fast-forwardable. Commands expose
supported, enabled, selected, and active states explicitly instead of relying
on an ambiguous Boolean. The cost is one small local state file, a migration
fallback to source defaults when it is absent, and additional backup and
validation coverage for local host transitions.

## ADR-016: Separate public Core from an optional locked Configuration Profile

Decision date: 2026-08-07. Supersedes ADR-005.

### Context

The common workflow, host adapters, public Skills, and public Plugins should be
reusable by other users. Personal machine/storage locators and a private
academic rebuttal Plugin must remain private. The existing monolithic Git
history contains both classes of data, so changing that repository's visibility
would expose historical content even if current files were removed.

The Profile must also be reproducible. A normal apply must not silently follow
a branch, execute repository-supplied setup code, overwrite a Core capability,
or make Rulesync reconcile private policy. A Profile Skill graph may exist, but
it must have its own APM manifest, lock, and derived runtime rather than mutate
the Core graph.

Options considered:

1. keep the monolith private forever;
2. publish the current repository after deleting private files;
3. load arbitrary private Markdown, scripts, and rules dynamically; or
4. publish a fresh allowlisted Core and attach one bounded, commit-locked
   Configuration Profile through PAC.

### Decision

Use option 4. The Core is complete and operable without a Profile. A user may
attach one repository with
`pac profile set|attach REPOSITORY [REF] [EXPECTED_COMMIT]`; installation may
seed the same state with `PAC_PROFILE_REPO`, `PAC_PROFILE_REF`, and
`PAC_PROFILE_COMMIT`. The local locator and lock live at
`~/.config/personal-agent-control/profile.json`. Each accepted source revision
is cached at
`~/.local/share/personal-agent-profiles/<repo-hash>/<commit>`.

Normal `pac apply` consumes only the cached locked commit and never resolves a
moving ref. `pac profile update` is the explicit operation that resolves,
validates, and locks a newer commit. `status` reports the selected and cached
identity; `remove|detach` transactionally removes the Profile contribution.

The Profile schema is deliberately data-only:

```text
pac-profile.json
bootstrap.md                    # optional bounded private bootstrap
context/**/*.md                 # optional private context modules
skills/**                       # optional embedded content-addressed Skills
packages/skills/apm.yml         # optional private dependency graph
packages/skills/apm.lock.yaml   # required iff dependencies exist
catalog/plugins.tsv             # optional
catalog/capabilities.jsonl      # optional
README.md, LICENSE, LICENSE.md  # optional metadata
```

Hooks, scripts, Rulesync rules, unknown top-level content, unsafe paths, and
credentials embedded in repository locators are rejected. Core and Profile
identifiers merge append-only; any duplicate Skill, capability, Plugin, or
bundled-Skill identity fails closed. Personal secrets remain locators resolved
through the user's normal credential sources. Context capabilities carry only
routing metadata and an exact in-Profile Markdown path into the derived index;
their bodies are loaded on demand and never indexed.
Each declared Skill carries a non-empty `targets` list containing `codex`,
`claude`, or both, and all native projection and verification paths honor it.

Rulesync continues to compile only the reviewed Core policy. The kernel exposes
one fixed conditional include for a PAC-owned, digest-checked private bootstrap;
the Profile cannot supply Rulesync rules. APM owns the Core and Profile package
graphs and their locks. PAC validates and overlays their outputs but does not
resolve dependencies itself. Native Plugin managers retain their runtime role
after the merged declarations pass validation.

The existing monolithic history is never made public. The public release is a
fresh, allowlisted Core history created only after content, secret, provenance,
and license audit. The private Profile repository is acquired through normal
Git/SSH credential facilities, without credentials in its locator or PAC logs.

### Consequences

The public Core can be installed and tested anonymously, while one private
Profile supplies the user's environment on authorized machines. Every apply is
reproducible from an explicit Core revision and optional Profile commit, and a
branch update cannot change an ordinary apply unexpectedly. The small Profile
schema gives PAC a closed validation, ownership, backup, and rollback surface.

The split introduces a second source revision and local cache. Attach/update
must therefore validate repository identity, commit resolution, schema,
catalog closure, safe paths, integrity, and identity collisions before changing
installed state. Detach must retire only Profile-owned objects. Publication
also requires a fresh-history migration rather than a visibility toggle. These
costs are accepted to keep the common control plane reusable without weakening
privacy or reproducibility.

Detach is reversible, not erasing: immutable checkouts and backups remain until
an explicit future purge operation or separately authorized removal. Commit
authenticity in v1 relies on the authenticated Git transport plus an optional
caller-supplied expected commit; PAC does not yet verify Git signatures.

## ADR-017: Separate Profile authoring, immutable activation, and derived Runtime

Decision date: 2026-08-07. Refines ADR-012 and ADR-016 and supersedes any
earlier description of PAC mutating Core Skill or Plugin desired state.

### Context

A personal control plane needs convenient `skill add`, Plugin preference, and
Profile synchronization commands without making an installed public Core
checkout a mutable personal database. It must also distinguish uncommitted
authoring state from the exact revision that machines reproduce. Reimplementing
package resolution, Git synchronization, or host Plugin runtimes inside PAC
would duplicate mature tools and create overlapping owners.

Options considered:

1. mutate the Core APM manifest, lock, or Plugin config in place;
2. activate an editable Profile working tree directly;
3. build custom PAC package, VCS, and Plugin engines; or
4. keep an editable Git Profile workspace, select only validated immutable
   commits, and delegate each lifecycle to its native owner.

### Decision

Use option 4. The state model has three layers:

1. public Core source, changed only through reviewed source development or the
   explicit fast-forward `pac self-update` path;
2. private Profile source, split into an editable Git workspace and an active
   descriptor naming repository, ref, and full locked commit; and
3. Derived Runtime, including APM deployments, the merged neutral Skill view,
   host links, native Plugin state, the private bootstrap, ownership records,
   and the disposable capability index.

`pac skill add|remove|update` changes the Profile APM manifest/lock in the
editable workspace. `pac plugin add|remove` changes the Profile enable/disable
overlay. PAC validates and commits the workspace before activating that commit.
`pac profile publish` delegates private repository creation/push to `gh`, while
`pac profile sync` delegates pull/push to Git. `pac profile update` is a
different operation: it advances the immutable active descriptor from its
recorded remote ref. Ordinary apply follows neither remote refs nor uncommitted
workspace state.

Rulesync compiles only public common workflow. APM owns both Skill dependency
graphs and locks. Git/`gh` own repository identity, history, synchronization,
and publication. Codex and Claude native Plugin mechanisms own Plugin package
registration and runtime semantics. PAC custom code is limited to closed
overlay validation, advisory routing, transaction/rollback, ownership evidence,
and host adaptation.

### Consequences

Personal mutations no longer dirty the Core, and an incomplete workspace edit
cannot affect another machine. Two descriptors and two APM runtimes add state,
but each has a single purpose and immutable identity. Profile publication is an
external GitHub effect and remains explicit; local commits created by a
workspace mutation are durable Git history, while PAC rollback restores the
pre-operation installed state and active descriptor rather than rewriting that
history.

Verification must prove both positive convergence and negative ownership:
ordinary apply stays pinned, workspace changes require validation and a commit,
Core/Profile package locks match their deployed runtimes, context bodies remain
outside SQLite, host links and Plugins match their native targets, and a late
failure restores every PAC-owned installed surface without touching unmanaged
or canonical source state.
