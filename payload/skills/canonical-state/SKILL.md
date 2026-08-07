---
name: canonical-state
description: Resolves canonical source, OneDrive/GitHub and cross-machine boundaries, runtime placement, synchronization, large artifacts, and GPU ownership before mutation or execution. Use when work spans repositories, synchronized storage, WSL, macOS, servers, GPUs, generated data, builds, exports, or uncertain sources of truth.
---

# Canonical State and Runtime

Use this Skill before broad reads, synchronization, build, test, indexing,
export, mutation, conversion, training, service startup, or work spanning
OneDrive, GitHub, WSL, cloud, or GPU hosts.

- Resolve the exact target root and one writable authority per artifact class.
  The current directory, a mirror, or a synchronization result is not proof. A
  directory containing unrelated VCS roots is a container unless an explicit
  monorepo manifest says otherwise.
- Canonical durable state includes source, tests, documents, configuration,
  lockfiles, migrations, small stable inputs, manifests, and review history.
  Preserve user changes, originals, formulas, metadata, and unrelated files.
- Use Git/GitHub for versioned source and small stable artifacts. Use OneDrive
  for Office documents, private corpora, acquired PDFs or books, binary
  originals, media projects, and verified deliverables when the project
  declares it canonical there.
- Keep dependency trees, environments, caches, indexes, models, acquired or
  generated datasets, logs, test output, and intermediate builds outside
  synchronized roots. Prefer a task-specific `~/.agent-work/runtime/` path.
- On synchronized or Windows-backed roots, make durable edits in canonical
  state and use the verified project workflow before runtime consumption. Do
  not infer a project root from a broad container.
- Preserve lossy and binary originals, process disposable copies, and export
  only verified deliverables. Synchronization and version history are not an
  independent recoverable backup.
- Large data, models, checkpoints, retained experiment logs, and costly derived
  assets need a declared private store, retention rule, provenance or digest,
  and tested recovery. Version their manifest, immutable URI or revision,
  license, schema, and representative sample.
- Do not restructure synchronized or Windows-backed checkouts without an
  explicit request; stop attached processes first. Replacement export needs an
  exact target and recoverable backup.
- For a named GPU task, secure and device-verify a real allocation or reversible
  reservation before lengthy preparation. An idle device or launched process
  is not a reservation. Never evict another user's process.

When a separate personal-environment capability is installed and the user's
private machine or storage facts are needed, combine it with this method and
verify changeable state live.
