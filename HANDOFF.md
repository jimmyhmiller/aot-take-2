# HANDOFF

This is the current implementation boundary, not a chapter plan. Read `CLAUDE.md` first, then
`docs/LAYOUT.md`, `docs/DESIGN.md`, `docs/FRONTEND.md`, `docs/BACKEND.md`, and `docs/GAPS.md`.
The clean-room rule in `CLAUDE.md` is absolute: the only permitted compiler reference is final
SeaOfNodes/Simple.

## Gate

Every change must leave all of these green:

```sh
coil lint --fix     # run repeatedly until it makes no changes
coil check
coil test
git diff --check
```

Inspect the tree after lint because lint is a source rewrite. Do not update a test count in this
file: the complete `coil test` result is the contract.

## What is real now

The compiler has one production source-to-native path. `src/main.coil` exposes `aot compile` and
`aot run`; `src/codegen/pipeline.coil` drives the same path in integration tests. The admitted
source slice parses into a temporary syntax arena, lowers once through ScopeNode into the ideal
graph, loads production JSL definitions, optimizes, type-checks the Stop-reachable program, builds
the loop tree, selects AArch64 instructions, schedules them, allocates registers, encodes them,
writes Mach-O, and can link and execute the result.

The currently executable source grammar includes:

- named function declarations with optional `number` annotations, forward and duplicate
  declarations, duplicate non-strict parameters, and recursion;
- numeric literals and the shadowable global `undefined`;
- lexical `let`/`const`, assignment, blocks, expression statements, grouping, `+`, `-`, `*`,
  named calls, and conditional expressions;
- `if`/`else`, nested `while`, value and bare returns, implicit fallthrough, and unreachable
  statements after an unconditional return;
- arbitrary fixed function arity: omitted arguments become boxed `undefined`, extra arguments are
  evaluated left-to-right and then omitted from the callee's formal bank;
- a distinct host `main` wrapper around the deliberately unspellable source symbol
  `$aot$.source_main`, with boxed JavaScript results converted to process exit status.

`docs/FRONTEND.md` is the exact admission contract. A token the lexer recognizes is not thereby an
admitted expression or statement; unsupported forms fail at the parser boundary. Every current
syntax variant has native coverage, with graph-shape tests for ordering and effects that cannot be
observed through this small source language alone.

The production JSL index currently closes a numeric/undefined semantic subset. Frontend arithmetic
is emitted as Calls to those ordinary JSL Fun graphs, then specialized by the normal interleaved
inline/peephole fixpoint. Numeric values retain JavaScript binary64 behavior and their boxed dynamic
boundary. Unknown numeric/undefined inputs keep the guarded undefined-to-NaN fallback; a proven
representation permits Unbox and raw arithmetic. The checker and lowering support the forms used
by this production subset, including lexical `let`, value-producing `if`, calls, numeric
conversions, and dynamic tag predicates with branch-local Cast evidence.

The ideal graph and backend are not scaffolds. Implemented pieces include:

- interned scalar, tuple/signature, function-index-set, pointer, memory, nominal struct, and dynamic
  tag lattices;
- exact bidirectional graph edges, GVN, dependency-aware peepholes, optimistic SCCP, direct-call
  discovery, trivial and cloned inlining, and live graph verification;
- Simple's Fun-as-Region, Parm-as-Phi, four-input Return and three-projection CallEnd shapes, with
  bulk-memory threading and the frontend's multi-exit return accumulator;
- Scope-driven SSA, lazy loop Phis, nested-loop lifecycle and loop-tree construction;
- Load, Store, MemMerge, MemPhi, allocation boundaries, stable hidden-class transitions and
  inherited field aliases;
- final-Simple phase ordering; early/late global code motion with Phi-edge uses and memory
  anti-dependencies; sparse block-local scheduling; iterative graph-coloring register allocation
  with coalescing, splitting and spilling;
- AArch64 instruction selection and ABI forms, literal islands, conditional and long-branch
  relaxation, relocation, Mach-O/ELF object writing, and stack-map metadata.

The algorithm headers in the implementation record final Simple's order, guards, and failure
traps. JavaScript-specific divergences—syntax staging, dynamic representations, the host wrapper,
and hidden-class transitions—are documented beside them and in `docs/DECISIONS.md`.

## What remains

The compiler is complete for its explicit admitted frontend, not for all JavaScript or TypeScript.
The authoritative inventory is `docs/GAPS.md`. The largest remaining groups are:

- strings, objects, arrays, properties, closures, exceptions, richer operators and control exits,
  and the corresponding expansion of production JSL;
- the full JavaScript tag payload families, property/shape integration, runtime allocation,
  collection, throw paths, and safepoint metadata consumption;
- escaping and multi-target function discovery through persisted compilation units;
- ideal-graph serialization, dependency resolution, text/assembly printers, and the IR evaluator;
- x86-64 selection and encoding; AArch64 is the implemented native target;
- a user-facing dump command. CLI compile and run already use the production pipeline.

Do not fill one of these gaps with a local substitute. New source semantics cross the JSL Call
boundary; new backend facts come from the producer named in `docs/BACKEND.md`; every real stub must
continue to hard-error by name until its subsystem is implemented.

## Simple fidelity that is load-bearing

- Optimization is one IterPeeps fixpoint interleaving ordinary peepholes and one inline candidate
  at a time. Inlining is not a separate bulk pass.
- A Fun is a Region and a Parm is a Phi. Trivial inlining exposes the existing one-input
  Region/Phi collapse; clone inlining copies first and then uses the same mechanism.
- Loop finalization wires the control backedge and every materialized Phi backedge atomically.
- Type checking follows the Stop-reachable graph after optimization, so dead semantic errors do
  not reject the program.
- Global scheduling treats Phi arm `i` as a use on predecessor `i`; local scheduling preserves the
  entry Phi/CalleeSave cluster, projection adjacency, ordinary dependencies, and the CFG tail.
- Register allocation consumes that durable schedule and uses final Simple's shared Phi range plus
  edge-Split model. Do not mask malformed graph or schedule structure inside allocation.
- Call-to-Fun and Return-to-CallEnd optimizer links are removed before machine scheduling. They are
  discovery metadata, not executable CFG edges.

When extending an algorithm, read its final Simple implementation again and update the module
header with the exact rule order and any deliberate divergence. `docs/GAPS.md` must be updated in
the same change that closes or discovers a gap.

## Useful entry points

- `tests/execution-test.coil`: admitted source-to-native matrix.
- `tests/pipeline-test.coil`: ordered phase boundaries and object production.
- `tests/jsl-test.coil`: production JSL checking, lowering, specialization and dynamic proof.
- `tests/gcm-test.coil`, `tests/sched-test.coil`, `tests/regalloc-test.coil`,
  `tests/encode-test.coil`: backend algorithm regressions.
- `tests/program-graph-test.coil`: hand-built Simple structural spine.
- `tools/dot-dump.coil`: graph visualization for focused programs.
