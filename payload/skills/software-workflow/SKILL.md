---
name: software-workflow
description: Routes substantive software writing, debugging, design, refactoring, testing, frontend implementation, and code review to the minimum applicable engineering Skills. Use for any task that changes or assesses software source, module responsibilities, runtime behavior, or rendered web UI; do not use for simple codebase lookup with no implementation or review.
---

# Software Workflow

Inspect the exact target and affected flow, define a runnable success criterion,
then load only the applicable leaf Skills below.

## Select the minimum set

- Writing, fixing, or refactoring code: use `ponytail` after tracing the real
  flow.
- Diagnosing a bug, failure, regression, or performance problem: use
  `diagnosing-bugs`.
- Changing a module contract, responsibility, dependency direction, seam,
  public API, or materially large source file: use `codebase-design`.
- Test-first or red-green-refactor explicitly requested by the user: use `tdd`.
- Correctness or standards review of a diff, whole tree, or exact artifact:
  have the main agent invoke the configured native read-only `independent-reviewer`
  agent with the frozen goal, constraints, evidence, and immutable artifact
  identity. This is an agent route, not a review Skill.
- PR or diff review specifically for needless complexity: also use
  `ponytail-review`. For whole-tree or exact-artifact simplicity review, add
  that criterion to `independent-reviewer` instead.
- Web UI/UX or visual implementation: use `frontend-design`; for React or
  Next.js also use `vercel-react-best-practices`, and for reusable React
  component APIs also use `vercel-composition-patterns`.

Do not invoke a leaf merely because it is installed. When several apply, state
the role of each and keep one lifecycle owned by the main agent.

## Engineering floor

Fix the shared root cause with the smallest coherent change. Preserve existing
work and repository conventions. Name the owner and narrow contract of every
new responsibility; do not append unrelated behavior to a convenient large
file. Verify with the strongest proportionate deterministic checks and a real
runtime or rendered path when behavior changes.
