# Research Method Contract

## Contents

- Rigor routing
- Retrieval and identity
- Review and appraisal
- Durable artifacts
- Verification

## Rigor routing

| Concern | Quick | Evidence Review | Formal |
|---|---|---|---|
| Protocol | Question, sources, date, limit | Predefined scope, sources, criteria, reviewer check | Frozen/registered when applicable; amendments recorded |
| Completeness claim | Never | Only within declared lanes and limits | Only as allowed by the formal method |
| Screening | Agent/user judgment | Persistent decisions plus independent spot-check or verification | Independent screening/extraction or the domain-required alternative |
| Appraisal | Obvious limitations | Design-specific quality checks | Formal risk-of-bias/applicability and, when appropriate, body certainty |
| Persistence | Usually none or `RESEARCH.md` | Source register, claims, bibliography | Full run, screening, extraction, appraisal, and update state |

Scope reviews may map evidence without rating effect certainty. State whether bias/certainty will be assessed and why. Rapid reviews must list every omitted or simplified formal step.

## Retrieval and identity

Classify services by role:

- Discovery databases find candidate records.
- Trial/study registries find ongoing, unpublished, or registered work.
- Metadata services normalize DOI and bibliographic data.
- Full-text services locate legally accessible content.
- Citation graphs support backward/forward chasing; they do not prove completeness.
- Code, issues, commits, standards, incident reports, and practitioner accounts form separate implementation/experience lanes.

Select domain sources rather than treating broad APIs as substitutes. For ML/CS, combine appropriate scholarly indexes or venue libraries with arXiv and code evidence. For clinical questions, choose appropriate bibliographic databases, registries, regulatory sources, and grey literature for the review type.

Use identifiers only for reports: DOI, PMID/PMCID, arXiv ID, registry ID, Zotero item key, or an explicit local fallback. Generate `evidence_unit_id` separately to group versions and multiple reports of the same study/work.

## Review and appraisal

Define `reviewer_policy`: calibration sample, title/abstract screening, full-text screening, extraction, conflict resolution, automation role, and exclusion-reason codes. Formal clinical work normally requires independent eligibility decisions and extraction or a methodologically accepted verification alternative.

For each material claim, separate:

- `evidence_direction`: supports, contradicts, null, or mixed;
- source and exact locator;
- study/design appraisal;
- directness and applicability;
- body confidence, using `not_assessed` unless a named framework was applied;
- missing and conflicting evidence;
- agent inference and rationale.

For quantitative synthesis, predefine evidence unit, outcome/metric, time point, effect measure, result-selection rule, missing-data handling, heterogeneity, and sensitivity analysis. Do not count supportive papers as a substitute.

## Durable artifacts

Use the minimum level the project needs:

- `RESEARCH.md`: question, mode/type, conclusion ceiling, scope, source plan, criteria, reviewer policy, synthesis plan, changes, findings, limits, and data boundary.
- `sources.tsv`: `source_id`, `report_id`, `evidence_unit_id`, stable identifiers, version relation, publication status, retrieval run, screening decision/reason, reviewer/date, funding/conflicts, and correction/retraction status.
- `claims.yml`: claim ID/text/type/scope, evidence direction, source IDs and locators, appraisal, directness, applicability, body confidence, missing evidence, inference, verifier, and date.
- `references.bib`: deterministic, cleaned, read-only snapshot generated from the approved Zotero collection or source set. Citekeys are output fields, not identity.
- `runs/<run-id>.json`: immutable Formal run manifest containing database/platform, coverage, exact final query, restrictions, date, counts, failures, export checksum, parent run, and tool version.

Keep raw responses, pagination, retries, downloads, OCR, indexes, and temporary extracts outside canonical source.

## Verification

- Confirm expected in-scope sentinels were found, but never call sentinel recovery true recall.
- Resolve or label every identifier; allow no fabricated or silently mismatched record.
- Eliminate duplicate evidence units after record deduplication and version grouping.
- Preserve all required exclusion reasons.
- Sample material claims and require 100% agreement between wording and locator; one failure triggers review of the same class.
- Check versions, corrections, and retractions at ingestion and before delivery.
- Report failures and uncovered lanes instead of silently degrading the method.
