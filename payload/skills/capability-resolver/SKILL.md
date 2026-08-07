---
name: capability-resolver
description: Searches the PAC-managed capability catalog and returns ranked, explainable Skills, Plugin providers, and subagents. Use when no clearly matching Skill is already selected, several domains overlap, the installed catalog is too large or ambiguous to inspect reliably, or the user asks what capabilities are installed. Do not use for routine tasks with an obvious Skill, installation of remote capabilities, execution, or authority and security decisions.
---

# Capability Resolver

Use this Skill as an on-demand catalog lookup. It supplements native Skill
discovery; it is not an automatic semantic router, installer, execution engine,
scheduler, or security boundary.

## Resolve a task

1. Skip lookup when an explicit user invocation or one clearly matching native
   Skill already determines the route.
2. Describe the task, required outcome, and useful hints in JSON. Do not put
   runtime facts such as the host name in the JSON; pass the verified host with
   `--host`.
3. Run the read-only resolver against the installed database. Replace `codex`
   with `claude` when that is the active host.

```sh
printf '%s\n' \
  '{"task":"Build an accessible React dashboard","needs":["visual design","React performance"],"hints":["responsive","keyboard navigation"]}' \
  | "$HOME/.local/bin/mise" \
      --cd "$HOME/.local/share/personal-agent-control" exec -- node \
      "$HOME/.local/share/personal-agent-control/payload/skills/capability-resolver/scripts/capability-resolver.mjs" \
      resolve --host codex \
      --db "$HOME/.cache/personal-agent-control/capabilities-v1.sqlite" \
      --stdin
```

4. Select the smallest non-conflicting set that covers the task. Treat rank and
   explanation as advice, not permission or proof of applicability.
5. Follow each selected result according to its kind:

   - **Skill:** read the returned `SKILL.md` completely before acting. If its
     activation policy is `explicit-only`, use it only after the user explicitly
     invokes it or requests that exact mode.
   - **Subagent:** delegate through the active host's native agent mechanism.
   - **Plugin:** use the host-native Plugin activation, then select the bundled
     Skill identified by the provider/child relationship. A Plugin is a package
     provider, not a Skill by itself.

Plugin providers are explicit-only: add `--kind plugin` when the user asks for
a package or provider. Ordinary resolve searches Skill and subagent leaves.

Standalone Skill identity and description come from the validated frontmatter
in PAC's neutral deployed Skill store. `catalog/capabilities.jsonl` adds only
logical routing, target, visibility, dependency, activation-policy, and delivery-engine metadata; package
source, revision, and content integrity remain owned by APM's manifest and
lock. The delivery engine is normally APM; an explicit exception can still
materialize into the same neutral inventory. Native Plugin providers and their child relations remain declared by the
Plugin catalog. Machine dependencies in `catalog/tools.tsv` are not task capabilities and are
not returned by v1 lookup. MCP or App providers fail closed and remain absent
from lookup until a reviewed runtime overlay admits their provider/child
relation and native handle; this resolver does not translate or execute their
protocols.

Task text can match several taxonomy categories automatically; category
membership is nonexclusive and does not suppress the global metadata channels.
Use the returned capability ID, provider, activation contract, resource,
structured evidence, and index revision when explaining a non-obvious choice.
Each evidence item names its channel, request fragment, matched metadata field
and value, and category path when applicable. Never infer authority from a
result.

## Browse a category

Browse is useful when the user asks what is installed or when a broad task
needs a quick inventory before a focused resolve:

```sh
"$HOME/.local/bin/mise" \
  --cd "$HOME/.local/share/personal-agent-control" exec -- node \
  "$HOME/.local/share/personal-agent-control/payload/skills/capability-resolver/scripts/capability-resolver.mjs" \
  browse --host codex \
  --db "$HOME/.cache/personal-agent-control/capabilities-v1.sqlite" \
  --category domain.software
```

## Stale or unavailable index

Resolve and browse need only `--host` and the local `--db`; they never inspect
or mutate repository content. The executable itself comes from the canonical
PAC source, not the mutable installed Skill projection. PAC installation owns
index construction. Its `rebuild` command receives explicit `--repo`, `--home`,
and `--db`, runs only after standalone Skills and Plugins are reconciled. The
metadata validator can receive the exact neutral store with `--skill-root`; the
runtime rebuild derives that root from `--home`. It then
atomically replaces the derived database. The index contains only bounded
catalog/overlay/taxonomy and Skill-frontmatter name/description metadata, never
full Skill bodies. Doctor uses the corresponding read-only `check` command.

If lookup reports a missing, corrupt, or stale index, do not download a
capability or silently rebuild from another source. Report the condition and
run the normal PAC update/apply workflow when that operation is in scope. A
restore intentionally removes the derived database and SQLite sidecars; run
normal PAC apply before using this resolver or starting fresh agent sessions.
