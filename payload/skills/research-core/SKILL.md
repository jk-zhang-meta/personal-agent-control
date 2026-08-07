---
name: research-core
description: Routes and executes academic literature searches, evidence reviews, systematic or scoping reviews, citation audits, and practitioner-experience evidence gathering with proportional rigor and traceable claims. Use when the user explicitly asks for scholarly papers, references, academic evidence, research synthesis, research gaps grounded in sources, systematic/scoping/rapid review, citation verification, practitioner evidence, or 论文、文献、科研综述、证据检索. Do not use for ordinary codebase exploration, debugging, dependency or API documentation lookup, product recommendations, generic web search, or software implementation unless the user explicitly asks for an evidence review.
---

# Research Core

Route academic and practitioner evidence work without changing the existing software workflow. Apply only the rigor needed for the requested conclusion.

## Guard the boundary

- Return ordinary code exploration, debugging, implementation, dependency lookup, and API documentation tasks to the existing software workflow. Do not create research artifacts for them.
- For mixed research-and-code work, complete and verify the evidence result first, then pass it into the software workflow as an input.
- Treat an answer/review request as read-only. Create project artifacts only when the user asks to establish or update durable research state.
- Follow the closest project `AGENTS.md`; it may strengthen domain, privacy, review, or validation rules.

## Select the rigor mode

Choose one mode before searching and state it when the distinction affects the result:

| Mode | Use for | Conclusion ceiling |
|---|---|---|
| Quick | Orientation, terminology, initial papers, practitioner reports | Non-exhaustive findings, scoped facts, hypotheses, and leads |
| Evidence Review | Bounded comparisons, design input, rapid evidence assessment | Qualified synthesis within explicit sources, dates, and limitations |
| Formal | Scoping/systematic review, meta-analysis, clinical-effect or other high-stakes conclusions | Only conclusions permitted by the selected formal methodology |

Allow Quick searches to evolve, but record material pivots and never claim completeness. Document every shortcut in an Evidence Review. Freeze or register a Formal protocol when the applicable methodology requires it; record amendments and never stop merely because a target paper count was reached.

Read [references/method.md](references/method.md) for Evidence Review or Formal work, durable artifact schemas, screening, appraisal, or synthesis. Read [references/tools-and-safety.md](references/tools-and-safety.md) before using external APIs/plugins, handling full text, or touching clinical, genomic, confidential, or licensed material.

## Run the workflow

1. **Define the question and conclusion ceiling.** Identify the decision, population or scope, outcome/metric, time range, evidence unit, and what the available method may legitimately conclude.
2. **Check readiness and authority.** Resolve the exact project root when durable state is requested. Classify public, private, licensed, confidential, and regulated inputs before any external call.
3. **Set the protocol.** Record the mode, sources, inclusion/exclusion rules, reviewer policy, synthesis method, resource cap, stopping condition, and known blind spots at the detail required by the selected mode.
4. **Search complementary lanes.** Distinguish discovery databases, registries, metadata services, full-text access, citation graphs, implementation evidence, and practitioner sources. Save exact source, platform, query, date, restrictions, and result count whenever completeness or reproducibility matters.
5. **Normalize and relate evidence.** Use stable report identifiers, deduplicate records, and independently group preprints, proceedings, journal versions, registrations, supplements, or follow-ups into an `evidence_unit_id`. Never use a citekey or DOI as the study/work identity by itself.
6. **Screen and extract.** Preserve exclusion reasons and reviewer decisions. Apply the selected mode's independent review or verification policy. Ground material claims in the original full text, data, code, standard, or first-hand report.
7. **Appraise and synthesize.** Separate evidence direction, study-level bias, applicability/directness, and body-level certainty. Preserve null, negative, conflicting, and missing evidence. Never vote by paper count.
8. **Audit the output.** Verify identifiers, exact locators, versions, corrections, expressions of concern, and retractions across appropriate sources. Say “not found” rather than claiming a status was proven absent.
9. **Hand off mixed work.** Convert verified research conclusions into hypotheses, constraints, acceptance criteria, and falsifiers before entering the existing code or experiment workflow.

## Persist only what the task authorizes

- For answer-only work, return a cited answer with scope, dates, limitations, and unresolved points; write nothing.
- For a durable Quick project, use one `RESEARCH.md` unless the existing project has a better convention.
- For a durable Evidence Review, add `sources.tsv`, `claims.yml`, and a generated `references.bib` only when needed.
- For Formal work, add immutable `runs/<run-id>.json`, design-specific appraisal/extraction state, and source notes only for evidence that materially affects a claim.
- Reuse an existing `deep-research/` or documentation convention instead of creating a parallel tree.
- Keep PDF working copies, OCR, API responses, cursors, indexes, caches, and logs in the synchronized runtime or a task-specific `~/.agent-work` directory.

## Complete with an observable oracle

- Map every material claim to a source and a precise locator appropriate to that source.
- Distinguish source statements, author interpretations, third-party interpretations, and agent inference.
- Report the exact sources searched, dates, restrictions, failed lanes, and blind spots at the selected rigor level.
- Confirm that no secret, PHI, confidential text, restricted full text, or runtime artifact entered a synchronized project or unauthorized external service.
- For Formal work, apply the relevant domain method rather than treating this skill as a substitute for Cochrane, JBI, PRISMA-family reporting, GRADE, or another field-specific standard.
