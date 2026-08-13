# Durable Runtime Adapter

## Seam and Interface

`WorkflowExecution` is a deep Module at the execution-surface Seam. The main
agent uses three operations; an Adapter owns all provider-specific behavior:

```text
start(request) -> run reference
inspect(run reference) -> run snapshot
signal(run reference, event) -> run snapshot
```

`start` receives the approved workflow name, bounded input, declared runtime
requirements, execution mode (`auto`, `native`, or `durable`), and an
idempotency key. A run reference contains the Adapter identity, authoritative
provider, and opaque provider run ID. `inspect` is read-only. `signal` covers
resume, approval, and cancellation and carries the expected run revision.

The Interface has these invariants:

- one run has exactly one authoritative state owner;
- PAC never mirrors checkpoints, node state, attempts, or queues;
- `auto` chooses native unless a hard durability requirement is declared;
- compute-job lifetime alone is not a workflow durability requirement;
- complexity and estimated duration alone never choose durable execution;
- a hard durable run never silently falls back to native;
- starting a run never implicitly installs, deploys, or authorizes a provider;
- Adapters accept registered workflows, not arbitrary graphs that would require
  PAC to implement a scheduler or task interpreter.

Expected error modes are `EXECUTION_POLICY_INVALID`, `DURABILITY_CONFLICT`,
`DURABLE_SURFACE_UNAVAILABLE`, `NATIVE_SURFACE_UNAVAILABLE`, provider-level
`UNSUPPORTED_WORKFLOW`, and provider-level `RUN_NOT_FOUND` or `RUN_CONFLICT`.

## Adapters

The Native Adapter maps the graph contract directly to the active host's plan,
task, delegation, and resume facilities. Host task or session IDs are its run
IDs, and the host remains the state authority.

A durable Adapter such as a reviewed LangGraph integration maps the same three
operations to a pre-registered durable workflow. It hides state schemas,
checkpointers, retry policy, interrupts, deployment location, and provider error
translation. The provider remains the state authority. LangGraph is therefore
an escalation Adapter inside `graph-workflow`, not PAC's final handler for every
task.

## Deterministic selection

The local selector is pure policy and has no provider client or side effects:

```js
import { selectExecutionSurface } from '../scripts/select-execution-surface.mjs';

const selection = selectExecutionSurface({
  mode: 'auto',
  requirements: [
    'workflow-survive-process-restart',
    'automatic-post-event-continuation',
  ],
  availability: { native: true, durable: true },
});
// selection.surface === 'durable'
```

The selector accepts only `mode`, `requirements`, and `availability`; unknown
fields fail closed so a misspelled requirement cannot silently select native
execution. `availability.durable` means that configuration, authorization,
health, protocol compatibility, the registered workflow, and support for every
declared requirement have already been verified. It is not package presence.

Selection is not execution. After selection, retain the provider capability
evidence and call `start` through the chosen Adapter.
