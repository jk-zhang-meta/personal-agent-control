# Personal Agent Control

A portable, versioned control plane for coding agents. PAC has three explicit
layers:

- the **public Core** contains the common policy, host adapters, public
  capabilities, provenance, and frozen dependency declarations;
- one optional **private Profile** contains personal bootstrap text,
  on-demand context, embedded or APM-managed Skills, Plugin overrides, and
  portable provider selections; and
- the **derived Runtime** materializes the selected Core revision plus, when
  configured, one exact Profile commit into host-native instructions, links,
  Plugin caches, and a metadata-only capability index.

Core and Profile remain ordinary independent Git repositories. Runtime is
rebuildable machine state, never a third source of truth. New hosts are added
through adapters instead of duplicating either source layer.

The repository deliberately composes maintained tools instead of implementing
another agent framework:

- **Rulesync 16.7.0** compiles canonical rules and subagent definitions.
- **Chezmoi 2.72.0** owns cross-machine projection, backup, and drift.
- **mise 2026.8.2** installs the shared tool dependency set once per machine.
- **Microsoft APM 0.28.0** resolves, locks, updates, and deploys the portable
  package graph into one host-neutral physical store. PAC validates deployed
  file hashes and projects each frontmatter identity to enabled hosts.
- **Vercel Skills 1.5.22** is used only to materialize PPT Master v4.3.0 from
  its exact reviewed commit. APM 0.28.0 rejects the lock it generates for that
  12,230-file package under its YAML expansion safety budget.
- **skills-ref 0.1.1** validates repository-authored Skills against the official
  Agent Skills reference implementation during repository checks; pinned
  **uv 0.12.1** supplies its portable Python tool runtime.
- **Pinned upstream sources** supply software, frontend, review,
  requirements-clarity, focused-response, and presentation Skills without
  vendoring or renaming their source trees here.
- **Agent-native Plugin managers and MCP runtimes** run host-integrated bundles
  and servers. PAC keeps their runtime semantics native while reconciling the
  reviewed cross-Agent provider configuration selected by a Profile.
- **Capability Resolver** combines the Core and optional Profile capability
  overlays with installed Skill frontmatter in a local SQLite FTS5 index after
  Skills and Plugins are reconciled. Skill and context bodies are never
  indexed; a matched private context returns the exact Markdown path in the
  locked Profile checkout. It performs automatic, nonexclusive taxonomy
  matching and returns structured match evidence for ambiguous or large
  catalogs. It is not an automatic router, package manager, scheduler, or
  execution engine.

The global adapter is not a Skill catalog. Its shared kernel contains only a
stable operating contract, main-agent orchestration and generic capability
resolution, authority boundaries, and verification and communication defaults.
It names no installed capability. Ordinary Skills route through
concise native descriptions, while thin domain routes may compose leaves that
repeated evaluation shows often apply together. Future specialist packs are
enabled at project or Profile scope instead of expanding the always-on kernel.
The Profile may declare one short `bootstrap.md`, portable providers, and
wildcard Skill targets; the Core kernel reads only its
PAC-owned projection. A Profile cannot add top-level Hooks, scripts, or Rulesync
rules, so it cannot replace the common operating contract.
Explicitly locked Skills may include helper scripts invoked as part of that
capability, and enabled native Plugins may expose reviewed Hook/MCP/App surfaces.

The same kernel defines a compact outcome-first response contract. It borrows
the safe presentation ideas from `i-have-adhd` without its hard list caps,
forced causal claims, or forced estimates. Presentation rules may never
truncate required findings, evidence, safety details, uncertainty, or an
explicit output contract. The full upstream Skill remains explicit-only.

Every runtime Skill leaf has one globally unique `skill:<name>` identifier
across standalone and Plugin-bundled inventories. Provider packages use
separate typed IDs, and strict validation rejects a duplicate leaf instead of
silently namespacing or shadowing it. MCP and App providers remain fail-closed
and absent from lookup until a reviewed runtime overlay supplies their native
handles.

Codex and Claude are the verified hosts. Core owns this supported-Agent set and
the adapter boundary; a Profile using `targets: ["*"]` and portable providers
automatically follows that set. An untested target is never advertised as
supported merely because a generator knows its filename.

## Install

Prerequisites are Git, curl, and tar. SSH or another Git credential mechanism is
needed only when the optional Configuration Profile or a selected Plugin source
is private. The command installs a pinned Chezmoi binary, clones the public Core
into an isolated source directory, applies the selected host adapters, installs
the pinned shared tools, installs declared Skills and native Plugins from their
immutable upstream identities, builds the derived capability index, and
verifies the result.

Both Codex and Claude:

```sh
PAC_AGENTS=codex,claude sh -c "$(curl -fsLS https://get.chezmoi.io)" -- \
  -b "$HOME/.local/bin" -t v2.72.0 -- \
  --source "$HOME/.local/share/personal-agent-control" \
  --config "$HOME/.config/personal-agent-control/chezmoi.toml" \
  init --apply https://github.com/jk-zhang-meta/personal-agent-control.git
```

The Core is fully functional without a Configuration Profile. To seed a private
Profile during the first install, pass its repository and optional ref and
expected commit through the environment. Credentials remain in the user's Git
or SSH credential mechanism, not in these values:

```sh
PAC_AGENTS=codex,claude \
PAC_PROFILE_REPO=git@github.com:YOUR_ACCOUNT/YOUR_PRIVATE_PROFILE.git \
PAC_PROFILE_REF=main \
PAC_PROFILE_COMMIT=REPLACE_WITH_REVIEWED_FULL_COMMIT \
sh -c "$(curl -fsLS https://get.chezmoi.io)" -- \
  -b "$HOME/.local/bin" -t v2.72.0 -- \
  --source "$HOME/.local/share/personal-agent-control" \
  --config "$HOME/.config/personal-agent-control/chezmoi.toml" \
  init --apply https://github.com/jk-zhang-meta/personal-agent-control.git
```

No private repository is required beforehand. After installing Core, PAC can
create a valid local Profile workspace and publish it as a private GitHub
repository (the second command requires an authenticated GitHub CLI):

```sh
pac profile init
pac profile publish YOUR_ACCOUNT/personal-agent-profile
```

Use `pac --json profile status` to see the workspace path. After editing it,
`pac profile sync` validates, commits, pulls with fast-forward only, pushes, and
activates the exact resulting commit. A workspace based on a tag or raw commit
requires an explicitly configured upstream branch before `sync` will commit.

Codex only: replace the first value with `PAC_AGENTS=codex`.

Claude only: replace it with `PAC_AGENTS=claude`.

The first apply records that exact selection in
`~/.config/personal-agent-control/machine.json`. The versioned `pac.json`
remains the cross-machine capability/default registry; it is not rewritten to
represent one computer. Later PAC commands use the machine activation by
default, while `--hosts` only narrows one operation.

In Claude-only mode no Codex instruction, reviewer, or discovery path is
managed. The complete catalog still has one machine-wide physical copy under
`~/.local/share/agent-skills/.agents/skills`, and PAC projects its validated
frontmatter identities only into Claude's discovery root. Installing Claude
first or Codex first yields the same physical catalog and host views.

Existing global instructions and owned catalogued Skill locations are copied
to a local recoverable backup before the first changed apply. A non-empty Codex
`AGENTS.override.md` blocks Codex installation because it would shadow the
managed global file.

Start a fresh agent session after installation. Detailed first-install,
update, verification, selective-host, and recovery commands are in
[docs/INSTALL.md](docs/INSTALL.md).

## Resulting host layout

```text
~/.codex/AGENTS.md                    # Codex adapter (Chezmoi)
~/.codex/agents/independent-reviewer.toml  # native read-only reviewer
~/.claude/CLAUDE.md                   # Claude adapter (Chezmoi)
~/.claude/agents/independent-reviewer.md   # native read-only reviewer

~/.local/share/agent-skills/.agents/skills/<name>/
                                            # one host-facing runtime copy
~/.local/share/agent-skills/apm.lock.yaml    # runtime deployment hashes
~/.config/personal-agent-control/machine.json # this machine's enabled hosts
~/.config/personal-agent-control/profile.json # optional Profile locator + lock
~/.config/personal-agent-control/profile-workspace.json
                                            # editable Profile workspace locator
~/.config/personal-agent-control/profile-bootstrap.md
                                            # managed private bootstrap, if declared
~/.config/personal-agent-control/state.boltdb # isolated Chezmoi adapter state
~/.local/share/personal-agent-profiles/<repo-hash>/<commit>/
                                            # immutable Profile checkout
~/.local/share/personal-agent-profile-workspaces/default/
                                            # default editable private Git workspace
~/.local/share/personal-agent-profile-runtimes/<profile-hash>/
                                            # frozen Profile APM runtime
~/.local/bin/pac                            # PAC management command
~/.agents/skills/<compatible-name>          # filtered Codex links
~/.claude/skills/<compatible-name>          # filtered Claude links

~/.local/share/agent-plugins/sources/<marketplace>/
                                            # one pinned Plugin source checkout
~/.codex/plugins/cache/...                  # Codex-native Plugin projection
~/.claude/plugins/cache/...                 # Claude-native Plugin projection

~/.cache/personal-agent-control/capabilities-v1.sqlite
                                            # derived local capability index

~/.local/bin/mise                     # one pinned dependency manager
~/.local/share/mise/                  # one machine-level tool store
```

Codex reads the filtered `~/.agents/skills` projection natively; Claude reads
its filtered `~/.claude/skills` projection. Both resolve to the same physical
trees, and no catalogued copies are created under `~/.codex/skills`. PAC
declares native Plugin desired state but leaves host manifests, MCP servers,
runtime data, and caches in their native locations. When the active Profile
selects both `resource-guard` and `workspace-locator`, the one deliberate
exception is a marked `PreToolUse` impact-guard fragment in each enabled host
config. Selecting neither leaves the seam inactive; selecting only one fails
closed. PAC owns only that fragment, preserves all other host fields, snapshots
it before mutation, and fails closed on removal or drift. Host-specific matchers
cover command and high-I/O surfaces without launching the hook for harmless
control/UI calls. The deployed `balanced` mode lets normal diagnosis, search,
tests, installs, project edits, local commits, and bounded network reads run;
only materially high-impact deletion, service/security/infrastructure changes,
external publication, filesystem-wide scans, or extreme parallelism require
preflight. Exact user authorization is bound to the unchanged shell command.
Claude uses its native `ask` decision so an approved tool call resumes without
command rewriting. Codex currently denies once and binds the approved retry to
the unchanged command with a digest because its native `ask` path is not an
enforceable stop. Both hosts use the same impact classifier.
The host sandbox remains the filesystem-authority boundary. Authentication,
sessions, and history are never redirected into this repository.

Codex keeps user-hook trust as a separate host-owned decision. An apply may
therefore report a structurally valid installation as staged while the exact
PAC hook hash awaits review. `pac status` and `pac doctor` stay unhealthy until
Codex reports that entry trusted; start a fresh session and run the deny canary
after accepting it. PAC never interprets staged as active protection.

Each host links to one neutral runtime copy of a standalone Skill. Immutable
Profile checkouts and package acquisition caches remain separate; Plugin caches
stay host-native where package hooks, MCP, or host manifests require them.

## Manage the installation

`pac` is the stable user entry point after bootstrap:

```sh
pac plan
pac apply
pac status
pac doctor
pac skill list
pac skill search "presentation design"
pac plugin list
pac host list
pac profile status
pac rollback
```

Ordinary capability changes belong to the private Profile workspace, not the
public Core. `pac skill add|remove|update` edits and freezes the workspace APM
graph, maintains its capability rows, validates it, creates a local Git commit,
and activates that exact commit. `pac plugin add|remove` records an
enabled/disabled override in the same workspace; `pac plugin update [NAME]`
validates the optional name and runs a full scoped reconciliation of the
currently pinned catalog. A Profile Plugin catalog may add private providers,
while its disabled list may suppress a Core provider.

Host changes update only private machine activation. Enabling a host installs
its native global instruction and reviewer; disabling it retires only PAC-owned
adapters, Skill links, and Plugin registrations. Changed applies snapshot the
managed Runtime and active locks, reconcile, verify, and restore those surfaces
on failure. Local Profile workspace commits and already-pushed remote effects
remain in Git for inspection or retry.

`pac update` and `pac self-update` are the same clean-worktree-only Core update
path: fast-forward Core, install its pinned tools and frozen dependencies, then
reconcile Runtime. They retain the active Profile's `lockedCommit`; use an
explicit Profile command to move it. A successful Core fast-forward is not
reset if a later install or apply step fails.

The complete Profile lifecycle is:

```sh
pac profile init [PATH]
pac profile set REPOSITORY [REF] [EXPECTED_COMMIT]
pac profile update [EXPECTED_COMMIT]
pac profile publish OWNER/REPOSITORY
pac profile sync [COMMIT_MESSAGE]
pac profile remove
pac profile status
```

`init` creates or registers the editable Git workspace. `publish` creates a
private GitHub repository through `gh`; `sync` commits, fast-forward-pulls,
pushes, and activates the resulting commit. `set` activates an existing local
or remote repository, `update` alone follows its recorded ref, and `remove`
retires active Profile contributions. Normal `pac apply` always reuses the
locked cached commit.

## Add Skills, Plugins, and private capabilities

PAC separates **acquisition** from **activation**:

- A Skill is a portable instruction package whose root contains `SKILL.md`.
  APM resolves it into the private Profile lock, PAC validates its identity and
  routing metadata, and enabled hosts receive links to one shared physical
  copy.
- A Plugin is a host-native bundle that may contain Skills, Hooks, MCP servers,
  Apps, or runtime code. Its source and complete bundled-Skill inventory must be
  declared in a reviewed Plugin catalog before `pac plugin add` can enable it.
- Core is for reviewed capabilities shared by every user. Personal, private,
  experimental, or machine-specific additions belong in the private Profile.

### Create the private Profile once

```sh
pac profile init
pac profile publish YOUR_ACCOUNT/personal-agent-profile
pac profile status
```

`init` creates the bounded Profile workspace and a local Git commit.
`publish` creates a **private** GitHub repository through the authenticated
`gh` account, pushes the workspace, and activates its exact commit. It never
changes Core or makes the Profile public.

After any manual Profile edit, publish the next validated revision with:

```sh
pac profile sync "Describe the private capability change"
```

PAC commits only the allowed Profile surface, fast-forward-pulls, pushes, and
activates the resulting commit. It refuses divergence and invalid content.

### Install a public or private third-party Skill

Use one APM repository reference. Prefer an immutable full commit for reviewed
production use:

```sh
pac skill add OWNER/REPOSITORY/path/to/skill#FULL_COMMIT
pac skill list
pac doctor
pac profile sync "Add third-party Skill"
```

APM also accepts ordinary Git repository locators, including authenticated
private SSH sources when the Skill is at the repository package root:

```sh
pac skill add git@github.com:YOUR_ACCOUNT/private-skill.git#main
```

PAC stages the dependency, generates a frozen Profile APM lock, verifies that
the resolved package has one valid Skill identity, commits the local Profile,
and reconciles enabled hosts. The command does not push; `pac profile sync`
does that after inspection. Git or SSH credentials stay in the normal platform
credential store and are never written into the Profile.

Inspect a candidate before keeping it: review its `SKILL.md`, referenced files,
license, resolved commit, maintenance state, and any executable tooling. A Skill
instruction cannot grant itself authority to publish, deploy, access secrets,
or perform destructive operations.

Update or remove Profile-managed APM Skills with:

```sh
pac skill update [SKILL_NAME]
pac skill remove SKILL_NAME_OR_EXACT_REFERENCE
pac profile sync "Update private Skills"
```

`update` re-resolves only the declared Profile graph. A dependency pinned to an
immutable commit remains there until its reference is deliberately changed.
Removal accepts a unique locked Skill name; use the full reference when several
references would be ambiguous.

### Write and install your own GitHub Skill

The recommended reusable path is one normal Git repository:

```text
my-agent-skills/
└── skills/
    └── my-skill/
        ├── SKILL.md
        ├── references/       # optional progressive-disclosure material
        ├── scripts/          # optional reviewed tools
        └── assets/           # optional reusable artifacts
```

The `SKILL.md` frontmatter needs a stable lowercase-hyphenated `name` and a
precise `description` explaining both when to use and when not to use it.
Validate, commit, and push the Skill repository, then install that exact commit:

```sh
skill_dir="$PWD/skills/my-skill"
"$HOME/.local/bin/mise" \
  --cd "$HOME/.local/share/personal-agent-control" \
  exec -- agentskills validate "$skill_dir"
git rev-parse HEAD
pac skill add YOUR_ACCOUNT/my-agent-skills/skills/my-skill#FULL_COMMIT
pac profile sync "Install my Skill"
```

Use the host's `skill-creator` when available to scaffold the folder, but keep
Git as the source of truth and PAC/APM as the installer. Do not copy the same
Skill independently into Codex and Claude directories.

For a private Skill that should live only inside the Profile, place it at
`skills/<name>/`, add one manifest entry containing `name`, the same path, its
complete directory SHA-256, and `targets: ["*"]` for every Core-supported Agent
(or an explicit Agent subset), then add a
matching `skill:<name>` capability row. This embedded route is deliberately
manual because its digest is a security boundary; a separate GitHub Skill repo
plus `pac skill add` is easier to update and reuse.

### Add and enable a third-party Plugin

An already reviewed provider is simple:

```sh
pac plugin list
pac plugin add PLUGIN_NAME
pac doctor
pac profile sync "Enable private Plugin"
```

`pac plugin add` never searches GitHub by name. For a new Plugin, first audit
the upstream package and add one exact provider row to the Profile's
`catalog/plugins.tsv`:

```text
# plugin  marketplace  acquisition  source  ref  resolved-commit  tree-id  version  targets  bundled-skills  license  visibility
```

The row must pin the source, immutable commit and tree, version, compatible
hosts, complete bundled-Skill names, license, and visibility. Add corresponding
`provider:plugin:<plugin>@<marketplace>` and `skill:<bundled-name>` records to
`catalog/capabilities.jsonl`. PAC rejects unknown providers, duplicate
marketplaces, duplicate Skill identities, incomplete bundled inventories, and
host-incompatible activation. Publish and activate the provider declaration
before asking `plugin add` to resolve it:

```sh
pac profile sync "Register third-party Plugin provider"
pac plugin add PLUGIN_NAME
pac profile sync "Enable third-party Plugin"
```

Do not flatten a Plugin into standalone Skills when it relies on Hooks, MCP,
Apps, a package runtime, or a host manifest. Codex and Claude native Plugin
managers remain the sole owners of those surfaces.

Update, disable, or remove effective Plugin activation with:

```sh
pac plugin update [PLUGIN_NAME]
pac plugin remove PLUGIN_NAME
pac profile sync "Update private Plugins"
```

`plugin update` reconciles the already pinned catalog. Changing source, version,
or commit requires reviewing and editing the provider row first.

### Use the same private Profile on another machine

On the authoring machine, synchronize and record the resulting commit:

```sh
pac profile sync "Synchronize private configuration"
pac --json profile status
```

On the new machine, activate that exact identity and then verify it:

```sh
pac profile set \
  git@github.com:YOUR_ACCOUNT/personal-agent-profile.git \
  main FULL_COMMIT
pac doctor
```

For a brand-new host, the same repository, ref, and commit can instead be passed
as `PAC_PROFILE_REPO`, `PAC_PROFILE_REF`, and `PAC_PROFILE_COMMIT` during the
first Core install. Normal `pac apply` never follows a moving branch; only
`pac profile update` or `pac profile sync` may select another Profile commit.

### Discover, diagnose, and recover

```sh
pac skill search "what the task needs"
pac skill list
pac plugin list
pac profile status
pac plan
pac apply
pac status
pac doctor
```

Run `plan` before a broad reconciliation and `doctor` afterward. Every changed
apply snapshots PAC-owned state beneath
`~/.agent-work/backups/personal-agent-control/`. Restore the latest validated
snapshot with `pac rollback`, or pass an exact snapshot path. Rollback restores
managed machine state; Git remains the recovery and synchronization authority
for Core and Profile source history.

## Repository map

```text
.rulesync/             canonical common always-on rules and subagent source
payload/skills/        common Skills and necessary thin routing Skills
packages/skills/       canonical APM manifest and frozen lock
catalog/               Core capability overlay, Plugin metadata, taxonomy,
                       ownership, tool provenance, and integrity digests
generated/             reviewed host projections; never hand-edit
bin/, src/, pac.json   PAC command, modular engine, shared host registry/defaults
dot_codex/, dot_claude/
                       Chezmoi target adapters
.chezmoiscripts/       thin backup and installation glue
mise.toml, mise.lock   shared pinned tool dependency graph
scripts/, tests/       compiler, doctor, checks, and isolated acceptance test
docs/                  architecture, decisions, hosts, research, and install
```

The Profile is a separate repository with a deliberately bounded surface:

```text
pac-profile.json                         # Profile manifest
bootstrap.md                             # optional short always-on private text
context/**/*.md                          # optional on-demand private context
skills/<name>/SKILL.md                   # optional embedded, digest-locked Skills
packages/skills/apm.yml                  # optional private dependency graph
packages/skills/apm.lock.yaml            # required when that graph is non-empty
catalog/plugins.tsv                      # optional private Plugin providers
catalog/capabilities.jsonl               # optional Skill/context routing metadata
README.md, LICENSE, LICENSE.md            # optional metadata
```

The manifest declares `bootstrap`, embedded Skill paths/digests/Agent targets,
Plugin `enabled`/`disabled` overlays, and portable `providers.enabled` choices.
Context rows use `context:<id>` plus a
Profile-relative Markdown `path`; the resolver indexes only their routing
metadata. Top-level Hooks, scripts, Rulesync rules, symlinks, and
unknown top-level paths are rejected; explicitly locked Skill and Plugin
payloads retain their native capability surfaces. Duplicate Skill, capability,
Plugin, marketplace, or bundled Skill identities fail closed. Profile APM dependencies must be repository
references; machine-local paths are rejected so a published Profile stays
reproducible across machines. Profile APM packages currently target both hosts;
embedded Skills provide explicit per-host targets.

The Profile locator and resolved commit are local machine state, while every
accepted revision is cached under an immutable commit path. Personal machine
and account facts belong here; public `context-mode` remains in Core.

`pac profile remove` removes active Profile contributions but retains immutable
checkouts and transaction backups for rollback; it is not a secure-erasure
operation.

The architecture and one-writer ownership contract are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Research and adoption decisions
are recorded in [docs/DECISIONS.md](docs/DECISIONS.md). The historical module
decision matrix is in [docs/SKILL-AUDIT.md](docs/SKILL-AUDIT.md), and source/license
records are summarized in [docs/SOURCES.md](docs/SOURCES.md). Reproducible
checks and real-host results are recorded in
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Development and verification

After installing the repository tools:

```sh
cd "$HOME/.local/share/personal-agent-control"
"$HOME/.local/bin/mise" install --locked --yes
"$HOME/.local/bin/mise" run check
"$HOME/.local/bin/mise" run test-install
```

To change canonical rules and refresh generated adapters:

```sh
"$HOME/.local/bin/mise" run render
"$HOME/.local/bin/mise" run check
```

Generated files, the APM manifest and lock, Core capability overlay, Plugin
declarations, and dependency locks are reviewed and committed together. Runtime
names do not encode provenance: every entry is simply a Skill. Personal rules
and private capabilities remain in the Configuration Profile; reusable
capabilities with a mature equivalent are fetched from their reviewed upstream.
No GSD lifecycle, custom graph scheduler, custom package manager, or per-agent
dependency tree is present.

The existing monolithic repository history contains private profile data and
must not be made public. A public release is created from a fresh, allowlisted
Core history only after content, secret, provenance, and license review. This
README describes the intended split; it does not assert that either GitHub
repository has already been published.
