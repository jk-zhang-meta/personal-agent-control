# Installation, Update, Verification, and Recovery

## Preconditions

- Linux x86-64 or macOS Apple Silicon. The exact acceptance evidence and any
  unexecuted live-host combinations are recorded in
  [VERIFICATION.md](VERIFICATION.md), not inferred from platform support.
- Git, curl, and tar available from the shell. SSH is required only for a
  private Configuration Profile or private Plugin source that uses SSH.
- Access to every private source selected by the optional Configuration Profile
  through the user's normal Git/SSH credential mechanism.
- An installed and authenticated GitHub CLI only when using
  `pac profile publish`.
- A new agent session can be started after apply.

The installer does not need root. It does not move host authentication or
session state and does not redirect broad host home variables.

The initial install fetches catalogued upstream Skills and native Plugin bundles
from pinned release tags or immutable commits. PAC does not preinstall PPT
Master's Python, Chromium, or other task-specific prerequisites; the upstream
Skill handles them on demand when that route is used.

Git, curl, and tar are the Core bootstrap trust base: they must already exist
because they acquire and start the installer. Git's configured credential
helper or SSH agent authenticates optional private sources. Preflight verifies
the required subset, and all post-bootstrap tools are installed by the single
pinned mise graph.

## One-command install

Set `PAC_AGENTS` to `codex`, `claude`, or `codex,claude`:

```sh
PAC_AGENTS=codex,claude sh -c "$(curl -fsLS https://get.chezmoi.io)" -- \
  -b "$HOME/.local/bin" -t v2.72.0 -- \
  --source "$HOME/.local/share/personal-agent-control" \
  --config "$HOME/.config/personal-agent-control/chezmoi.toml" \
  init --apply https://github.com/jk-zhang-meta/personal-agent-control.git
```

The `-t` flag pins the Chezmoi bootstrap. The repository's
`.chezmoiversion` rejects older binaries. Chezmoi verifies the checksum-pinned
mise archive; mise installs exact top-level tool versions and verifies binary
assets where its backend supports that metadata. APM receives the reviewed
Core manifest and frozen lock and deploys it once into the neutral store.
PAC uses Vercel Skills only for PPT Master after fetching its exact commit and
verifies the complete installed tree digest. Backend and lock limits are
recorded explicitly in [DECISIONS.md](DECISIONS.md).

The public Core works without a Configuration Profile. To seed an optional
private Profile on first install, set the following before running the same
command:

```sh
PAC_PROFILE_REPO=git@github.com:YOUR_ACCOUNT/YOUR_PRIVATE_PROFILE.git
PAC_PROFILE_REF=main
PAC_PROFILE_COMMIT=REPLACE_WITH_REVIEWED_FULL_COMMIT
export PAC_PROFILE_REPO PAC_PROFILE_REF PAC_PROFILE_COMMIT
```

`PAC_PROFILE_REF` and `PAC_PROFILE_COMMIT` are optional, although supplying the
expected full commit provides the strongest first-install identity check. Never
put a token or password in the repository URL; PAC delegates authentication to
Git/SSH.

If a non-empty `~/.codex/AGENTS.override.md` exists, Codex installation stops
before changing its managed global file. Rename or merge that override only
after reviewing why it exists.

## Review before apply

For an initial dry review, split bootstrap, clone, diff, and apply:

```sh
sh -c "$(curl -fsLS https://get.chezmoi.io)" -- \
  -b "$HOME/.local/bin" -t v2.72.0

PAC_AGENTS=codex,claude "$HOME/.local/bin/chezmoi" \
  --source "$HOME/.local/share/personal-agent-control" \
  --config "$HOME/.config/personal-agent-control/chezmoi.toml" \
  init https://github.com/jk-zhang-meta/personal-agent-control.git

"$HOME/.local/bin/chezmoi" \
  --source "$HOME/.local/share/personal-agent-control" \
  --config "$HOME/.config/personal-agent-control/chezmoi.toml" diff

"$HOME/.local/bin/chezmoi" \
  --source "$HOME/.local/share/personal-agent-control" \
  --config "$HOME/.config/personal-agent-control/chezmoi.toml" apply --init
```

## What apply changes

Only selected host adapters are managed. Both-host mode creates or updates:

```text
~/.codex/AGENTS.md
~/.codex/agents/independent-reviewer.toml
~/.claude/CLAUDE.md
~/.claude/agents/independent-reviewer.md
~/.config/personal-agent-control/machine.json
~/.config/personal-agent-control/profile.json        # only when a Profile is active
~/.config/personal-agent-control/profile-workspace.json # after init/personal mutation
~/.config/personal-agent-control/profile-bootstrap.md # only when declared
~/.config/personal-agent-control/state.boltdb
~/.local/share/personal-agent-profiles/<repo-hash>/<commit>/
~/.local/share/personal-agent-profile-workspaces/default/ # default editable workspace
~/.local/share/personal-agent-profile-runtimes/<profile-hash>/ # with Profile APM packages
~/.local/share/agent-skills/.agents/skills/<catalogued-name>/
~/.local/share/agent-skills/apm.lock.yaml
~/.local/share/agent-skills/apm_modules/...
~/.agents/skills/<Codex-compatible-name> -> neutral physical entry
~/.claude/skills/<Claude-compatible-name> -> neutral physical entry
~/.local/share/agent-plugins/sources/<marketplace>/
~/.codex/plugins/cache/<managed-marketplace>/...
~/.claude/plugins/cache/<managed-marketplace>/...
~/.local/state/personal-agent-control/owned-plugins.tsv
~/.local/bin/pac
~/.local/bin/mise
~/.local/share/mise/...
```

Unrelated user-level Skill entries are preserved for inspection but reported as
`UNMANAGED`; installation is not considered complete until each is catalogued or
removed explicitly. Host-bundled system Skills and Plugin-bundled Skills are
excluded from that standalone inventory. Unrelated host settings are preserved.
When Codex is selected,
catalog-owned legacy duplicates under `~/.codex/skills` are backed up and
removed because Codex reads the filtered `~/.agents/skills` view. A Claude-only
apply leaves Codex instruction, reviewer, and legacy Skill paths unchanged; it
still materializes the machine-wide physical catalog before linking only
Claude-compatible names to it. The physical store is independent of either
host, so installation order does not matter. The validated frontmatter
inventory supplies runtime names. Core standalone and Profile APM Skills target
both hosts; embedded Profile Skills take explicit targets from
`pac-profile.json`. Capability rows provide routing metadata and must agree with
embedded targets, but do not generate links.
Every exact catalogued name is reserved while installed; runtime names do not
encode provenance. The installer records current ownership, backs up and
removes catalog entries retired by a later revision, and leaves unrelated
Skills untouched.
Core Skill upgrades arrive through reviewed Core refs, locks, digests, and
source records. `pac skill update` separately resolves and commits the selected
personal Profile dependency; inspect that local Profile commit before
publishing it. Both paths pass normal reconciliation and verification.

`catalog/plugins.tsv` separately declares the native packages that cannot be
flattened safely. PAC keeps one pinned source checkout per marketplace and asks
the Codex and Claude native Plugin CLIs to create their own required projections.
The public Core declares `context-mode`; a private Configuration Profile may
append `automated-rebuttal-workflow` or another reviewed native package. Draw.io
is installed as the shared standalone Skill; the prior native Plugin is removed
once through the reviewed migration catalog. Unknown installed Plugins are
preserved and reported as `UNMANAGED`.
An inactive host is outside the active Plugin audit: PAC removes only Plugins
it previously owned there and preserves unrelated native Plugins and their
marketplaces. Re-enabling that host restores strict `UNMANAGED` checking.

Only one control plane may own a native marketplace identity. An external
launcher that independently installs `context-mode@context-mode` conflicts with
PAC even when the versions match, because the native manager also records the
source path. Use Codex or Claude directly, or a launcher release that does not
provision Context Mode itself. PAC remains the owner of the Plugin.

When a Profile is active, PAC reads
`~/.config/personal-agent-control/profile.json` and validates its exact cached
commit. New workspaces use Profile schema v3; the loader also accepts v1 and v2
as migration-compatible inputs. All versions use this bounded surface:

```text
pac-profile.json                         # required; new workspaces use schema v3
bootstrap.md                             # when declared by the manifest
context/**/*.md                          # optional on-demand context
skills/<name>/**                         # optional embedded Skills
packages/skills/apm.yml                  # optional APM dependency manifest
packages/skills/apm.lock.yaml            # required for non-empty dependencies
catalog/plugins.tsv                      # optional Plugin provider overlay
catalog/capabilities.jsonl               # optional routing overlay
README.md, LICENSE, LICENSE.md            # optional metadata
```

The canonical v3 manifest has this shape:

```json
{
  "schemaVersion": 3,
  "bootstrap": "bootstrap.md",
  "skills": [],
  "plugins": { "enabled": [], "disabled": [] },
  "providers": { "enabled": ["codegraph"] }
}
```

Legacy v1 manifests contain only `schemaVersion`, `skills`, and
`plugins.enabled`; they cannot declare `bootstrap` or `plugins.disabled`.
Schema v2 adds those fields but cannot enable Core providers.
Context and Profile APM directories are validated independently of that
manifest version. A later `pac plugin add|remove` upgrades a v1 workspace
manifest to v2 before committing it.

Set `bootstrap` to `null` and omit `bootstrap.md` to remove the private
always-on layer. Keep it short when enabled: the common Core kernel reads its
PAC-owned projection at session start. Larger private material belongs in
`context/` and is loaded only when a `context:<id>` row in
`catalog/capabilities.jsonl` matches, for example:

```json
{
  "id": "context:course-guide",
  "kind": "context",
  "name": "course guide",
  "path": "context/course-guide.md",
  "summary": "Private course administration reference.",
  "triggers": ["course administration"],
  "targets": ["codex", "claude"]
}
```

Store each record on one line in the JSONL file. The path must name a relative,
ordinary, non-symlink Markdown file inside the Profile. Only routing metadata
and the exact load path enter SQLite, never the body.

An embedded Skill entry declares exactly `name`, `path`, `contentSha256`, and a
non-empty `targets` array. Schema v3 accepts `["*"]` to target every Agent
supported by the installed Core; explicit Agent IDs remain available for an
intentional subset. Its path is
`skills/<name>`, its `SKILL.md` frontmatter name must match, and its complete
tree must match the digest. Private APM dependencies instead live in
`packages/skills/apm.yml`; a non-empty graph requires its reviewed lock and is
installed frozen into a Profile-commit-specific Runtime before host projection.
Dependencies must be repository references; PAC rejects machine-local paths so
the private Profile remains reproducible on another machine.
Profile APM packages target every Agent supported by the installed Core; use an
embedded Skill with explicit targets only when a subset is required.

`providers.enabled` selects reviewed Core provider definitions without copying
their per-Agent native configuration into the Profile. The Core provider catalog
owns supported Agent adapters, installation/version policy, and verification.
The current `codegraph` provider pins the latest reviewed Core release and
projects the same MCP command into every enabled supported Agent. `pac update`
advances that version only through a reviewed Core revision and lock.

`catalog/plugins.tsv` can add private Plugin providers. The manifest's
`plugins.enabled` adds providers to effective desired state, while
`plugins.disabled` can suppress a Core provider without changing Core. All
Skill, capability, Plugin, marketplace, provider, and bundled-Skill identities
remain globally unique and conflicts fail closed.

Top-level Hooks, scripts, Rulesync rules, symlinks, special files,
unknown top-level content, and credentials embedded in repository locators are
rejected. Explicitly locked Skills and enabled native Plugins retain their
reviewed capability surfaces. Normal apply never fetches a newer Profile branch tip.

## Create or select a private Profile

Someone starting with only the public Core does not need to create a repository
by hand:

```sh
pac profile init [PATH]
pac profile status
pac profile publish OWNER/REPOSITORY
```

`init` creates a valid Profile v3 Git workspace at
`~/.local/share/personal-agent-profile-workspaces/default` unless `PATH` is
given. An existing path must already be a real Git worktree with a valid
Profile. If a workspace is already configured, `init` reuses it rather than
switching to a later `PATH`. PAC records the workspace in
`~/.config/personal-agent-control/profile-workspace.json`, commits the template
or current validated content, and activates that exact local commit.

`publish` requires an authenticated `gh` command. It creates
`OWNER/REPOSITORY` with `gh repo create --private`, adds it as `origin`, pushes
the workspace, and activates the same exact commit through the remote locator.
It never creates a public repository.

After editing the workspace, synchronize it with:

```sh
pac profile sync [COMMIT_MESSAGE]
```

Quote a message containing spaces. PAC validates and commits local changes,
pulls `origin` with `--ff-only`, pushes `HEAD`, then applies and locks the
resulting commit. It refuses divergence rather than merging implicitly.
Workspaces created from a branch track `origin/<branch>`. A workspace created
from a tag or raw commit remains editable but `sync` fails before committing
until the user configures an explicit upstream branch.

To use a Profile that already exists:

```sh
pac profile set REPOSITORY [REF] [EXPECTED_COMMIT]
pac profile update [EXPECTED_COMMIT]
pac profile remove
pac profile status
```

`set` accepts an absolute local Git path or credential-free HTTPS/SSH locator,
defaults `REF` to `main`, validates the fetched Profile, and records the exact
resolved commit. Supplying the full expected commit adds an out-of-band
identity check. `update` is the only command that follows the recorded ref and
may move `lockedCommit`. `remove` retires active Profile bootstrap, Skills,
APM packages, contexts, and Plugin overrides, while keeping the editable
workspace, immutable checkouts, commit-specific APM caches, and backups; it is
not secure erasure.

## Verify

Chezmoi drift:

```sh
"$HOME/.local/bin/chezmoi" \
  --source "$HOME/.local/share/personal-agent-control" \
  --config "$HOME/.config/personal-agent-control/chezmoi.toml" \
  verify --exclude=scripts
```

The always-run integration script is excluded from Chezmoi's byte-state check;
the full doctor below verifies its resulting tool and Skill state.

Full control-plane doctor:

```sh
pac --hosts all doctor
```

The machine activation selects the installed host automatically. `--hosts` may
narrow a check to one enabled host but never enables a disabled host. The doctor
checks exact generated bytes, native reviewer definitions, the semantic APM
runtime lock and deployed file hashes, the full PPT tree digest, the attached
Profile repository/commit/schema/integrity, prior ownership, standalone
user-Skill inventories, target coverage, host link identities,
absence of Codex duplicates, native Plugin source/version/target/bundled-Skill
state, external source declarations, and the complete pinned mise graph.
Task-specific PPT tooling is checked when PPT Master is actually used, not
during every PAC install.

Then start a fresh session:

- Codex: ask it to identify the current control kernel and list the catalogued
  Skills it can discover; invoke `frontend-design`, and invoke
  `personal-environment` only when the selected Profile supplies it.
- Claude: use `/context` and `/skills`, then invoke `frontend-design`, and
  invoke `personal-environment` only when the selected Profile supplies it.

Automatic Skill selection is model-mediated, so behavioral acceptance includes
both a positive trigger and an unrelated negative case; file presence alone is
not sufficient.

## Update and management

```sh
pac plan
pac update
pac status
pac profile status
```

`pac update` and `pac self-update` are aliases for the same Core update path.
They require a clean Core worktree, run `git pull --ff-only`, install the newly
pulled Core's locked mise graph, and reconcile its frozen dependency state.
They do not run an unconstrained dependency upgrade and do not fetch the
Profile's recorded branch. The active Profile remains at the same
`lockedCommit` until `pac profile update`, `set`, `sync`, `publish`, or `init`
explicitly selects another commit. If the Core fast-forward succeeds but a
later install or apply fails, PAC reports the partial outcome and does not reset
the Core revision.

Personal Skill and Plugin changes go to the editable Profile workspace:

```sh
pac skill add APM_DEPENDENCY_REFERENCE
pac skill remove SKILL_NAME_OR_REFERENCE
pac skill update [SKILL_NAME]
pac plugin add NAME
pac plugin remove NAME
pac plugin update [NAME]
```

Skill add/remove/update edits `packages/skills/apm.yml`, regenerates its frozen
lock while dependencies remain (or removes it for an empty graph), and keeps
matching `skill:<name>` capability rows. Plugin add/remove edits
the v2 manifest's enabled/disabled overlay. These commands validate and commit
the workspace, then activate and reconcile that exact commit; they never edit
Core's manifest, lock, capability catalog, or `pac.json`. Plugin update only
validates the optional name and performs a full scoped reconciliation of the
already pinned catalog; changing a pin requires editing and synchronizing the
Profile catalog (or a reviewed Core release).

If no workspace exists, the first personal mutation creates one, or clones the
currently active Profile into one. A failed Runtime apply restores the prior
managed Runtime and active Profile lock; the local workspace Git commit remains
available for inspection or retry. Remote commits already pushed by `publish`
or `sync` are not rewritten by rollback. Start fresh host sessions after an
instruction, Skill, Plugin, bootstrap, or context-routing change.

`PAC_AGENTS` is read when the isolated Chezmoi config is first created. The
first apply seeds an explicit machine activation at
`~/.config/personal-agent-control/machine.json`; later Chezmoi applies preserve
it. Use `pac host enable codex`, `pac host disable claude`, or the corresponding
Claude/Codex choice to change local activation without modifying `pac.json` or
dirtying the Git checkout. `--hosts` is only an operation scope. Disabling a
host removes PAC-owned global instructions, reviewer, active projections, and
native Plugin desired state while preserving unrelated host files, Skills,
Plugins, and marketplaces. Enabling it asks Chezmoi to install the exact
reviewed instruction and reviewer adapter before verification.

## Backup and recovery

Before changed desired state is applied, current managed targets, machine
activation, optional Configuration Profile lock, native-adapter ownership, and
the isolated Chezmoi state database are copied to:

```text
~/.agent-work/backups/personal-agent-control/<UTC timestamp>-<pid>-<UUID>/
```

The snapshot includes the presence or absence and exact content of the local
machine activation and Profile lock, so a failed host or Profile change restores
the prior selected state. It also restores the matching Chezmoi state and
adapter-ownership manifest,
preventing a failed update from leaving the next reconciliation on a newer
state baseline than the files in HOME.

The latest path is recorded privately at:

```text
~/.local/state/personal-agent-control/last-backup
```

Restore the latest snapshot:

```sh
pac rollback
```

Or pass an exact older snapshot directory. The restore command accepts only an
immediate child of the canonical Personal Agent Control backup root and only
removes validated instruction, reviewer, PAC state, catalogued Skill targets,
managed Plugin source checkouts, native Plugin registration files, and only the
catalogued marketplace cache subtrees
recorded in that snapshot before restoring them. It also restores the exact
`pac.json`, APM manifest, APM lock, Profile lock, and previously selected
immutable Profile checkout identity that defined the desired state. The
restore does not touch unrelated host configuration, auth, sessions, Plugin data,
unmanaged Plugins, or system Skills.

After a successful restore, PAC removes the derived capability database and its
SQLite sidecars. PAC rebuilds it immediately when the restored snapshot contains
a complete runtime lock. A pre-install or empty snapshot has no resolvable
runtime, so rebuild is explicitly skipped; run `pac apply` before using the
resolver or starting fresh agent sessions.

### Recover an interrupted transaction

PAC deliberately leaves a dead transaction's lock and Chezmoi marker in place:
guessing that a prior mutation finished would make recovery destructive. Do not
delete the state directory or run another mutation until the retained evidence
has been checked.

1. If `~/.local/state/personal-agent-control/pac.lock` exists, require a real
   directory and a real regular `owner.json`, then verify that its recorded PID
   no longer exists. If that process is alive, leave the lock untouched.
2. If a `chezmoi-transaction-<pid>` marker exists, require exactly one real
   regular marker with exactly two lines and verify that its filename PID no
   longer exists. Its filename PID and second-line token must match the retained
   outer-lock owner when that lock exists. Treat the first line as the snapshot path and run
   `scripts/restore-backup.sh --validate <snapshot>` from the installed PAC
   checkout. The snapshot must be one immediate child of the canonical backup
   root and must match the installed PAC source.
3. A retained marker intentionally blocks `pac rollback`. Restore the already
   validated snapshot with `scripts/restore-backup.sh <snapshot>` directly and
   the intended `HOME`.
4. Only after restore succeeds, move the exact `pac.lock`, marker, and optional
   matching `.claim` into a newly created private recovery-evidence directory
   outside the PAC state directory. For a stale ordinary PAC lock with no
   marker, move only `pac.lock` after the dead-PID check. Never recursively
   remove the state directory.
5. Run `pac doctor`, then `pac status`. Keep the recovery evidence and snapshot
   until both checks succeed and the intended state has been inspected.

## Development checks

```sh
cd "$HOME/.local/share/personal-agent-control"
"$HOME/.local/bin/mise" trust --yes mise.toml
MISE_PARANOID=1 "$HOME/.local/bin/mise" install --locked --yes
"$HOME/.local/bin/mise" run check
"$HOME/.local/bin/mise" run test-install
```

The acceptance test sets a disposable HOME and Chezmoi config. It does not
modify real Codex or Claude configuration.

## Public release boundary

The HTTPS examples describe the intended public Core endpoint. They do not
assert that the repository is already public. The current monolithic history
contains private Profile material and must not have its visibility changed.
Publish only a fresh, allowlisted Core history after content, secret,
provenance, license, isolated-install, and anonymous-clone review. Keep the
Configuration Profile in its separately authorized private repository.
