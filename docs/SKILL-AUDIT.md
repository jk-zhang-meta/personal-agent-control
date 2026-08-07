# Skill Audit — 2026-08-07

This document preserves the original module audit and records the subsequent
Core/Profile placement decision. Inventory counts below are historical evidence
for the reviewed monolithic candidate, not promises about the split release.

## Decision rule

The audit evaluated each of the 14 former `pac-*` modules by contract
equivalence, maintenance and release evidence, license, cross-host behavior,
dependency and side-effect surface, immutable acquisition, and overlap with the
always-loaded kernel. Popularity alone was not treated as evidence.

Runtime provenance prefixes were removed. A reusable capability is fetched from
a mature upstream when it is equivalent enough. Core retains only common
methods and necessary thin cross-host routes; personal rules and private facts
belong to the Configuration Profile.

## Module-by-module result

| Former module | Decision | Result and reason |
|---|---|---|
| `pac-canonical-state` | KEEP + RENAME | Now `canonical-state`. Core retains the generic source-of-truth/runtime boundary method; user-specific machines, repositories, paths, and locators move to Profile `personal-environment`. |
| `pac-coordination` | DELETE | Its direct/parallel/graph selection and delegate contract duplicated the always-loaded main-agent workflow. `graph-workflow` retains only dependency-specific method. |
| `pac-frontend-design` | REPLACE | The 1,700-line local synthesis was replaced by upstream `frontend-design`, `vercel-react-best-practices`, and `vercel-composition-patterns`. The thin `software-workflow` route selects them only for applicable frontend work. |
| `pac-graph-workflow` | KEEP + RENAME | Now `graph-workflow`. It is the necessary thin route from dependency-aware work to each host's native plan/task/delegation/recovery surface; it explicitly forbids inventing a scheduler. No stable equivalent covered the full ready-wave and recovery contract. |
| `pac-karpathy-guidelines` | DELETE | Its assumption, simplicity, surgical-change, and verification rules were already covered by the kernel and Ponytail. The closest public source has no stable release; installing another broad coding trigger would add overlap without capability. |
| `pac-personal-environment` | MOVE TO PROFILE | Now `personal-environment` in the private Configuration Profile. It is the fact and locator layer for named machines, paths, storage, services, preferences, and credential sources, so it must not ship in public Core. |
| `pac-ponytail` | REPLACE | Replaced by the exact upstream `ponytail` from release `v4.8.4`. |
| `pac-ponytail-review` | REPLACE | Replaced by the exact upstream `ponytail-review` from the same release. |
| `pac-research` | KEEP + RENAME | Now `research`. It preserves the answer-versus-authorized-artifact contract, primary-source discipline, dates, uncertainty, and optional delegation. The closest released alternative always delegates and writes a repository file, so it is not equivalent. |
| `pac-research-core` | KEEP + RENAME | Now `research-core`. It routes Quick, Evidence Review, and Formal scholarly/practitioner evidence work without imposing a heavyweight PDF/figure/toolchain workflow. |
| `pac-software-design-philosophy` | REPLACE | Replaced by released upstream `codebase-design`; the thin software route carries the small missing ownership and verification floor. |
| `pac-software-workflow` | KEEP + REWRITE | Now `software-workflow`. The former broad workflow was reduced to a short code-domain composition table. It keeps frequently co-applicable upstream engineering Skills out of the global kernel without adding a scheduler, lifecycle, scripts, or nested router. |
| `pac-verified-operations` | KEEP + RENAME | Now `verified-operations`. It remains the on-demand artifact-oracle, independent-review, backup, rollback, and recovery method. The non-miss authority gates remain in the kernel. |
| `pac-writing-skills` | KEEP + RENAME | Now `writing-skills`. It supplies cross-host description routing, progressive disclosure, positive/negative trigger evaluation, and provenance discipline. It delegates scaffolding to a host-native `skill-creator` when present, avoiding a Codex name collision. |

In the original monolithic candidate, 14 local modules became eight
repository-authored Skills plus reviewed upstream replacements; later additions
changed that dated inventory. In the split architecture, public Core and the
optional Configuration Profile merge their unique identities into one physical
standalone store. No runtime name receives a `pac-*` or provenance prefix.

That neutral one-copy statement applies to standalone Skills. Native Plugin
caches remain host-owned runtime projections. In the resolver's v1 model,
standalone and Plugin-bundled leaves nevertheless share one globally unique
`skill:<name>` identifier space; strict catalog validation rejects any name
collision instead of treating provenance as a runtime namespace.

Compatibility and activation policy are recorded with each identity in the
Core and optional Profile capability catalogs. The projection contract can omit
a host-exclusive Skill from an incompatible host without creating another
physical copy. A Profile may only append identities; collisions fail closed.

The split release therefore has two audit surfaces: Core contains common-safe
capabilities and public provenance only; the private Configuration Profile owns
`personal-environment`, private provider locators, and private Plugin metadata.
The existing monolithic history is not publishable and cannot be converted to a
public Core by deleting current files alone.

## Upstream selections

- [Ponytail v4.8.4](https://github.com/DietrichGebert/ponytail/releases/tag/v4.8.4),
  commit `bc9ee949d5f439e8b9f3bb92c6d6d3d1e6ebd324`, supplies the two exact
  simplicity Skills under MIT.
- [Matt Pocock Skills v1.2.2](https://github.com/mattpocock/skills/releases/tag/v1.2.2),
  commit `8b36d4fb2635b3c21998dcd8144439c9e5ba7302`, supplies
  `codebase-design`, `diagnosing-bugs`, and `tdd` under MIT. Its `code-review`
  was excluded because it assumes Git-diff scope, host-specific delegation,
  and an unavailable setup Skill; native reviewers own cross-host correctness
  review instead.
- [Anthropic frontend-design](https://github.com/anthropics/skills/tree/b29e7cf65e5cb78a5ac33d582270551bc74a14eb/skills/frontend-design),
  pinned to commit `b29e7cf65e5cb78a5ac33d582270551bc74a14eb`, supplies the brief-first
  visual direction and screenshot iteration method under Apache-2.0.
- [Vercel agent Skills](https://github.com/vercel-labs/agent-skills/tree/7c180d9044c9ae2b442b567aad4e42a28dd5ed62),
  pinned to commit `7c180d9044c9ae2b442b567aad4e42a28dd5ed62`, supply the selected MIT
  React/Next performance and React composition Skills.
- [PPT Master v4.3.0](https://github.com/hugohe3/ppt-master/tree/v4.3.0/skills/ppt-master),
  commit `51cb529d00638097e70fd3e9d865a0bf061b5e19`, remains the presentation
  workflow under MIT.
- [draw.io MCP repository](https://github.com/jgraph/drawio-mcp/tree/14b318b19cc37b159f841227b9d11fbd18ce18ea/plugins/codex/drawio/skills/drawio),
  pinned to commit `14b318b19cc37b159f841227b9d11fbd18ce18ea`,
  supplies the identical Codex/Claude `drawio` Skill under Apache-2.0. Its
  Plugin wrapper exposes no MCP, hook, or agent, so one neutral Skill replaces
  two native Plugin caches.
- [Requirements Clarity](https://github.com/softaworks/agent-toolkit/tree/3027f20f3181758385a1bb8c022d4041dfb4de84/skills/requirements-clarity)
  supplies the optional formal vague-feature/PRD intake method under MIT. The
  kernel's normal intake gate remains proportional and does not force it onto a
  clear request.
- [i-have-adhd](https://github.com/ayghri/i-have-adhd/tree/2d19ad205eb1d85fc9c3968bdeba4c2116518685/skills/i-have-adhd)
  supplies an explicit-only focused response mode under MIT. PAC adopts only
  its safe presentation shape globally and rejects hard list caps, forced
  causes, and unsupported estimates.

## Plugin distribution follow-up

The machine-wide audit found two bundles that cannot be represented as
standalone Skills without losing behavior:

- `context-mode@v1.0.169`: eight Skills plus six lifecycle hooks and an MCP
  runtime under Elastic-2.0; and
- `automated-rebuttal-workflow@v1.0.0`: four Skills sharing a package runtime
  and host-specific confirmation adapter under MIT.

`context-mode` remains in public Core. The private
`automated-rebuttal-workflow` declaration moves to the Configuration Profile.
Both use the same native host Plugin reconciliation after Core and Profile
catalogs are validated and merged. Plugin-bundled Skills are inventoried in
their owning catalog and never duplicated in the standalone Skill catalog.
Codex `.system`,
the OpenAI-curated template cache, marketplace source
checkouts without an installed package, and historical quarantine trees remain
explicitly host-owned or inactive.

## Important non-selections

- [Superpowers v6.2.0](https://github.com/obra/superpowers/releases/tag/v6.2.0)
  has strong verification and subagent patterns, but its nearest Skills either
  duplicate the kernel or assume a larger worktree/TDD/commit lifecycle.
- [Planning with Files v3.9.0](https://github.com/OthmanAdi/planning-with-files/releases/tag/v3.9.0)
  is mature persistent planning, but it writes project state and depends on
  hooks whose semantics differ between Claude and Codex; it is not a native DAG
  executor replacement.
- [K-Dense scientific-agent-skills v2.62.0](https://github.com/K-Dense-AI/scientific-agent-skills/releases/tag/v2.62.0)
  offers a capable literature-review pipeline but mandates databases, PDF,
  figures, and sibling/tool dependencies beyond the general research contract.
- Vercel `web-design-guidelines` was excluded because the reviewed wrapper
  fetches a moving remote document at use time and lacks a clear license record.
- Impeccable was excluded as a global default because its Git reads, project
  files, and hooks cross this control plane's workspace ownership boundaries.

The authoritative portable identities and integrity values are in the APM
manifest and lock; the PPT exception has its exact commit and complete-tree
digest in the PAC materializer contract. Ordinary selection uses native Skill
descriptions; the global kernel contains only mandatory gates, and
`software-workflow` owns software-specific composition. The later
`capability-resolver` is used only for ambiguous, cross-domain, or inventory
queries and preserves the typed activation of Skills, Plugin providers, and
subagents.
