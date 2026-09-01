# aot-take-2

## Summary

An AOT TypeScript/JavaScript compiler on a sea-of-nodes IR, written in Coil. Structured as a close
port of SeaOfNodes/Simple's FINAL architecture — not its chapter sequence.

## Index

- [README.md](README.md) — orientation and current status
- [CLAUDE.md](CLAUDE.md) — the two absolute rules. Read before touching anything.
- [docs/LAYOUT.md](docs/LAYOUT.md) — architecture, file-by-file map, build order S0–S8
- [docs/BACKEND.md](docs/BACKEND.md) — final-Simple backend contracts and prerequisite producers

## Owed documents

- `docs/DESIGN.md` — the pipeline, the lattice, memory, the GC contract, the backend
- `docs/DECISIONS.md` — law: load-bearing choices with their reasoning
- `docs/JSL.md` — the runtime-library language, re-derived from `jsl/` itself
- `docs/JOURNAL.md` — why something looks the way it does

## Open items

- `jsl/index` names `lib/…` paths and must be rewritten to `jsl/…`.
- `docs/JSL.md` does not exist. The JSL surface has to be recovered by reading `jsl/` (46 files,
  ~5900 lines): `builtin`/`macro`/`intrinsic`/`internal-slot`/`slot-list`, the `%`-primitive layer,
  `:params`/`:ret`/`:transitioning`, and the `:spec`/`:status`/`:deviation` provenance fields.

## Pads

- `aot-take-2` — the working notebook: what each slice does, the traps, falsification results,
  and how the pieces connect to JSL. Open with `pad open aot-take-2`.
- `coil-bugs` — Coil defects found while working here.
- `HANDOFF.md` — current state, the next piece of work, and the traps that have already cost time.
