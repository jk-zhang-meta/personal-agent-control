# Host Semantics and Support

Profile v2 and CLI semantics were checked against the implementation on
2026-08-07. Live-host evidence and any still-unexecuted combinations remain in
[VERIFICATION.md](VERIFICATION.md).

## Semantic types

The system treats these mechanisms as different types:

| Type | Loading guarantee | Intended use |
|---|---:|---|
| always-on instruction | deterministic at session or scope load | authority, safety, routing, completion |
| Profile bootstrap | deterministic through the managed Core kernel | short private preferences |
| path-scoped rule | deterministic only for matching paths | language, directory, test, architecture facts |
| native Skill | automatic trigger is model-mediated; explicit invocation is deterministic | detailed reusable method |
| routed context module | loaded on demand after metadata routing | private facts too large or narrow for bootstrap |
| explicit command | only when called | release, deploy, migration, repair |
| plain Markdown routing sentence | no host-level include guarantee | advisory routing only |

Rules that cannot tolerate a missed trigger stay in the always-on layer or a
host enforcement mechanism. Skills provide progressive disclosure but are not
used as a zero-failure security boundary. Profile `bootstrap.md` is deliberately
small; context bodies remain outside startup context and outside the resolver
index.

## Verified hosts

### Codex CLI

- User instructions: `$CODEX_HOME/AGENTS.override.md` shadows `AGENTS.md`.
- Project instructions are composed from root to the current directory, with
  closer files later, subject to the host's combined-size limit.
- Codex has no general arbitrary-Markdown include for global instructions.
- User Skills are discovered at `$HOME/.agents/skills`.
- This system therefore installs `~/.codex/AGENTS.md`, blocks on a non-empty
  override, and projects only Codex-compatible Skill links under
  `~/.agents/skills`.
- The managed `AGENTS.md` contains one generic instruction to read
  `~/.config/personal-agent-control/profile-bootstrap.md` when a Profile v2
  declares it; the Profile cannot replace the rest of the Core kernel.

### Claude Code

- User instructions are read from `~/.claude/CLAUDE.md` unless the entire
  config root is intentionally relocated.
- Claude supports `@path` imports, but imported text still consumes startup
  context; this system uses native Skills instead of eager imports.
- User Skills are projected under `~/.claude/skills`.
- This system installs native Claude instructions and a reviewer definition,
  then creates one symlink per Claude-compatible Skill to the shared physical
  store.
- The managed `CLAUDE.md` uses the same optional PAC-owned Profile bootstrap
  path; larger private context is not imported eagerly.

The host-facing physical catalog is neither host's discovery root. It lives at
`~/.local/share/agent-skills/.agents/skills` and is derived from frozen Core
packages, Profile embedded Skills, and Profile APM packages. PAC validates each
`SKILL.md` frontmatter identity and creates only the corresponding owned links.
Core standalone and Profile APM Skills currently target both hosts. An embedded
Profile Skill takes its explicit targets from `pac-profile.json`; its capability
row must agree. Capability rows provide routing and consistency validation, not
the link-generation authority.
A host-specific Skill is therefore stored once and absent from an incompatible
or disabled host, regardless of which host was installed first.

Profile context modules are not Skill links and are not copied into either
host's discovery directory. A `context:<id>` capability indexes only its name,
aliases, summary, triggers, and Profile-relative path. Resolution returns the
exact Markdown path in the immutable Profile checkout; the selected host reads
the body only when that route is used.

Native Plugin desired state is also merged before host filtering. Profile v2
may enable a private provider, disable a Core provider, or extend the provider
catalog; host-native managers still own hooks, MCP processes, manifests, and
caches.

## Supported, enabled, scoped, and active

PAC does not use one overloaded `enabled` flag for every purpose:

| Set | Source | Meaning |
|---|---|---|
| supported | versioned `pac.json` and host adapters | PAC can manage this host |
| enabled | private `~/.config/personal-agent-control/machine.json` | this machine should expose PAC to the host |
| scope | optional `--hosts` argument | this operation may inspect or change the host |
| active | `enabled intersect scope` | PAC exposes and verifies the host now |

`PAC_AGENTS` seeds the enabled set only on the first installation. Afterwards,
`pac host enable|disable` changes the local machine activation; it does not edit
the Git checkout. An inactive host loses only PAC-owned instructions, reviewer,
Skill projections, and Plugin registrations. Unrelated native Skills, Plugins,
marketplaces, settings, authentication, and sessions remain untouched. A
future re-enable restores strict collision and unmanaged-capability checks.
Selecting a disabled host for status or doctor does not audit or activate its
native surface. A mutating command may still use that scope to retire only
state proven by PAC's prior ownership manifests.

## Future adapter candidates

| Host | Likely common entry | Important difference before adoption |
|---|---|---|
| GitHub Copilot CLI | `AGENTS.md` and `~/.agents/skills` are supported | global instruction precedence has no universal conflict rule |
| Gemini CLI | configurable context files and `~/.agents/skills` | Skill activation consent and context inspection differ |
| Cursor | `AGENTS.md`, Rules, and `.agents/skills` | User Rules are managed separately and path Rules have host fields |
| OpenCode | global/project `AGENTS.md` and `.agents/skills` | stable and v2 configuration semantics currently differ |
| Cline | global/project rules and Skill directories | does not use `.agents/skills` as its documented Skill root |
| Aider | explicit `--read` convention files | no native Agent Skills mechanism |

An adapter is added only after isolated and real-host tests. Full-home variables
such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `COPILOT_HOME`, and
`GEMINI_CLI_HOME` are not repointed at OneDrive or this repository: they move
auth, sessions, plugins, history, permissions, or other broad state and do not
form a universal policy root.

Official references:

- [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Codex Skills](https://learn.chatgpt.com/docs/build-skills)
- [Claude memory and instructions](https://code.claude.com/docs/en/memory)
- [Claude Skills](https://code.claude.com/docs/en/skills)
- [GitHub Copilot CLI custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [Gemini CLI context files](https://geminicli.com/docs/cli/gemini-md/)
- [Cursor Rules](https://cursor.com/docs/rules)
- [OpenCode Rules](https://opencode.ai/docs/rules)
- [Cline Rules](https://docs.cline.bot/customization/cline-rules)
- [Aider convention files](https://aider.chat/docs/usage/conventions.html)
