# Project layout

An AOT TypeScript/JavaScript compiler on a sea-of-nodes IR, written in Coil, structured after
[SeaOfNodes/Simple](https://github.com/SeaOfNodes/Simple) — its **final** architecture, not its
chapter sequence.

This document is the file-by-file plan. It is meant to stay accurate: if a file exists here with no
row below, either add the row or delete the file.

> Read `CLAUDE.md` first. The one absolute rule of this project is stated there.

---

## 1. There is one architecture and this is it

Simple teaches in 25 chapters, each a self-contained subset of the last. **We are not doing that.**
What is described below is the end state, and it is the only design this project ever has. No
module is written "simply for now". No interface is placeholder. Calls, memory, shapes, guards, GC
and separate compilation are all present in the interfaces from the first line, even while their
bodies are still hard-error stubs.

Read Simple's chapters for the *ideas*. Take the code from the final chapter.

## 2. The thesis

Simple compiles a small, strongly-typed, C-like language. We compile a language that is **dynamic
underneath and typed on top**:

- **JavaScript is the semantics.** Every value is a dynamic value; every operation is an ECMA-262
  abstract operation. Those operations live in `jsl/` and lower into the same ideal graph the
  frontend produces — which is what lets `arr.map(f)` be inlined and specialised with no JIT.
- **TypeScript is the evidence.** TypeScript is deliberately unsound (bivariant parameters, `any`,
  unchecked casts, covariant mutable arrays), so an annotation is a claim we *discharge*, never one
  we trust. Discharged: the check folds away and the value unboxes. Not discharged: the guard stays.
- **Strictly AOT.** No `eval`, no `new Function`, no dynamic `import()` of unknown code. The closed
  world is what upgrades an annotation from a hint to a provable fact. There is no deoptimisation
  machinery: a failed guard is ordinary control flow into a generic version in the same binary.

Simple's lattice already has the right shape — interned, dual-symmetric, independent axes. We add
axes, not a second type system.

## 3. Taken from Simple unchanged

| Simple | Why it survives |
|---|---|
| `Node`: dense `nid`, ordered inputs, reverse outputs, `compute`/`idealize`, `peephole`, GVN, `deps` | This *is* the IR. Nothing about JS changes it. |
| The interned dual lattice: `meet`/`join`/`dual`/`isa` | Monotone analysis framework; our extra axes slot in. |
| `ScopeNode` + `Var` for SSA construction during parse | Lazy phis, loop scopes, `dup`/`mergeScopes`/`endLoop`. |
| Memory SSA: alias classes, `Load`/`Store`/`MemMerge`/`MemPhi` | Hidden classes supply the alias classes; the machinery is identical. |
| `IterPeeps` (pessimistic, to fixpoint) then `Opto` (optimistic interprocedural SCCP) | Both, in that order, with the call graph discovered by SCCP. |
| `CodeGen.Phase` as an explicit one-way pipeline | The whole driver shape. |
| Select → GCM → local schedule → graph-colouring RA → encode → object file | The general backend sequence, for general CFGs, calls and spills. |
| `CompUnit`/`Module`: the ideal graph serialized into the object file | Separate compilation with cross-unit inlining. |
| Round-trippable textual IR, a graph verifier, a Graphviz printer | Test infrastructure, not extras. |

## 4. Added deliberately (marked ✦ below)

- **A dynamic value axis** in the lattice, NaN-boxed at runtime, with `Box`/`Unbox` as real nodes
  the optimiser cancels in pairs.
- **Shapes** (hidden classes) as a transition tree. A field's alias class and byte offset are
  allocated at the edge that *introduces* the field and inherited unchanged by every descendant —
  which is what makes a store through `{x}` and a load through `{x,y}` name the same word.
- **Guards as control flow**: `If(TypeTest(v,T))` then `Cast(T)` on the taken edge. No `Guard`
  opcode — every existing CFG peephole, dominator pass and code-motion pass already understands
  `If`/`Region`/`Phi`/`Cast`. A discharged annotation disappears through `cast-idealize`.
- **A GC-abstract IR**: `Safepoint`/`Barrier` nodes, managed refs distinct from raw pointers, no
  interior pointer live across a safepoint, and a safepoint redefines every live ref it receives.
  A moving collector is only implementable if the IR was built for it from the start.
- **JSL**, the runtime-library language (Torque-shaped), so the ECMAScript surface grows in `.jsl`
  files at zero dispatch arms per builtin.
- **Exceptions** as exceptional CFG edges. Simple has none.
- **Closures**. Simple has first-class functions but not closures.

## 5. Coil representation

### Nodes: a trait object over grouped, thematic files

A node kind is a struct whose first field is the shared header, plus an `impl` of the `NodeOps`
trait. Edges are `(dyn NodeOps)` values — Coil's two-word trait object — so dispatch is a vtable
call and a concrete `(ptr AddNode)` coerces automatically.

```clojure
(defstruct NodeHdr
  [(nid  i64)        ; dense unique id
   (op   i64)        ; OP-ADD, OP-PHI, … the serialization tag and the case key
   (ty   i64)        ; interned type id — NOT named `type`
   (hash i64)        ; 0 = not in the GVN table, edges hackable
   (ins  NodeAry) (outs NodeAry) (deps NodeAry)])

(deftrait NodeOps [Self]
  (hdr      [(self (ptr Self))] (-> (ptr NodeHdr)))   ; uniform: header is field 0
  (compute  [(self (ptr Self))] (-> i64))
  (idealize [(self (ptr Self))] (-> (dyn NodeOps)))
  (label    [(self (ptr Self))] (-> (slice u8)))
  (eq       [(self (ptr Self)) (o (dyn NodeOps))] (-> bool)))

(defstruct AddNode [(hdr NodeHdr) (mode u8)])
(impl NodeOps AddNode (compute …) (idealize …) …)
```

**Node kinds are grouped into thematic files, not one file per kind.** Simple's 70-file `node/`
directory becomes ~16 files here, each owning a coherent family and all of its structs, impls and
peepholes together. Grouping by family is what makes the peepholes readable: `add-idealize`'s
constant-sinking rule and `sub-idealize`'s are the same rule and belong on the same screen.

### Types: an interned dense id over a `defsum`

Types are values, not behaviour carriers — hashed, interned, compared — and a forgotten kind in
`meet` is a silent miscompile. So `Ty` is a `u32` into an arena and the payload is a `defsum`,
making a missing arm a compile error. Variable-arity children (tuple members, struct fields, shape
field lists) live in a side array addressed by `(offset,len)`, keeping the sum small and
non-recursive.

`type/type.coil` owns the sum, the intern table, the lattice skeleton and the `xmeet` dispatch;
the family files own their constructors, accessors, `xmeet` bodies, `dual`, and printing — the same
division `Type.java` has with its subclasses.

### The machine port: a vtable

`Machine` is Simple's abstract class with `instSelect`, `regs`, `callArgMask`, `retMask`, `split`,
`jump`. Here it is a `MachineVT` struct of `(fnptr c …)`, one static per port. Machine nodes are
grouped by family exactly as ideal nodes are.

---

## 6. The tree

```
aot-take-2/
├── CLAUDE.md  ·  AGENTS.md → CLAUDE.md
├── Coil.toml  ·  README.md  ·  project.md
├── docs/
│   ├── LAYOUT.md        ; THIS FILE — the file-by-file contract
│   ├── DESIGN.md        ; the pipeline, the lattice, memory, the GC contract, the backend
│   ├── DECISIONS.md     ; law: load-bearing choices with their reasoning
│   ├── BACKEND.md       ; backend consumer assumptions and their ideal-graph producers
│   ├── COMPILE-TIME.md  ; what a compile may cost: graph shape, frame model, budgets, the road
│   ├── GAPS.md          ; complete inventory of absent and partial implementation
│   ├── TEST262.md       ; pinned conformance campaign, denominator and runner contract
│   ├── JSL.md           ; the runtime-library language
│   └── JOURNAL.md       ; why something looks the way it does
├── jsl/                 ; the JavaScript runtime library, in JSL — already written
│   ├── index            ; load order IS the format (function indices, golden hashes)
│   ├── intrinsics.jsl   ; the global-object surface
│   ├── object-layouts.jsl
│   └── abstract/ array/ string/ object/ json/ math/ number/ symbol/ compiler/
│       └── compiler/{add,sub,mul,increment-int-or-identity,logical,…,array,string-methods}.jsl
│           ; the production index (`compiler/index`): every operation the frontend lowers to,
│           ; built on demand per compile; array.jsl is the Array intrinsic and its methods,
│           ; string-methods.jsl String.prototype and String.fromCharCode over primitive strings
│       function/ array-buffer/ data-view/ typed-array/
├── src/
│   ├── main.coil            ; CLI driver: compile, emit, run, dump; `AOT_SEED=N` compiles under a test's arena seed
│   │
│   ├── util/
│   │   ├── ary.coil         ; growable arrays: nodes, ints, bitsets     Ary/AryInt
│   │   ├── sb.coil          ; string builder and byte sink              SB/BAOS
│   │   ├── table.coil       ; int-keyed hash maps, the intern tables    IntHashMap
│   │   ├── worklist.coil    ; the seeded random worklist                IterPeeps.WorkList
│   │   └── arena.coil       ; the id arenas nodes and types live in
│   │
│   ├── type/
│   │   ├── type.coil        ; Ty sum, interning, meet/dual/join/isa, the xmeet dispatch
│   │   ├── scalar.coil      ; int (with ranges), float, nil, ptr, scalar
│   │   ├── mem.coil         ; memptr, mem, struct, field, const-array
│   │   ├── fun.coil         ; funptr, tuple, RPC
│   │   └── dyn.coil         ; ✦ the dynamic tag axis, shape sets, the JS string type
│   │
│   ├── shape.coil           ; ✦ the shape transition tree; alias classes at the introducing edge
│   ├── heap.coil            ; ✦ the static heap image: the realm's initial objects and string literals as data (`__aot_heap`)
│   │
│   ├── node/
│   │   ├── node.coil        ; NodeHdr, NodeOps, edges, peephole/peepholeOpt, GVN, deps,
│   │   │                    ;   kill/subsume, the OP-* constants, the in-progress windows
│   │   ├── copy.coil        ; shallow shells and two-pass selected-subgraph copying
│   │   ├── cfg.coil         ; CFGNode: idom, depth, blocks, loop depth, the loop tree
│   │   ├── control.coil     ; Start, Stop, Region, Loop, If, Never, XCtrl, Proj, CProj, Multi
│   │   ├── phi.coil         ; Phi and the region/phi arity invariant
│   │   ├── constant.coil    ; Constant, FunPtr, ConFldOff, Extern, FRef
│   │   ├── arith.coil       ; Add, Sub, Mul, Div, Minus, ToFloat, ToInt, RoundF32 + the int/float modes
│   │   ├── bits.coil        ; And, Or, Xor, Shl, Shr, Sar, Not
│   │   ├── compare.coil     ; EQ, NE, LT, LE, ULT
│   │   ├── memory.coil      ; MemOp, Load, Store, New, MemMerge, MemPhi, ReadOnly
│   │   ├── call.coil        ; Fun, Parm, Call, CallEnd, Return, Escape
│   │   ├── scope.coil       ; ScopeNode + Var — the parser's SSA helper
│   │   ├── dynamic.coil     ; ✦ Box, Unbox, TypeTest, Cast — the guard mechanism
│   │   ├── property.coil    ; ✦ PropAccess node (load/has/store), its fold and late expansion
│   │   ├── jsops.coil       ; ✦ string, symbol and number primitives the JSL layer bottoms out on
│   │   ├── closure.coil     ; ✦ closure creation and captured-environment access
│   │   ├── exception.coil   ; ✦ Throw and the exceptional control edge
│   │   ├── gc.coil          ; ✦ Safepoint, Barrier, relocation projections
│   │   └── cpus/
│   │       ├── machnode.coil    ; MachNodeVT: regmap, outregmap, killmap, encoding, asm
│   │       ├── arm64/  { arm64.coil, base.coil, arith.coil, bits.coil, dynamic.coil, mem.coil,
│   │       │             phi.coil, branch.coil, call.coil, split.coil }
│   │       └── x86_64/ { x86_64.coil, arith.coil, bits.coil, mem.coil,
│   │                     branch.coil, call.coil, encode.coil }
│   │
│   ├── codegen/
│   │   ├── codegen.coil     ; the CODE singleton, Phase, driver()          CodeGen
│   │   ├── pipeline.coil    ; source-to-object/link/run phase orchestration
│   │   ├── iterpeeps.coil   ; peepholes to fixpoint                        IterPeeps
│   │   ├── opto.coil        ; optimistic interprocedural SCCP + call graph Opto
│   │   ├── typecheck.coil   ; the last check for bad programs
│   │   ├── looptree.coil    ; the loop tree; breaking infinite loops
│   │   ├── gcm.coil         ; earliest/latest placement, use LCA, loop frequency
│   │   ├── listsched.coil   ; block-local dependency DAG and scheduling
│   │   ├── regalloc.coil    ; live ranges, interference, coalescing, splitting, colouring
│   │   ├── regmask.coil     ; register masks and the stack-slot numbering
│   │   ├── machine.coil     ; MachineVT — the port interface               Machine
│   │   ├── encoding.coil    ; encoding and relocations
│   │   ├── serialize.coil   ; the ideal graph into the object file
│   │   ├── compunit.coil    ; compilation units, dependency tree, cross-unit linking
│   │   ├── objfile.coil     ; Mach-O and ELF writing/reading
│   │   └── gcmeta.coil      ; safepoint placement, stack maps, barrier lowering
│   │
│   ├── parse/               ; Simple's 2856-line Parser.java, split by concern
│   │   ├── lexer.coil       ; JS/TS tokens, regex-vs-divide, ASI, template literals
│   │   ├── parser.coil      ; recursive descent → SoN, straight through ScopeNode
│   │   ├── regex.coil       ; RegExp pattern early errors: strict, web-compat and v-mode grammars
│   │   ├── tstype.coil      ; TypeScript annotation syntax → our lattice
│   │   └── decl.coil        ; hoisting, binding resolution, module records
│   │
│   ├── jsl/
│   │   ├── reader.coil      ; the s-expression reader for .jsl
│   │   ├── prims.coil       ; the primitive table
│   │   ├── check.coil       ; the checker — refuses BY NAME what it cannot lower
│   │   ├── lower.coil       ; JSL → ideal graph, and the transition check over it
│   │   └── decls.coil       ; (intrinsic …), (internal-slot …), (slot-list …)
│   │
│   ├── rt/                  ; the runtime, in Coil, built as its own object (Coil.toml `runtime`)
│   │   ├── number.coil      ; Number conversions shared by compiler and runtime: exact radix integers, `strtod` decimals, StringToNumber, the NaN-box word
│   │   ├── abi.coil         ; RtHeap layout + folded field offsets shared with the encoders
│   │   ├── shapes.coil      ; the runtime shape tree: static `__aot_shapes` blob + runtime transitions
│   │   └── rt.coil          ; allocation, generational collector, the static heap image as a root region, strings, generic property access, throw entry points
│   │
│   ├── print/
│   │   ├── ir.coil          ; the pretty printer                          IRPrinter
│   │   ├── asm.coil         ; the disassembly printer                     ASMPrinter
│   │   ├── dot.coil         ; Graphviz                                    GraphVisualizer
│   │   ├── web.coil         ; structured semantic snapshots for the browser visualizer
│   │   └── text.coil        ; ✦ graph and type text: printers live, parsers pending
│   │
│   ├── verify.coil          ; ✦ the graph verifier, one named code per check
│   └── eval.coil            ; ✦ the IR interpreter — the differential oracle
│
├── tests/                   ; `coil test` is THE gate
│   ├── graph-gen.coil       ; shrinkable well-formed expression/control graph generators
│   ├── graph-property-test.coil ; structural and optimizer properties over generated graphs
│   ├── program-graph-test.coil ; complete Stop-rooted graph structure against Simple
│   ├── type-test.coil  node-test.coil  peephole-test.coil  gvn-test.coil
│   ├── scope-test.coil  loop-test.coil  mem-test.coil  shape-test.coil  rt-shapes-test.coil
│   ├── opto-test.coil  gcm-test.coil  sched-test.coil  regalloc-test.coil
│   ├── encode-test.coil  compunit-test.coil  verify-test.coil  text-test.coil
│   ├── lex-test.coil  parse-test.coil  regex-test.coil  tstype-test.coil  jsl-test.coil
│   ├── number-test.coil             ; StringToNumber grammar and the Number word (aot.rt.number)
│   ├── test262-test.coil            ; metadata, runner policy and accounting regressions
│   ├── harness.coil                 ; source in → linked binary out → node's answer beside it
│   ├── bloat-test.coil              ; graph-size budgets: node-count ceilings after optimization
│   ├── budget-test.coil             ; compile-time budgets as gates: rounds, shape, wall time (docs/COMPILE-TIME.md §7)
│   ├── execution-test.coil          ; cases that must RUN, not merely compile
│   └── differential-test.coil       ; compiled output vs. a JavaScript engine
├── benchmarks/              ; JavaScript/TypeScript input fixtures for native comparisons
├── web/                     ; GitHub Pages graph playground; HTML/CSS/JS presentation over Coil/Wasm
└── tools/
    ├── dot-dump.coil
    ├── test262-metadata.coil ; test262 frontmatter, required variants and include ordering
    ├── test262-policy.coil   ; independent source-unit plans and observed-result classification
    ├── test262-worker.coil   ; bounded sequential compiler/linker/native process execution
    ├── test262.coil          ; pinned-suite inventory and sequential conformance runner
    └── graph-wasm.coil      ; browser Wasm entry: source → phase snapshot
```

`✦` marks something Simple does not have. Names in the right-hand column of the comments are the
Simple file the module corresponds to.

## 7. Build order

The architecture above is fixed. This is only the order in which its bodies stop being stubs.
Nothing here is a design stage — no interface changes as we go.

**S0 — representation spike.** Prove the `(dyn NodeOps)` edge representation compiles, coerces, and
performs: a graph of a few thousand nodes built, peepholed, GVN'd and walked. Everything else
depends on this being right, so it is settled with running code before 180 files assume it.

**S1 — the spine.** `util/`, `type/`, `node/node.coil` + `control` + `phi` + `constant` + `arith` +
`bits` + `compare`, `scope`, `codegen/{codegen,iterpeeps,opto}`, `verify`, `eval`, `print/`. The
whole middle end for the scalar core, with the interfaces for memory, calls and dynamics present
and stubbed.

**S2 — the frontend.** `parse/`. Real JS/TS in, ideal graph out, straight through `ScopeNode`.

**S3 — memory and objects.** `shape.coil`, `node/{memory,property,dynamic}`, the memory half of the
lattice. This is where `Box`/`Unbox`, hidden classes and alias classes come alive.

**S4 — calls.** `node/{call,closure}`, the interprocedural half of `opto`.

**S5 — JSL.** `src/jsl/`, then `jsl/index` loads and lowers. `jsl/index` currently names `lib/…`
paths and must be rewritten to `jsl/…`; the loader hard-errors on a missing or misordered entry.

**S6 — the backend, whole.** `codegen/{gcm,listsched,regalloc,regmask,encoding,machine}` and
`node/cpus/arm64`. General CFGs, general phi lowering with a parallel-copy solver, real ABI frames,
real spills. arm64 first, x86-64 second.

**S7 — object files and separate compilation.** `codegen/{serialize,compunit,objfile}`.

**S8 — the runtime edges.** `node/{exception,gc}`, `codegen/gcmeta.coil`, the collector.

The runtime is Coil, per `CLAUDE.md`'s second rule: allocation, the collector, string primitives
and host I/O are Coil compiled into the binary or machine code we emit. There is no C shim to fall
back on, so `src/rt/` is Coil and its interface to emitted code is an ABI we define here.

## 8. Rules this project holds from the first commit

Written here because they are cheap to state and expensive to learn:

- **A rewrite may only act on a proven type.** `compute` is an optimistic analysis and may act on
  whatever it holds; any *irreversible* rewrite must first prove the type, transitively over the
  node's whole input cone, as a fixpoint test. `ANY` is the absence of information — every other
  high type is a claim someone computed, so "is exactly `~ctrl`" proves nothing on its own.
- **Construction has contracts.** A merge under construction reports CONTROL and its phis report
  their declared types; a loop body is built *and peepholed* inside that window. Final Simple's
  `endLoop` then wires the control back edge and immediately fills every materialized phi backedge
  as one protected operation. A phi's own null final input keeps it in progress during that brief
  interval. An `If` is in progress until *all* its projections exist. A region's path count and
  every phi's value count are one invariant, changed together or not at all.
- **A tool is only a tool if it can fail.** Every check reports a named code; every identity or
  coverage claim carries a counted floor saying how much it compared. Revert your fix and confirm
  the gate goes red.
- **The oracle has to run the program.** A graph missing an arm is still a structurally valid graph;
  golden strings and the verifier both stay green through one.
- **Vary the worklist seed.** Order-dependent bugs appear on a minority of seeds.

## 9. Provenance

Simple is Apache License 2.0. We re-implement rather than copy. `NOTICE` carries the attribution
and links to Simple's license. This project is licensed under Apache License 2.0 through the root
`LICENSE`; licensing is handled once at project level, not per file.

`jsl/` is not derived from Simple.
