# Recovery and Evaluation

## Capability routing

Prefer capabilities already owned by the current host:

- Interactive Codex work: native planning and sub-agent coordination tools.
- Interactive Claude work: native tasks, subagents, or Agent Teams when enabled
  and appropriate.
- Tracker-driven, long-running Codex automation: evaluate OpenAI Symphony.
- Durable application-level agent workflows: evaluate a maintained graph or
  workflow runtime such as LangGraph, Temporal, Dapr, or Restate.

These products evolve. Verify current official documentation, installation
requirements, persistence guarantees, and host compatibility before choosing.
Do not install or implement anything solely from this illustrative routing list.

## Failure handling

Classify a failed node before deciding what happens next:

- **Transient:** retry through the authoritative tool after a temporary tool,
  process, or connection failure.
- **Semantic:** change the approach or evidence before retrying.
- **Blocked:** record the exact missing input or external-state condition.
- **Terminal:** preserve the evidence and report why the goal cannot be met in
  scope.

Do not repeat an unchanged semantic attempt. If two attempts add no evidence,
re-plan once; if the revision also adds none, stop and report the blocker.

## Pause and restart

Before pausing, use the selected tool's native checkpoint, task persistence, or
tracker state. On resume:

1. Reopen the authoritative task surface.
2. Reconcile running or interrupted work with live sessions and artifacts.
3. Preserve prior attempt evidence.
4. Resume only nodes whose prerequisites remain complete.

If native state cannot survive the required interruption, do not invent hidden
state files. Propose a maintained persistence-capable tool and obtain approval.

## Evaluator path

Use a bounded acyclic path when independent evaluation is required:

```text
builder
  -> deterministic verification
  -> independent evaluator
  -> optional targeted correction
  -> one re-evaluation
```

Give the evaluator the original goal, constraints, evidence, exact artifact,
and stable artifact identity when available. Keep evaluation read-only and
initially withhold the builder's conclusion when practical. Findings include
severity, exact evidence, correction/check, and confidence. Deterministic checks
outrank reviewer opinion; any material artifact change invalidates prior review.
