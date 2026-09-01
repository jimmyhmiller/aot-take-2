> This is experimental software. The admitted frontend slice is runnable; the full JavaScript and
> TypeScript languages are not yet admitted.

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
coil lint --fix  # repeat until it makes no changes
coil check       # typecheck every target
coil test        # THE gate. Green is the contract; nothing is committed red.
```

The production driver compiles the admitted source slice to an AArch64 Mach-O object, can link it,
and can run it natively:

```sh
coil build
build/release/aot compile input.ts output.o
build/release/aot run input.ts output.o output
```

The native path includes JSL semantic lowering and inlining, optimistic type flow, type checking,
loop-tree construction, instruction selection, global and local scheduling, iterative graph-coloring
register allocation, encoding, relocation, object writing, and linking. Unsupported language forms
are rejected at the parser boundary; scaffold APIs for later language/runtime units still hard-error
by name.

## Where things are

| Path | What it is |
|---|---|
| `src/node/` | The graph: header, dispatch trait, edges, peepholes, GVN — grouped by node family |
| `src/type/` | Partial interned lattice: simple types, ints, floats, arbitrary tuples, function-index sets, and dynamic tags |
| `src/shape.coil` | Implemented hidden-class transition tree with inherited aliases and stable property offsets |
| `src/codegen/` | The one-way phase pipeline, from peepholes through to the object file |
| `src/parse/` | The admitted JS/TS lexer, syntax arena, and Scope-driven SSA lowering |
| `src/jsl/` | The reader, checker and graph lowering for JSL |
| `jsl/` | The JavaScript runtime library, written in JSL. Already written; we compile toward it |
| `src/verify.coil` | Live graph verifier for the node families implemented so far |
| `src/eval.coil` | Planned IR interpreter and differential oracle; currently a hard-error scaffold |
| `tests/` | One suite per area; `coil test` runs them all |

## Status

Working, with tests: source-to-native compilation for numeric literals and `undefined`, bindings,
assignment, blocks, arithmetic, named and forward calls, conditional expressions, `if`/`else`,
nested `while`, early and implicit returns, fixed-ABI missing/extra arguments, and recursion; the
`(dyn NodeOps)` graph engine and GVN; the interned lattice including
integer ranges, floats, arbitrary-arity tuples, function-pointer identity sets and dynamic tags;
integer arithmetic, bitwise and comparison nodes; control flow and Phis; Fun/Parm/Call/CallEnd with
trivial and clone inlining; dynamic Box/Unbox/TypeTest/Cast guards; and constant push-up through
Phis.

Property tests generate shrinkable expression DAGs and control diamonds, checking bidirectional
edge multiplicity, optimizer/model agreement, fixpoint closure, and Region/Phi arity. Calls thread
bulk memory, and the admitted numeric/undefined path preserves binary64 and dynamic representation
semantics through native execution. General object/string representations, properties, closures,
exceptions, and their runtime support remain before this is a general JavaScript compiler.

The next frontend work is language expansion beyond that explicit admission boundary: strings,
objects, properties, richer expressions and control exits, and the corresponding runtime support.
`docs/FRONTEND.md` records the exact current contract.

## Provenance and license

This project re-implements, in Coil, the algorithms demonstrated by
[SeaOfNodes/Simple](https://github.com/SeaOfNodes/Simple) (Apache License 2.0). No Simple source is
copied here; what is taken is the design, followed closely and deliberately.

See [NOTICE](NOTICE) for the Simple attribution and
[Simple's license](https://github.com/SeaOfNodes/Simple/blob/7657c2312ac4d3d9ad3f0f992d023d4443055a75/LICENSE).

`jsl/` is not derived from Simple; its definitions cite ECMA-262 directly.

This project, including `jsl/`, is licensed under the [Apache License, Version 2.0](LICENSE).
