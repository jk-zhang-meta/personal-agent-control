# Graph Contract

## Responsibility boundary

The main agent is the sole coordinator. The selected host-native task system or
approved external orchestrator is the authoritative source for dependencies and
state. Workers execute bounded nodes and return evidence; they do not mutate the
graph or declare their own work verified.

Do not maintain a second database, ledger, or shadow task list. Project
deliverables remain in the verified project root; runtime state remains wherever
the selected tool owns it.

## Node contract

Each material node has:

- a stable task or session identifier;
- one concrete goal and stop condition;
- material prerequisites;
- inputs and exact owned artifacts;
- applicable skills and assigned worker/model/effort;
- an observable completion oracle;
- one authoritative state and available attempt evidence.

Use the state vocabulary supported by the host and preserve these semantics:

```text
pending --prerequisites complete--> ready --dispatch--> running
running --artifact and oracle pass---------------------> completed
running --missing input or external state-------------> blocked
running --execution or oracle failure-----------------> failed
failed  --changed approach or transient retry---------> ready
```

Only `ready` work may start. `completed` requires coordinator verification, not
a worker message. Record the exact unblock condition for `blocked`. A retry is a
new attempt and must preserve prior evidence when the host supports attempt
history.

## Result-bearing node contract

A submission node may complete with a stable run reference when submission is
its whole declared goal. A result-bearing node may not. It remains `running`
while the external work is submitted, queued, running, or awaiting its declared
result after execution terminates.

A result-bearing node is verified only when all three conditions hold:

- the authoritative execution system reports terminal success;
- exact-attempt result evidence exists and is attributable to the declared run,
  code, configuration, data, model, and randomness identities; and
- the result oracle passes its required artifact, schema, completeness, digest,
  freshness, and finite-metric checks.

Preserve these outcome semantics even when the host uses different state names:

```text
submitted, queued, or running--------------------------> running
terminal success, result within bounded publish grace--> running
terminal success, result missing or invalid------------> failed
terminal success, exact result and oracle pass----------> completed
terminal execution failure------------------------------> failed
execution or result authority unavailable--------------> blocked
```

A negative or neutral scientific finding is still a verified result when its
evidence passes the oracle; do not retry merely to obtain a preferred finding.
Provider-native infrastructure retries remain visible attempt evidence.
Changing code, configuration, data, model, or randomness is a new semantic
attempt and must not overwrite the old result.

The external scheduler owns compute-job state, and the project-declared artifact
store owns result bytes. Keep the stable run reference in the authoritative host
task, external tracker, or project run record; PAC creates no scheduler, polling
daemon, mutable experiment database, or shadow state.

## Tool selection contract

Select in this order:

1. current host's native plan, task, delegation, dependency, and resume tools;
2. an already installed maintained capability;
3. a reviewed mature external tool approved by the user;
4. custom implementation only when the user explicitly requests it after the
   preceding options are shown insufficient.

Do not select a framework merely because graph terminology appears in the task.
Compare the actual missing capability, integration effort, operational burden,
maintenance status, and recovery oracle.

## Completion contract

The coordinator verifies required artifacts and the declared node oracle before
marking completion. Run integration verification after each dependent wave when
later nodes rely on the combined result. At handoff, report the authoritative
task surface, completed and unresolved nodes, checks, artifacts, and anything
not verified.
