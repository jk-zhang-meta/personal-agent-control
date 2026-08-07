---
name: graph-workflow
description: Plans and coordinates multi-stage work as a dependency-aware graph using the host's native planning, task, delegation, and recovery capabilities. Use when the user explicitly requests graph mode, or when work has material dependencies, repeated parallel waves, persisted evaluation, monitoring, or cross-session recovery. Do not use for ordinary serial edits, simple edit-then-test tasks, or one bounded parallel wave. Never implement a new scheduler or graph runtime unless the user explicitly approves it after a documented capability gap.
---

# Graph Workflow

Act as the sole coordinator. Represent dependencies explicitly while preserving
the autonomy of each worker. Read
[GRAPH_CONTRACT.md](references/GRAPH_CONTRACT.md) before creating a graph. Read
[RECOVERY_AND_EVALUATION.md](references/RECOVERY_AND_EVALUATION.md) only for a
pause, failure, retry, recovery, evaluator path, or a documented native
capability gap that requires tool selection.

## Select the execution surface

Use `auto` unless the user explicitly selects `native` or `durable`. In `auto`,
use the host-native surface unless the run must survive the current session,
wait durably for an external event, run on a schedule, share authoritative state
across processes or machines, or provide checkpoint/replay. Those are hard
durability requirements. Complexity, node count, agent count, and estimated
duration alone are not.

Apply the deterministic policy in
[`scripts/select-execution-surface.mjs`](scripts/select-execution-surface.mjs)
when a machine-checkable decision is useful, and read
[`DURABLE_RUNTIME_ADAPTER.md`](references/DURABLE_RUNTIME_ADAPTER.md) before
using a durable provider.

1. Inspect the planning, task, delegation, dependency, persistence, and resume
   capabilities already exposed by the current host.
2. Use those native capabilities when they satisfy the task. Map this contract
   to their real states and identifiers; do not create a parallel source of
   truth.
3. Select a ready, approved durable provider only for a hard durability
   requirement or an explicit `durable` override. If it is unavailable, stop;
   never silently downgrade a durable run to native. Reject an explicit
   `native` override that contradicts a hard durability requirement.
4. If a required capability is absent, evaluate maintained existing tools
   against the exact gap before proposing an addition. Prefer the narrowest
   mature option that integrates with the current host.
5. Obtain user approval before installing a workflow service, adding a project
   dependency, or introducing an external control plane.
6. Do not write a scheduler, state database, daemon, task engine, or wrapper as
   a fallback. PAC may install or expose an approved provider, but it never owns
   task execution state or becomes a task runtime. Custom implementation
   requires an explicit user request after reporting why native and maintained
   options cannot satisfy the requirement.

For interactive work, prefer the host's native plan/task and sub-agent tools.
For tracker-driven autonomous Codex work, evaluate OpenAI Symphony. For an
application-level durable agent graph, evaluate a maintained graph/workflow
runtime such as LangGraph or Temporal. Confirm current capabilities from
official documentation rather than assuming compatibility.

## Build and execute the graph

1. Define the goal, observable completion oracle, scope, authority boundaries,
   and exact deliverables.
2. Create the smallest nodes with independently verifiable outcomes. Record
   each node's goal, prerequisites, owner, inputs, owned artifacts, applicable
   skills, stop condition, state, and oracle.
3. Validate that the graph is acyclic. Keep dependent work blocked until every
   prerequisite is verified complete.
4. Dispatch only ready, non-conflicting nodes. Use the host's native task ID or
   session ID as execution identity.
5. Require each worker to return outcome, evidence, changed artifacts, checks,
   uncertainty, blockers, and suggested next action.
6. Treat worker completion as a claim. The coordinator checks artifacts and the
   node oracle before changing the authoritative task state.
7. Integrate at dependency waves and run one graph-level verification before
   handoff.

Keep canonical writes and graph mutation with the coordinator unless isolated
ownership is explicit. Load specialist skills only for the nodes that need
them. Do not add graph ceremony to a task that becomes simpler when executed
serially.

## Pause and finish

Use the host's native persistent task list, session resume, or approved external
tracker as the checkpoint. Reconcile task state with artifacts and live workers
after resuming. If the chosen surface cannot persist the required state, report
that limitation and propose an existing tool; do not silently simulate a
durable runtime.

Finish only when required nodes and the graph-level oracle pass, terminal
failures are explained, and remaining uncertainty is disclosed.
