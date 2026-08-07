---
name: research
description: Researches a question against high-trust primary sources and returns either a cited answer or an authorized Markdown artifact. Supports inline investigation and delegated independent source lanes. Use for current documentation, API behavior, product or technical comparisons, evidence-backed recommendations, or source-gathering requests. Do not use for routine local codebase lookup, debugging, implementation, or formal scholarly/systematic reviews handled by research-core.
---

# Research

For domain-specific evidence standards, read
[references/epistemic-methods.md](references/epistemic-methods.md) only when the
claim depends on mathematics, algorithms, reproducible software/AI/ML evidence,
empirical science, psychology, literature, philosophy, music, or creative work.

## Choose the contract

Classify two independent dimensions before searching:

- **Deliverable:** `answer` by default; use `artifact` only when the user requests
  a durable file or the active workflow already authorizes one.
- **Execution:** `inline` by default; use `delegate` only when the user requests
  delegation or an active workflow explicitly authorizes subagents and the
  reading can proceed independently.

Do not create a repository file for an answer-only request. For artifact mode,
resolve the exact project root and output path before writing.

## Research

1. Restate the decision or question and define what evidence would answer it.
2. Prefer sources that own the claim: official documentation, specifications,
   source code, first-party APIs, standards bodies, or original papers/data.
3. Verify changeable facts at execution time. Record relevant publication,
   release, or access dates and distinguish sourced fact from inference.
4. Cross-check material claims when one source is incomplete, ambiguous, or
   self-interested. Do not imply completeness beyond the search performed.
5. Cite each material claim close to the supporting source. Quote sparingly and
   preserve source meaning.

In delegate mode, give each researcher a bounded question, source policy,
deliverable, evidence format, and stop condition. Keep independent source areas
separate, then verify and synthesize their results in the main context. A
delegate's summary is not evidence without inspectable sources.

## Deliver

For `answer`, respond directly with the conclusion, supporting evidence,
citations, and remaining uncertainty.

For `artifact`, write one concise Markdown file at the authorized path, matching
the repository's existing convention. Include the question, findings, citations,
dates, inferences, and unresolved gaps. Return the path and a one-line summary.
