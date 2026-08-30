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

**Green does not yet mean much.** What exists today is the graph representation, the type lattice,
and one arithmetic node — enough to prove the representation carries a real IR, and no more. Most
of the tree is hard-error scaffolding, and every stub dies naming itself and the build step that
owns it.

## Where things are

| Path | What it is |
|---|---|
| `src/node/` | The graph: header, dispatch trait, edges, peepholes, GVN — grouped by node family |
| `src/type/` | The interned lattice: `meet`/`dual`/`join`/`isa`, plus the dynamic and shape axes |
| `src/shape.coil` | Hidden classes as a transition tree, and the alias classes memory SSA needs |
| `src/codegen/` | The one-way phase pipeline, from peepholes through to the object file |
| `src/parse/` | The JS/TS lexer and recursive-descent parser — straight into SSA, no AST |
| `src/jsl/` | The reader, checker and graph lowering for JSL |
| `jsl/` | The JavaScript runtime library, written in JSL. Already written; we compile toward it |
| `src/verify.coil` | The graph verifier, one named code per check |
| `src/eval.coil` | The IR interpreter, and therefore the differential oracle |
| `tests/` | One suite per area; `coil test` runs them all |

## Status

Working, with tests: the `(dyn NodeOps)` node representation, node identity and bidirectional
edges, GVN hash and equality, the lattice core (`meet`/`dual`/`join`/`isa` over the simple types
and integer ranges), and integer `Add` with range arithmetic that widens on overflow rather than
wrapping.

Everything else is scaffolding with final signatures and hard-error bodies. `docs/LAYOUT.md` §7 has
the build order.

## Provenance and license

This project re-implements, in Coil, the algorithms demonstrated by
[SeaOfNodes/Simple](https://github.com/SeaOfNodes/Simple) (Apache License 2.0). No Simple source is
copied here; what is taken is the design, followed closely and deliberately.

See [NOTICE](NOTICE) for the Simple attribution and
[Simple's license](https://github.com/SeaOfNodes/Simple/blob/7657c2312ac4d3d9ad3f0f992d023d4443055a75/LICENSE).

`jsl/` is not derived from Simple; its definitions cite ECMA-262 directly.

This project, including `jsl/`, is licensed under the [Apache License, Version 2.0](LICENSE).
