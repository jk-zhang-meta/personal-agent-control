# Skill Sources and Licenses

Every routed capability is ultimately exposed as a Skill, but its distribution
unit may be either one standalone Skill or a native Plugin bundle. Source type is
tracked only for provenance, updates, licensing, integrity, and recovery; it is
not a quality tier.

## Control-plane tools

Exact versions and applicable integrity records are in `catalog/tools.tsv`,
`mise.lock`, and `.chezmoiexternal.toml.tmpl`.

| Component | License | Role |
|---|---|---|
| Chezmoi | MIT | deployment, backup trigger, and machine templating |
| mise | MIT | shared dependency manager |
| Rulesync | MIT | host instruction and reviewer compiler |
| Microsoft APM 0.28.0 | MIT | portable package graph, lock, neutral Skill deployment, update, and uninstall engine |
| Vercel Skills 1.5.22 | MIT | temporary materializer only for the APM-incompatible 12,230-file PPT Master package |
| uv | Apache-2.0/MIT | Python tool runtime for Skill validation |
| skills-ref | Apache-2.0 | Agent Skills structure validator |
| Node.js | MIT | JavaScript CLI runtime |
| Gitleaks | MIT | secret scanning |
| ShellCheck | GPL-3.0 | shell static analysis; not linked into artifacts |
| ripgrep | Unlicense/MIT | shared exact-text search tool |

## Installed Skill sources

| Source identity | License | Selected Skills |
|---|---|---|
| `mattpocock/skills@v1.2.2` | MIT | `codebase-design`, `diagnosing-bugs`, `tdd` |
| `DietrichGebert/ponytail@v4.8.4` | MIT | `ponytail`, `ponytail-review` |
| `anthropics/skills@b29e7cf65e5c` | Apache-2.0 | `frontend-design` |
| `vercel-labs/agent-skills@7c180d9044c9` | MIT in each selected Skill | `vercel-react-best-practices`, `vercel-composition-patterns` |
| `hugohe3/ppt-master@v4.3.0` | MIT | `ppt-master` |
| `jgraph/drawio-mcp@14b318b19cc3` | Apache-2.0 | `drawio` |
| `softaworks/agent-toolkit@3027f20f3181` | MIT | `requirements-clarity` (formal vague-requirement/PRD route only) |
| `ayghri/i-have-adhd@2d19ad205eb1` | MIT | `i-have-adhd` (explicit response-style mode; no native always-on Hook) |

Common thin routes live in Core `payload/skills`. Personal rules, private
environment locators, and private capabilities live in the separately selected
Configuration Profile. No public upstream Skill tree is vendored or renamed.
Profile content is not licensed or authorized for public redistribution by the
Core repository.

`packages/skills/apm.yml` is the portable acquisition manifest and
`packages/skills/apm.lock.yaml` records the resolved commit, virtual path, and
content hash for each Core dependency. PAC compares the expanded runtime
lock semantically with that canonical lock and verifies every deployed file
against the runtime hashes.

PPT Master is intentionally absent from the APM graph because APM 0.28.0
rejects its own generated 134,890-line lock for that package under its YAML
alias-expansion safety budget. PAC verifies tag provenance, fetches the exact
reviewed commit, invokes Vercel Skills in the neutral store, and recomputes a
deterministic digest over the complete installed tree. Backup and rollback keep
that tree and the desired-state files in the same transaction.

## Managed native Plugin sources

| Source identity | License | Package and bundled Skills |
|---|---|---|
| `mksglu/context-mode@v1.0.169` | Elastic-2.0 | `context-mode`; eight Skills plus native hooks and MCP runtime |

Core `catalog/plugins.tsv` fixes the tag, resolved commit, Git tree, package
version, targets, visibility, and complete bundled-Skill list. PAC clones each
marketplace once under `~/.local/share/agent-plugins/sources`; the host-native
Plugin managers remain responsible for their cache projections and runtime
manifests.

The private Configuration Profile, rather than Core, declares the academic
rebuttal package. Its Profile catalog must retain the source locator, tag,
release-wrapper commit, embedded source commit, tree, license, targets, and
complete bundled-Skill inventory needed to verify all provenance layers. The
private source locator does not belong in public Core documentation.

## Optional durable runtime design references

These primary sources inform ADR-006; they are not installed dependencies or an
authorization to deploy an external control plane. Last reviewed 2026-08-08.

| Primary source | Decision evidence |
|---|---|
| [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview), [persistence](https://docs.langchain.com/oss/python/langgraph/persistence), and [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | LangGraph is a low-level orchestration runtime; checkpoints support restart, failure recovery, and human input, while thread state and cross-thread stores have distinct scopes. |
| [LangGraph Agent Server](https://docs.langchain.com/langsmith/agent-server) | A durable deployment owns assistants, threads, runs, checkpoints, and its task queue; PAC must not mirror those resources. |
| [Standalone deployment](https://docs.langchain.com/langsmith/deploy-standalone-server) and [authentication and access control](https://docs.langchain.com/langsmith/auth) | A shared production deployment has database, queue, licensing, authentication, authorization, and operational obligations that do not belong in each user's PAC installation. |
| [LangGraph Functional API](https://docs.langchain.com/oss/python/langgraph/functional-api) | Recovery can re-execute incomplete work, so external side effects require task isolation and idempotency. |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) and [OpenAI Symphony](https://github.com/openai/symphony) | Native parallel coordination remains useful for bounded work; tracker-driven coding automation is a distinct surface from an application-level durable research graph. |

## Configuration Profile source

`~/.config/personal-agent-control/profile.json` records the selected repository,
requested ref, and resolved commit. The immutable checkout is stored under
`~/.local/share/personal-agent-profiles/<repo-hash>/<commit>`. Normal
apply consumes that locked checkout; only `pac profile update` resolves a newer
commit.

The accepted Profile inventory is limited to `pac-profile.json`, `skills/**`,
and optional `catalog/plugins.tsv` and `catalog/capabilities.jsonl`. Core and
Profile identities merge append-only, with collisions rejected. Hooks, scripts,
Rulesync rules, unknown top-level files, unsafe paths, and credential-bearing
repository locators are not valid Profile sources. Private repository access uses the user's Git or
SSH credential mechanism; credentials are not part of the recorded locator.

The existing monolithic repository history is not a distributable Core source:
it contains private Profile material. A public Core source must be created as a
fresh allowlisted history and pass content, secret, provenance, and license
audit before publication.

## Deliberate exclusions

- Vercel `web-design-guidelines` is not installed: its wrapper fetches a moving
  remote document at invocation time, and the reviewed wrapper has no clear
  license declaration. This breaks the repository's pinned and reproducible
  source contract.
- Impeccable is mature but is not a global default because it reads local Git,
  writes project design files, and installs project hooks. Those effects conflict
  with the control plane's exact-target and workspace ownership boundaries.
- Anthropic/OpenAI `skill-creator` is not installed globally because Codex
  already provides a bundled Skill with that name and duplicate same-name
  discovery is not a safe cross-host contract. `writing-skills` routes to a
  host-native creator when one exists.
- Codex `.system` Skills and the OpenAI-curated `openai-templates` remote cache
  remain host-owned. They are neither vendored nor treated as user-installed
  standalone Skills. Claude's official marketplace checkout is likewise not an
  installed capability.

PPT Master owns task-specific presentation prerequisites. This repository does
not distribute a PPT wrapper, Python environment, Chromium build, or credential.
Network-backed image, search, TTS, URL-ingestion, and model routes remain subject
to the always-on private-boundary and external-effect rules.
