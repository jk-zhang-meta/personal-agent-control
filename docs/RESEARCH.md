# Research Basis

Research mode: bounded evidence review. Access date: 2026-08-06. Conclusions
apply to the cited versions and host documentation; future upgrades require
rechecking semantics and fixtures.

## Design evidence

- [AGENTS.md](https://agents.md/) and the
  [Agent Skills specification](https://agentskills.io/specification) provide
  the closest cross-host conventions for project instructions and progressive
  capabilities, but neither is a complete global deployment or dependency
  standard.
- OpenAI's
  [Harness Engineering](https://openai.com/index/harness-engineering/)
  describes a short root map, structured versioned knowledge, progressive
  disclosure, and mechanical validation instead of one exhaustive instruction
  file.
- Anthropic's
  [Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  and [Skills guidance](https://claude.com/blog/building-agents-with-skills-equipping-agents-for-specialized-work)
  support keeping startup context small and loading specialized methods only
  when needed.
- [Chezmoi](https://www.chezmoi.io/user-guide/setup/) provides mature
  cross-machine source/target state, private-repository support, templates,
  scripts, checksummed externals, diff, and update.
- [mise lockfiles](https://mise.jdx.dev/dev-tools/mise-lock.html) and
  [backends](https://mise.jdx.dev/dev-tools/backends/) provide one cross-platform
  dependency plane for runtimes, npm tools, Python tools, and verified GitHub
  binaries.
- [Rulesync v16.7.0](https://github.com/dyoshikawa/rulesync/releases/tag/v16.7.0)
  provides maintained host format generation. Its tested role here is compiler,
  not installer or rollback engine.
- [Vercel Skills v1.5.22](https://github.com/vercel-labs/skills/releases/tag/v1.5.22)
  provides reviewed-source acquisition and a built-in `universal` materializer.
  Its tested role here is materializing the local first-party payload and
  pinned public upstream Skills once inside a synthetic host-neutral HOME; PAC
  owns compatibility filtering and host projections.
- [Codex Skill discovery](https://developers.openai.com/codex/skills#where-codex-loads-local-skills)
  includes user-level `~/.agents/skills` and follows symlinked Skill folders.
  [Claude Code Skill discovery](https://code.claude.com/docs/en/skills#where-skills-live)
  instead names `~/.claude/skills` for personal Skills and supports linked
  Skill-directory entries. This documented asymmetry requires two filtered
  discovery projections; neither discovery root should be the physical store.

## Skill routing and catalog scale

- The [Agent Skills specification](https://agentskills.io/specification#progressive-disclosure)
  defines three disclosure levels: all Skills contribute only name and
  description initially, a selected `SKILL.md` loads on activation, and
  supporting resources load only when needed.
- The official
  [client implementation guide](https://agentskills.io/client-implementation/adding-skills-support)
  estimates roughly 50–100 tokens of catalog metadata per Skill and says most
  implementations use model judgment over descriptions rather than a separate
  keyword router.
- [OpenAI's Skill documentation](https://learn.chatgpt.com/docs/build-skills)
  caps Codex's initial Skill list at 2% of context, or 8,000 characters when
  context size is unknown. It shortens descriptions and may omit Skills when
  the set is too large. This makes an unbounded global catalog unsafe.
- [Claude Code Skills](https://code.claude.com/docs/en/skills) likewise keep
  descriptions in context, support project and nested-directory scopes, and
  provide explicit visibility overrides. Claude plugin namespaces prevent
  name collisions, but enabled Skills still have metadata cost.
- [Vercel Skills](https://github.com/vercel-labs/skills) provides selective
  global/project installation and `skills use` for a single temporary Skill.
  It is an installer and discovery CLI, not a runtime semantic router.
- [Agent Plugins 1.0](https://agent-plugins.org/) is the emerging
  vendor-neutral package floor for a `plugin.json`, Agent Skills, and MCP
  servers. Its current compatibility table includes ChatGPT/Codex, GitHub
  Copilot, VS Code, Cursor, and Kiro, but not Claude Code; it is therefore the
  preferred future pack shape with a thin Claude adapter, not a replacement
  for current routing or host verification.
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
  already exposes host-native embeddings-based dynamic retrieval for Skill
  instructions. Future adapters should use such native retrieval when present,
  but PAC cannot make a cross-host guarantee from a Copilot-only feature.
- [Agent Skills description evaluation](https://agentskills.io/skill-creation/optimizing-descriptions)
  recommends realistic should-trigger and hard near-miss should-not-trigger
  queries, repeated runs, and held-out validation. Routing must be measured in
  the intended complete catalog because isolated tests hide competition and
  truncation.

The resulting hierarchy is: scope or pack selection limits the active catalog;
native descriptions select ordinary leaves; a thin domain route is used only
for recurrent cross-Skill composition; and the global file contains only a
stable capability-agnostic protocol plus cross-task authority and verification
semantics. Zero-miss enforcement belongs to native Hooks, permissions,
configuration, CI, or other deterministic controls. Plugin marketplaces and
namespaces remain distribution and collision controls, not substitutes for
active-set reduction.

## Human-reviewable response evidence

- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  recommends a lean policy, task-specific length and structure, conclusion
  first, and preserving evidence, material caveats, and the next action before
  optional background or repetition.
- The [OpenAI Model Spec](https://model-spec.openai.com/2025-12-18.html)
  calls for direct, well-organized answers with judicious formatting and length
  adapted to the user's objective. It separates interactive conversation from
  programmatic use and requires material uncertainty to be surfaced.
- [Anthropic's prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
  says output requirements should be explicit and reserves lists for genuinely
  discrete items rather than fragmented long-form prose.
- Google PAIR's
  [Explainability and Trust guide](https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/)
  recommends partial explanations and progressive disclosure focused on what
  affects user decisions. It warns that numeric confidence can distract or be
  misread unless its meaning and action are validated with users.
- Microsoft's validated
  [Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf)
  support context-relevant information, clear capability boundaries,
  explanations when needed, and efficient correction. A later
  [enterprise explainability study](https://www.microsoft.com/en-us/research/wp-content/uploads/2024/01/CHI-2023-Surfacing-AI-Explainability-Tech-Proficiency-Tandon-Wang.pdf)
  found value in simple-to-detailed, on-demand progressive disclosure for
  users with different technical proficiency. These studies concern broader
  human-AI interfaces, not specifically coding-agent terminals.
- GitHub Copilot CLI's
  [research workflow](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/research)
  demonstrates a practical two-layer output: a brief terminal result plus a
  durable cited Markdown report for full detail.

These sources converge on an adaptive response contract, not a universal
`Summary / Details / Next Steps` template. The global kernel therefore defines
only stable human-reviewability invariants. Domain-specific review, research,
deployment, and artifact schemas remain with their Skill or agent; strict JSON
belongs only at a machine-consumed invocation boundary.

## Software Skill evidence

The software routes reuse `codebase-design`, `diagnosing-bugs`, and `tdd` from
[mattpocock/skills v1.2.2](https://github.com/mattpocock/skills/tree/v1.2.2),
resolved to commit `8b36d4fb2635b3c21998dcd8144439c9e5ba7302`.
`ponytail` and `ponytail-review` come from
[Ponytail v4.8.4](https://github.com/DietrichGebert/ponytail/releases/tag/v4.8.4),
resolved to `bc9ee949d5f439e8b9f3bb92c6d6d3d1e6ebd324`. These released,
licensed sources replace local rewrites; `software-workflow` supplies only the
small cross-Skill routing and responsibility rules.

Matt Pocock's `code-review` was not retained after independent audit. Its
contract is limited to changes since a fixed Git point and its body assumes a
host-specific `Agent/general-purpose` surface plus an unavailable setup Skill.
PAC's native read-only reviewer definitions cover diffs, whole trees, and exact
immutable artifacts without projecting that incompatibility to both hosts.

## Frontend design evidence

The frontend route composes narrowly scoped upstream Skills rather than
maintaining another large local design handbook:

- Anthropic's
  [frontend-design Skill at b29e7cf](https://github.com/anthropics/skills/blob/b29e7cf65e5cb78a5ac33d582270551bc74a14eb/skills/frontend-design/SKILL.md)
  supplies brief-first visual direction, deliberate visual identity, responsive
  thinking, and screenshot iteration under Apache-2.0.
- Vercel's `vercel-react-best-practices` and
  `vercel-composition-patterns` at
  [7c180d9](https://github.com/vercel-labs/agent-skills/tree/7c180d9044c9ae2b442b567aad4e42a28dd5ed62)
  add React/Next performance and React 19 component composition only when those
  task branches apply. Both selected Skills declare MIT.
- Vercel `web-design-guidelines` is deliberately not installed because the
  reviewed wrapper fetches a moving remote document on each invocation and has
  no clear license record. A global Skill must remain pinned and reproducible.
- [Impeccable at a075d89](https://github.com/pbakaus/impeccable/tree/a075d89bdbe60b2b00220cb0527fb5091e84215e)
  provides a mature shape, build, audit, harden, and polish vocabulary plus
  browser iteration and deterministic detectors. Its 3.4 MB Skill payload,
  23-command surface, provider hooks, project state, and live-browser runtime
  would duplicate this repository's control plane; it is therefore evidence,
  not an installed dependency.
- The normative and platform baselines come from
  [WCAG 2.2](https://www.w3.org/TR/WCAG22/), the
  [ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/),
  [WAI design guidance](https://www.w3.org/WAI/tips/designing/),
  [MDN responsive design](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Responsive_Design),
  [web.dev Web Vitals](https://web.dev/articles/vitals), and the
  [Design Tokens Community Group reports](https://www.designtokens.org/tr/).

The thin software route selects this composition only when the task calls for
it. No frontend framework, browser daemon, hook, or new runtime is imposed
globally; existing project tools remain the execution surface.

## Presentation production evidence

The presentation route adopts
[PPT Master](https://github.com/hugohe3/ppt-master) rather than reconstructing a
deck workflow. Its v4.3.0 lineage provides four explicit artifact lifecycles,
editable SVG-to-PPTX generation, native template fill and enhancement,
structured quality gates, source conversion, visual review, and reusable
template workspaces. PAC installs the public
[v4.3.0 release](https://github.com/hugohe3/ppt-master/tree/v4.3.0/skills/ppt-master),
resolved to commit `51cb529d00638097e70fd3e9d865a0bf061b5e19`, rather than a moving branch or a
vendored copy.

Keeping the upstream Skill intact avoids fragile renaming or selective
extraction while keeping PAC itself small. PAC does not add a wrapper, Python
lock, or preinstalled Chromium. PPT Master's own instructions handle any
task-specific prerequisites when a presentation route is invoked. Its URL,
image, search, TTS, model, and other network-backed routes remain governed by
the always-on external-effect and secret rules.

## Empirical cautions

The following findings came from isolated fixtures in addition to documentation:

- Rulesync global output follows `HOME`, writes directly, and has no complete
  transaction rollback. `--delete` can remove hand-authored content; subagent
  conversion can drop host-specific model, tool, permission, or effort fields;
  Skill generation creates physical per-host copies.
- Vercel Skills' global lock is update metadata rather than a restore oracle;
  same-name sources can overwrite one another; symlink failure can fall back to
  copying; per-agent removal can affect shared content.
- In an isolated v1.5.22 fixture, a Claude-only local-source install copied the
  Skill into `~/.claude/skills`. A second fixture established that the CLI's
  `universal` target follows `HOME` and materializes only under
  `<synthetic-home>/.agents/skills`. PAC therefore isolates only the child
  materializer HOME, then creates its own target-filtered links; it never uses
  a host selector to imply compatibility.
- A remote private Skills source can disclose repository and Skill names to the
  vendor audit endpoint even when telemetry is disabled. The system therefore
  acquires the optional private Configuration Profile directly with Git and
  materializes only its validated local payload. Only reviewed public upstream
  repositories and immutable tag or commit identities are passed to third-party
  Skill acquisition tools.
- Chezmoi is deterministic and recoverable but not a multi-target atomic
  transaction. The design adds a narrow pre-change snapshot and exact owned-path
  restore rather than recreating a general transaction manager.
- Git commit identities provide the immutable Profile acquisition boundary.
  Branches remain a human-facing update selector: normal apply consumes the
  locally locked commit, while an explicit Profile update resolves the branch
  again. This keeps ref movement out of routine reconciliation without adding a
  custom remote package service.

## Alternatives considered

- **Ruler** is a useful project-centric configuration distributor, but its
  Skills/subagent support and physical-copy behavior overlap with Rulesync and
  do not satisfy the one-copy host projection as cleanly.
- **Gaal** is close to the desired all-in-one shape, but the evaluated v0.3.0
  was pre-1.0, small-community, AGPL, and still copied Skills. It is a useful
  reference, not the control-plane foundation.
- **Home Manager/Nix** provides stronger generations and rollback, but adds a
  substantially heavier runtime and learning model than required for these two
  hosts.
- **Aqua** is excellent for verified release binaries, but does not cover npm
  and Python dependency needs alone. mise's built-in Aqua backend retains its
  relevant verification without installing a second package manager.
- **OpenAI Symphony** is relevant to persistent unattended task queues and
  dependency DAGs, not to global instruction deployment. It remains optional
  until a real cross-session queue requirement appears.
- A custom compiler, graph runtime, package manager, and transaction installer
  were rejected because maintained native tools already own those jobs.

## Recent research, interpreted conservatively

- [Configuration Smells in AGENTS.md](https://arxiv.org/abs/2606.15828)
  identifies context bloat, Skill leakage, lint leakage, blind references,
  initialization fossilization, and conflicting instructions. It motivates the
  small kernel, native Skills, and reference validation; its repository sample
  does not establish universal causal effects.
- [Do AGENTS.md Files Actually Help Coding Agents?](https://arxiv.org/abs/2605.10039)
  found no detectable effect for several configuration dimensions in its tested
  Claude Code conditions and observed compliance decay within sessions. This
  argues for behavioral tests and deterministic enforcement, not for claiming
  that file shape alone guarantees behavior.
- [Progressive disclosure research](https://arxiv.org/abs/2607.17598) suggests
  that a flat one-level structure can outperform unnecessary depth in some
  agent settings. The private environment therefore uses one reference level;
  deeper hierarchy requires measured need.

These papers are recent preprints, not settled industry standards. The adopted
architecture rests primarily on official host semantics and repeatable local
fixtures; the papers inform risk checks rather than dictate the design.

## APM package-engine validation

PAC evaluated [Microsoft APM 0.28.0](https://github.com/microsoft/apm/releases/tag/v0.28.0)
against its official [install](https://microsoft.github.io/apm/reference/cli/install/),
[uninstall](https://microsoft.github.io/apm/reference/cli/uninstall/),
[update](https://microsoft.github.io/apm/reference/cli/update/), and
[target matrix](https://microsoft.github.io/apm/reference/targets-matrix/)
documentation and the pinned release binary on Linux.

Disposable fixtures established the following boundaries:

- `--root` with the `agent-skills` target creates one neutral
  `.agents/skills` deployment and a lock containing per-file hashes and owners;
- `--frozen` reproduces a reviewed manifest and lock without refreshing refs;
- virtual repository subdirectory dependencies install only the selected Skill
  and avoid unrelated Agents or commands from the same upstream repository;
- APM can parse Plugin packages into portable primitives but does not perform
  the native Codex or Claude Plugin registration lifecycle;
- APM 0.28.0 audit does not correctly address a separate `--root` deployment,
  so PAC must verify the pinned lock's hashes and ownership itself; and
- `--force` combines collision overwrite with security-policy bypass and is
  therefore never an implicit PAC option.

PPT Master exposed a separate scale limit. Its v4.3.0 Skill directory contains
12,230 files. APM created a roughly 7.1 MB lock with 134,890 lines, then its own
safe loader rejected that lock as a possible YAML expansion bomb. The failure
reproduced with PPT Master as the only dependency, so splitting the main graph
does not solve it. PAC keeps the security budget intact and delegates this one
large package to pinned Vercel Skills 1.5.22 until APM changes its lock
representation or parser. This is a measured compatibility exception, not a
second general package graph.

These results support APM as a package graph and deployment ledger, not as a
replacement for PAC's authority, transaction, taxonomy, host-adapter, or native
Plugin responsibilities.

## Requirement-intake evidence

[Codex best practices](https://learn.chatgpt.com/guides/best-practices.md)
recommend Plan mode for complex or ambiguous work because it gathers context,
asks clarifying questions, and builds a plan; the same guide recommends making
goal, context, constraints, and the completion condition explicit. Claude
provides native question and read-only planning controls through its
[tools](https://code.claude.com/docs/en/tools-reference) and
[permission modes](https://code.claude.com/docs/en/agent-sdk/permissions).

[GitHub Spec Kit's clarify workflow](https://github.com/github/spec-kit/blob/v0.16.0/templates/commands/clarify.md)
prioritizes questions by impact and uncertainty, excludes trivial or already
answered items, and bounds the interaction to five questions asked one at a
time. [Kiro Quick Spec](https://kiro.dev/docs/specs/quick-spec/) similarly
front-loads clarifying scope, constraints, and edge cases while reserving its
full feature-spec workflow for larger work.

Two portable Skills were examined in detail:

- [Superpowers brainstorming](https://github.com/obra/superpowers/blob/v6.2.0/skills/brainstorming/SKILL.md)
  is mature but deliberately hard-gates every creative task, writes and commits
  a design document, and transfers control to its own planning lifecycle. That
  contract is too broad for PAC's stable global layer.
- [requirements-clarity](https://github.com/softaworks/agent-toolkit/tree/3027f20f3181758385a1bb8c022d4041dfb4de84/skills/requirements-clarity)
  is a focused MIT Skill for vague requirements and PRD generation. It has no
  stable release or independent eval suite, and its 90/100 score is subjective;
  PAC therefore pins the exact commit and treats it as an optional formal route,
  not the universal gate.

The resulting design is deliberately hybrid: a tiny global clarity invariant,
native host interaction for ordinary ambiguity, and an on-demand formal Skill
only when its heavier output is actually requested.

## Human-reviewable response evidence

The response contract also audited
[ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd), an MIT response
style created in May 2026 and actively maintained at the reviewed commit. At
review time it had roughly 17,800 GitHub stars and 1,000 forks. Its useful core
is simple: put the actionable result first, number real sequences, suppress
tangents and filler, keep current state visible, rank long lists, and remove
empty recap or closing invitations.

The project has more evidence than a typical prompt-only Skill, including unit
tests, cross-runtime Hook tests, a paired/blinded evaluation harness, and
published results in [issue 97](https://github.com/ayghri/i-have-adhd/issues/97).
In 14 cases with three trials, the reported weighted score rose from 4.045 to
4.473; actionability and concision improved most. The run still failed its own
release gate, used one model family for generation and judging, and had only
three trials per case.

The open issue record is important negative evidence. A literal five-item cap
has omitted relevant findings, and an unconditional instruction to state cause
and fix produced an unsupported cause in a partial-success case. PAC therefore
adopts the response *shape* but not those completeness- or certainty-reducing
demands. The first line may be an answer or confirmed result rather than always
an action; full explanation and exhaustive review remain available when the
task requires them.

The repository's always-on Hook is not a cross-host primitive. PAC installs
only the exact portable Skill subdirectory as an explicit style and leaves the
adaptive, safety-preserving baseline in the small global kernel.
