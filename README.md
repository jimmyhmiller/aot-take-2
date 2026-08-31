> This is experimental software. It probably doesn't work yet.

# aot-take-2

An ahead-of-time compiler for **TypeScript and JavaScript**, on a **sea-of-nodes** IR, written in
[Coil](../../coil).

The goal is V8-class performance with **no JIT**. What makes that plausible is a closed world: it
lets a TypeScript annotation be *proven* rather than trusted, which is what earns the right to
compile the check away. Where a value stays polymorphic, monomorphic specialisations are emitted
ahead of time behind guards, with a generic version retained as the fallback. There is no
deoptimisation machinery anywhere in the design.

## Read these first

1. **[HANDOFF.md](HANDOFF.md)** — current state and what to work on next.
2. **[CLAUDE.md](CLAUDE.md)** — the two absolute rules of this project. Non-negotiable, and the
   first one is unusual enough that you must read it before touching anything.
3. **[docs/LAYOUT.md](docs/LAYOUT.md)** — the architecture, the file-by-file map, and the build
   order. Every file in `src/` has a row there.

## The gate

```sh
coil test        # THE gate. Green is the contract; nothing is committed red.
coil check       # typecheck every target
```

**Green is still a partial compiler, not a runnable one.** The ideal graph core, lattice, integer
value nodes, control flow, calls, trivial and clone inlining, dynamic guards, graph verification,
and Phi-constant rewriting are real and tested. The frontend, memory, evaluator and backend remain
hard-error scaffolding or explicitly owed work; every actual stub dies naming itself and the build
step that owns it.

## Where things are

| Path | What it is |
|---|---|
| `src/node/` | The graph: header, dispatch trait, edges, peepholes, GVN — grouped by node family |
| `src/type/` | Partial interned lattice: simple types, ints, floats, arbitrary tuples, function-index sets, and dynamic tags |
| `src/shape.coil` | Planned hidden-class transition tree; currently scaffold |
| `src/codegen/` | The one-way phase pipeline, from peepholes through to the object file |
| `src/parse/` | The JS/TS lexer and recursive-descent parser — straight into SSA, no AST |
| `src/jsl/` | The reader, checker and graph lowering for JSL |
| `jsl/` | The JavaScript runtime library, written in JSL. Already written; we compile toward it |
| `src/verify.coil` | Live graph verifier for the node families implemented so far |
| `src/eval.coil` | Planned IR interpreter and differential oracle; currently a hard-error scaffold |
| `tests/` | One suite per area; `coil test` runs them all |

## Status

Working, with tests: the `(dyn NodeOps)` graph engine and GVN; the interned lattice including
integer ranges, floats, arbitrary-arity tuples, function-pointer identity sets and dynamic tags;
integer arithmetic, bitwise and comparison nodes; control flow and Phis; Fun/Parm/Call/CallEnd with
trivial and clone inlining; dynamic Box/Unbox/TypeTest/Cast guards; and constant push-up through
Phis.

Property tests now generate shrinkable expression DAGs and control diamonds, checking bidirectional
edge multiplicity, optimizer/model agreement, fixpoint closure, and Region/Phi arity. General
object/string value representation, complete float behavior, and memory threading remain correctness
blockers before this is a general JavaScript IR.

The next front is JSL reading, checking and lowering. `HANDOFF.md` gives the fixture-first target,
the exact prerequisites and the currently owed correctness work; `docs/LAYOUT.md` §7 has the full
build order.

## Provenance and license

This project re-implements, in Coil, the algorithms demonstrated by
[SeaOfNodes/Simple](https://github.com/SeaOfNodes/Simple) (Apache License 2.0). No Simple source is
copied here; what is taken is the design, followed closely and deliberately.

See [NOTICE](NOTICE) for the Simple attribution and
[Simple's license](https://github.com/SeaOfNodes/Simple/blob/7657c2312ac4d3d9ad3f0f992d023d4443055a75/LICENSE).

`jsl/` is not derived from Simple; its definitions cite ECMA-262 directly.

This project, including `jsl/`, is licensed under the [Apache License, Version 2.0](LICENSE).
