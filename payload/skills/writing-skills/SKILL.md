---
name: writing-skills
description: Authoring discipline for Claude/Codex Agent Skills — description craft, progressive disclosure, routing/triggering, evaluation, packaging — so a skill is discovered and used. Use when creating or editing a SKILL.md, choosing a skill's description or when-to-use, debugging why a skill does or does not trigger, deciding how a skill should route, or reviewing a skill for quality. For scaffolding a new skill folder a host's built-in skill-creator does the boilerplate; this adds routing, evaluation, and cross-host review on top.
license: MIT
---

# Writing Skills

How to make a skill that Claude/Codex discovers, triggers, and follows as reliably as routing
allows. Distilled from Anthropic's skill-authoring best practices, the open Agent Skills spec,
and routing/eval practice.

A skill is **one capability** as a folder: a `SKILL.md` (YAML frontmatter + markdown body) and
optional reference files/scripts. On Anthropic hosts it loads by **progressive disclosure** (the
portable default; other hosts vary in the details): only `name` + `description` sit in context
at startup (~100 tokens **per skill**); the body loads when triggered; reference files and
scripts load only when read or run.

**Scope (YAGNI):** run the full workflow for a **new or behavior-changing** skill; for a typo or
mechanical edit, skip the ceremony. For scaffolding a brand-new folder, a host's built-in
**`skill-creator`** does the boilerplate — this skill is the routing, evaluation, and cross-host
review discipline layered on top, not a second scaffolder.

## Authoring workflow

1. **Write evals first.** Run the agent on ~3 representative tasks *without* the skill and record
   the failures; they define what the skill must fix and how you'll know it worked.
2. **Draft the description** — the single most important line; it is the router (below).
3. **Draft the body** to close exactly those failures: minimal, concrete, one capability.
4. **Test triggering + behavior** (see Evaluate); iterate description and body.
5. **Review** (independent model if available) and package.

## The description is the router — write it well

The description is matched against the request to decide whether to load the skill. State **what
it does AND when to use it**, in the **third person**, and **front-load the decisive trigger
words** (hosts truncate listings).

- ✓ `Extract text and tables from PDFs, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or extraction.`
- ✗ `Helps with documents.` (no trigger signal) · ✗ `I can help you…` (first/second person)

Rules:
- List **concrete trigger branches**: file types, user phrases, task shapes.
- **Tune against positive AND negative prompts** — models can over-trigger as well as
  under-trigger; measure, don't assume.
- **Avoid overlap** with other skills; overlap creates routing ambiguity. If two could both fire,
  state in each how it differs and which wins.
- Cap: `description` ≤ **1024 chars** (open spec, portable). (Claude Code additionally applies a
  configurable ~1536-char *listing* cap on `description` + optional `when_to_use` — not a
  frontmatter limit.)

## Routing: pick the least determinism that is reliable enough

Triggering is model-driven and **nondeterministic** by default. Escalate only as far as the
cost-of-missing demands:

| Rung | Mechanism | Use when |
|---|---|---|
| Pure model-invoked | description only | the trigger is distinctive/unambiguous (e.g. "create a skill") |
| Prompt-directive | an always-on line: "for task class X, load skill Y" | a whole task class must reliably load it |
| User-invoked | slash / `$skill` explicit call | fires only on demand; to also drop its catalog cost, exclude it from model routing (Claude Code `disable-model-invocation`, Codex `allow_implicit_invocation:false`) — a slash command alone doesn't guarantee zero tax |
| Hooked | session-start / pre-task hook injects it | zero-miss is required and worth an always-on tax |

Don't hard-wire what a good description already routes; don't trust a description for a zero-miss
guarantee.

## Progressive disclosure — keep context lean

- **SKILL.md body < ~500 lines** (Level 2; loads on every trigger). Spend tokens only on what the
  agent cannot assume.
- Push detail into **reference files** (Level 3): loaded only when read → zero cost until used.
  Keep them **one level deep** (agents read nested links incompletely); add a table of contents
  to any reference over ~100 lines.
- Prefer **scripts** for fragile/deterministic steps: when a script is run without being read,
  only its output enters context. "Solve, don't punt" — handle errors in the script.
- "The context window is a public good." For each line, ask whether the agent truly needs it.

## Match instruction freedom to task fragility

- **High** (prose) — many valid approaches: "review: analyze structure, check bugs, suggest fixes."
- **Medium** (pseudocode / parameterized template) — a preferred pattern, variation acceptable.
- **Low** (exact script, "run this, don't modify") — fragile/critical steps needing consistency.
  Frame low-freedom as bridges-with-cliffs, high-freedom as open fields.

## Evaluate — turn "feels right" into a number

- **Trigger rate:** run each representative prompt **≥3× as a smoke-test floor** — 3/3 is not
  proof — a one-sided 95% lower bound is only ~37%; scale repetitions to the confidence you need. Use
  **fresh, isolated sessions**, compare **skill-enabled vs skill-disabled** baselines, record the
  **model/version and an observable activation signal**, include **negative** prompts that must
  *not* fire, and test only the **surfaces you actually target** (authoring-session context can
  mask a weak skill).
- **Behavior:** define specific expected behaviors, not vague outcomes; a small model exposes
  under-specification, a large one exposes over-explaining.

## Naming, portability, safety, anti-patterns

- **Name:** kebab-case (lowercase, digits, single hyphens; no leading/trailing/consecutive
  hyphens), ≤64 chars, and it **must match the skill's folder name**; prefer a gerund or clear
  noun phrase (`writing-skills`, `pdf-processing`); avoid `helper`/`utils`/`tools`.
  *Anthropic-specific* (honor for portability): no reserved `claude`/`anthropic`, no XML tags.
- **Portable:** no time-sensitive claims (use a collapsible "old patterns" note); forward slashes,
  never Windows paths; list required packages; reference MCP tools by the exact host-exposed
  qualified name (e.g. Claude SDK `mcp__<server>__<tool>`), not a made-up prefix.
- **Safety:** use skills only from **trusted sources** and **audit every bundled file** before
  installing — SKILL.md, scripts, reference docs, images/assets, anything fetched from the
  network, and declared dependencies — a skill can direct the agent to run code. Independent
  review is defense-in-depth, not a guarantee.
- **Anti-patterns:** vague or overlapping descriptions · options with no default · deeply nested
  references · assuming packages are installed · one skill doing many things.

## Hosts & scopes

- **Claude Code:** `~/.claude/skills/` (personal), `.claude/skills/` (project, VCS-shared), plus
  plugin and enterprise scopes.
- **Codex:** `~/.agents/skills/` (user), `.agents/skills/` (repo — ancestor dirs scanned up to the
  repo root), `/etc/codex/skills/` (admin).
- **API / claude.ai:** uploaded, not filesystem-based. Surfaces mostly **don't auto-sync** (a
  filesystem skill is separate from an API/claude.ai one), though some bridge — e.g. cloud/Cowork
  sessions can load claude.ai-enabled and repo `.claude/skills`.

## Packaging and provenance

Keep one canonical copy of each Skill and project it to hosts with native links
or adapters. Record the reviewed source, immutable revision, license, expected
identity, and required tools for every upstream Skill. Do not fork or vendor an
upstream Skill merely to rename it or adapt a host-specific detail; put stable
cross-host policy in the global router instead.
