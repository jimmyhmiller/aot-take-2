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

**A family that outgrows one file splits along Simple's files.** `call.coil` holds Call and
CallEnd and re-exports `fun.coil` (Fun, Parm, FunPtr) and `inline.coil`; `control.coil` re-exports
`region.coil` and `cfgof.coil`. The family's account of Simple stays in the family's own file.

### Modules: a facade and its parts

A module is one concern. When a module outgrows that — roughly a thousand lines, or a second
concern you can name — it is split into a directory named after it:

```
codegen/regalloc.coil         (module aot.codegen.regalloc)      the driver; re-exports the parts
codegen/regalloc/lrg.coil     (module aot.codegen.regalloc.lrg)
codegen/regalloc/ifg.coil     (module aot.codegen.regalloc.ifg)
```

- **The original module stays the public name.** It keeps the entry points and the header account
  of Simple's algorithm, and imports each part with `:use * :reexport`. Importers, tests included,
  keep importing `aot.codegen.regalloc` and never learn the parts exist.
- **Parts import each other directly**, never through the facade: a part that did `:use *` of both
  the facade and a sibling would see every moved name twice.
- **Cycles between parts are legal and expected.** Coil resolves module cycles, so expression and
  statement lowering, or grammar and cover grammar, are separate files that import each other.
  A cycle between LAYERS is still a design error — `aot.node.*` does not import `aot.parse.*`.
- **An import list states a dependency.** `aot.lint.unused-imports` runs with every `coil lint`
  and removes an import the module does not use, so a module's imports are its real dependencies.

`tools/refactor/split.coil` performs a split from the compiler's own parse; `docs/REFACTORING.md`
is the workflow.

### Functions, `impl`s and traits: which one

Three shapes of code live here, and each has its form.

- **A type with behaviour gets an `impl`.** Where a struct is passed as the receiver of a family of
  functions — `RegMask`, `WorkList` — those functions are methods: `(impl RegMask …)`, constructed
  with `RegMask::of`, `RegMask::range`, `WorkList::new`, and dispatched on the receiver
  (`(union a b)`, `(has-reg? m r)`).
- **A shared capability is a trait.** Node kinds implement `NodeOps`, `CFGOps`, `MemOps`; machine
  nodes `MachNode`; a port `Machine`. A collection speaks the AMBIENT vocabulary instead of
  inventing its own: `WorkList` implements `Len`, `Push` and `Pop`, so it is `(push! wl id)`,
  `(pop! wl)`, `(empty? wl)` like every other collection in Coil.
- **Everything keyed by an id or by the compilation singleton stays a prefixed function.** Most of
  this compiler is: a type is an interned `i64`, a syntax node an arena index, an edge a
  `(dyn NodeOps)`, and the parser, the arena and `CODE` are per-compilation singletons behind
  zero-argument accessors. There is no struct receiver to hang a method on, and `ty-meet`,
  `n-in`, `syntax-at`, `lower-ref-get!` say what they operate on in their names. That is also how
  Coil's own library is written (`al-push!`, `hm-put!`, `sb-push-str!`).

A short method name is a cost as well as a benefit: it can collide with a local (`word` did) and
it cannot be searched for. Drop a prefix when the receiver makes the call obvious and keep it
otherwise. `tools/refactor/rename.coil` and `tools/refactor/methods.coil` do the mechanical part.

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
│   ├── SPECIALIZE.md    ; proposal: a JSL definition carries its own idealization rules, and where to apply them
│   ├── FUNCTION-VERSIONS.md ; bounded callable versions, entry contracts, research and validation
│   ├── SEA-OF-NODES-AUDIT.md ; are we a proper sea of nodes: what was fixed, what remains, what the traces measured
│   ├── REFACTORING.md   ; the refactoring and lint metaprograms in tools/, and the workflow that ties them together
│   └── JOURNAL.md       ; why something looks the way it does
├── jsl/                 ; the JavaScript runtime library, in JSL — already written
│   ├── index            ; load order IS the format (function indices, golden hashes)
│   ├── intrinsics.jsl   ; the global-object surface
│   ├── object-layouts.jsl
│   └── abstract/ array/ string/ object/ json/ math/ number/ symbol/ compiler/
│       └── compiler/{add,sub,mul,increment-int-or-identity,logical,…,array,string-methods,
│           ;          function-methods,object-methods,number-methods,math,array-generic}.jsl
│           ; the production index (`compiler/index`): every operation the frontend lowers to,
│           ; intrinsics.jsl the standard globals' bodies and the realm's (intrinsic …) declarations,
│           ; built on demand per compile; array.jsl is the Array intrinsic and its methods,
│           ; string-methods.jsl String.prototype and String.fromCharCode over primitive strings,
│           ; function-methods.jsl Function.prototype.call/apply (and the Function constructor's
│           ; refusal), object-methods.jsl Object's statics and Object.prototype,
│           ; number-methods.jsl Number.prototype and Boolean.prototype,
│           ; math.jsl the Math object and isNaN/isFinite/parseInt/parseFloat,
│           ; array-generic.jsl the array-like arms of the callback and search methods, and `in`
│           ; call.jsl shared dynamic-call dispatch over the checked callable ABI,
│           ; delete.jsl the delete operator and [[Delete]] over every represented kind,
│           ; enumerate.jsl own string keys, getOwnPropertyNames and for-in enumeration,
│           ; bound.jsl Function.prototype.bind and bound functions (built-in closures),
│           ; arguments.jsl the arguments object,
│           ; toprimitive.jsl ToPrimitive, the source operators over the numeric cores, and the object
│           ;   arms of the string methods and computed member keys,
│           ; literal.jsl object literal accessor and replacing data definitions,
│           ; class.jsl the class prototype object, its member definitions and super references
│           ; environment.jsl the environment records closures read and write
│           ; symbol.jsl Symbol values, their prototype methods and their refused conversions
│           ; console.jsl the host's output and how a value is shown
│           ; iterator.jsl the iteration protocol and the array iterator
│           ; object-rest.jsl CopyDataProperties: object spread in a literal, rest in a pattern
│           ; array-sort.jsl the stable merge sort Array.prototype.sort is defined over
│           ; collect.jsl Array.from/of, Object.entries/values/assign, the Number predicates
│           ; json.jsl JSON.stringify and JSON.parse
│           ; map-set.jsl Map and Set: entry arrays under internal slots, scanned
│           ; date.jsl Date: one instant in a slot, and the calendar as arithmetic over it
│           ; array-methods.jsl splice, fill, flat, reduceRight and the searches from the end
│           ; string-more.jsl replace/replaceAll, ASCII case conversion, Number.prototype.toFixed
│           ; int-arith.jsl the integer arms of `+`, `-` and the relations, and their generic out-of-line forms
│           ; reflect.jsl the Reflect namespace: the specified argument handling over the internal methods
│       function/ array-buffer/ data-view/ typed-array/
├── src/
│   ├── main.coil            ; CLI driver: compile, emit, run, dump; `AOT_SEED=N` compiles under a test's arena seed
│   │
│   ├── util/
│   │   ├── ary.coil         ; growable arrays: nodes, ints, bitsets     Ary/AryInt
│   │   ├── sb.coil          ; string builder and byte sink              SB/BAOS
│   │   ├── worklist.coil    ; the seeded random worklist: Len/Push/Pop over a set   IterPeeps.WorkList
│   │   ├── panic.coil       ; named panics: unimplemented, unreachable, invariant
│   │   └── arena.coil       ; compiler-region allocator and generation-scoped singleton ownership
│   │
│   ├── type/
│   │   ├── type.coil        ; Ty sum, interning, meet/dual/join/isa, the xmeet dispatch; re-exports the families
│   │   ├── scalar.coil      ; int (with ranges), float, bool
│   │   ├── mem.coil         ; ptr, memptr, mem, struct
│   │   ├── fun.coil         ; tuple, function-index sets, funptr, signatures, RPC
│   │   ├── dyn.coil         ; ✦ the dynamic tag axis, identity, shape sets, the JS string type
│   │   └── text.coil        ; the printed form of every type
│   │
│   ├── shape.coil           ; ✦ the shape transition tree; alias classes and property attributes at the introducing edge; extensibility as a marker edge
│   ├── heap.coil            ; ✦ the static heap image: the realm's initial objects and string literals as data (`__aot_heap`)
│   ├── facts.coil           ; ✦ closed-world facts about image objects: escaped, written (entry, key), prototype writes
│   │
│   ├── node/
│   │   ├── node.coil        ; NodeHdr, NodeOps, header accessors, edges, deps, kill/subsume,
│   │   │                    ;   the in-progress windows; re-exports op, arena, origin, gvn, peephole, cfgcache
│   │   ├── op.coil          ; the OP-* constants: serialization tag and case key
│   │   ├── arena.coil       ; dense node ids, the fidx registry, external functions, the iterate and inline worklists
│   │   ├── origin.coil      ; the source range a node was built for
│   │   ├── gvn.coil         ; hash, structural equality, the table, unlock-before-edit
│   │   ├── peephole.coil    ; compute, constant replacement, idealize, GVN, DCE      Node.peephole
│   │   ├── cfgcache.coil    ; CFG edit versioning; the idom, owner and depth caches it invalidates
│   │   ├── boot.coil        ; one entry point that resets every compilation singleton
│   │   ├── copy.coil        ; shallow shells and two-pass selected-subgraph copying
│   │   ├── versions.coil    ; reusable callable versions, policy, contracts and graph lifetime
│   │   ├── cfg.coil         ; CFGNode: idom, depth, blocks, loop depth, the loop tree
│   │   ├── control.coil     ; Start, Stop, If, Never, XCtrl, Proj, CProj, Multi, Return; re-exports region, cfgof
│   │   ├── region.coil      ; Region and Loop, their peepholes, dominators over them      RegionNode, LoopNode
│   │   ├── cfgof.coil       ; the CFG view of any node, the owning function, and the extension points
│   │   ├── phi.coil         ; Phi and the region/phi arity invariant
│   │   ├── phicon.coil      ; Phi-of-constants folding
│   │   ├── constant.coil    ; Constant, Extern, symbolic unit KeyRef/ShapeRef; ConFldOff, FRef
│   │   ├── arith.coil       ; Add, Sub, Mul, Div, Minus, ToFloat, ToInt, RoundF32 + the int/float modes
│   │   ├── bits.coil        ; And, Or, Xor, Shl, Shr, Sar, Not
│   │   ├── compare.coil     ; EQ, NE, LT, LE, ULT
│   │   ├── memory.coil      ; MemOp, Load, Store, New, MemMerge, MemPhi, ReadOnly
│   │   ├── call.coil        ; Call, CallEnd, linking and unlinking; the account of Simple's call rules; re-exports fun, inline
│   │   ├── fun.coil         ; Fun, Parm, FunPtr      FunNode, ParmNode
│   │   ├── inline.coil      ; size accounting, candidate selection, deferral, the trivial and cloning inliners' entries
│   │   ├── scope.coil       ; ScopeNode + Var — the parser's SSA helper
│   │   ├── dynamic.coil     ; ✦ Box, Unbox, TypeTest, Cast — the guard mechanism
│   │   ├── property.coil    ; ✦ PropAccess node (load/has/store) and its fold; re-exports propproof, propexpand
│   │   ├── propproof.coil   ; ✦ what a shape, an image holder and the memory position prove about one property
│   │   ├── propexpand.coil  ; ✦ late expansion into storage loads, stores, transitions and generic access
│   │   ├── imagefacts.coil  ; ✦ the closed-world image analysis that fills aot.facts, once the world closes; `AOT_FACTS_TRACE=1` narrates escapes and stores
│   │   ├── imagefacts/  { scan.coil   ; ✦ entry sets per node, escapes, prototype closure, image reads and writes
│   │   │                  flow.coil   ; ✦ projections, call targets and results, paired writes, per-op effects
│   │   │                  demand.coil } ; ✦ which intrinsic properties a program can observe
│   │   ├── jsops.coil       ; ✦ string, symbol and number primitives the JSL layer bottoms out on
│   │   ├── closure.coil     ; ✦ closure creation and captured-environment access
│   │   ├── exception.coil   ; ✦ Throw and the exceptional control edge
│   │   ├── gc.coil          ; ✦ Safepoint, Barrier, relocation projections
│   │   └── cpus/
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
│   │   ├── gcm.coil         ; CFG build, RPO, early schedule; the account of Simple's GCM; re-exports its parts
│   │   ├── gcm/  { dom.coil      ; the dominator index: preorder intervals and block LCA
│   │   │           globals.coil  ; breaking up Start-pinned globals, one clone per using function
│   │   │           late.coil }   ; use LCA, constrained placement, memory waits, anti-dependencies
│   │   ├── listsched.coil   ; block-local dependency DAG and scheduling
│   │   ├── regalloc.coil    ; the driver, callee saves, frames, post-colour; the account of Simple's allocator      RegAlloc
│   │   ├── regalloc/  { lrg.coil          ; state, LRG kinds, union-find with mask intersection      LRG
│   │   │                build.coil        ; live ranges from machine defs, uses and phis      BuildLRG
│   │   │                ifg.coil          ; backwards liveness per block, kills, adjacency      IFG
│   │   │                colour.coil       ; simplify by risk, biased selection, propagation      Color
│   │   │                coalesce.coil     ; coalescing split copies
│   │   │                split.coil        ; copy and clone placement; the policy dispatcher
│   │   │                split-self.coil   ; self-conflicting ranges
│   │   │                split-loop.coil   ; loop boundaries and callee-save ranges
│   │   │                split-empty.coil  ; ranges whose mask went empty
│   │   │                trace.coil }      ; AOT_RA_TRACE
│   │   ├── regmask.coil     ; RegMask: an impl over register sets, and the stack-slot numbering
│   │   ├── machine.coil     ; MachineVT — the port interface               Machine
│   │   ├── encoding.coil    ; encoder state, bytes, fixups, definitions, emit and relocate; re-exports its parts
│   │   ├── encoding/  { layout.coil   ; block order, fallthrough and inversion, offsets, branch relaxation
│   │   │                veneer.coil   ; hubs and routes for transfers out of B26 range
│   │   │                literal.coil } ; f64 literal islands
│   │   ├── image.coil       ; owned native images, Script entries and realm-object identities; capture; re-exports its parts
│   │   ├── image/  { abi.coil      ; versioned entry signature classes and export/import compatibility
│   │   │             install.coil  ; executable memory, bindings, import resolution, relocation, unit sites
│   │   │             run.coil }    ; fresh realm data, shared realm objects, the native entry
│   │   ├── sourcecache.coil ; bounded Script/host image caches, exact source/JSL keys, leased handles and owned Script programs
│   │   ├── serialize.coil   ; the ideal graph into the object file
│   │   ├── compunit.coil    ; owned Script declarations, shape/key assembly, static-image remapping; dependency tree, cross-unit IR linking
│   │   ├── callabi.coil     ; cross-unit call signature: three direct actuals and managed overflow
│   │   ├── objfile.coil     ; Mach-O and ELF writing/reading
│   │   └── gcmeta.coil      ; safepoint placement, stack maps, barrier lowering
│   │
│   ├── parse/               ; Simple's 2856-line Parser.java, split by concern
│   │   ├── lexer.coil       ; JS/TS tokens, regex-vs-divide, ASI, template literals
│   │   ├── parser.coil      ; the driver: sources → syntax → analyses → lowering → closed world; re-exports everything below
│   │   ├── syntax.coil      ; the thin syntax tree: node sums, records, arena accessors, walkers
│   │   ├── state.coil       ; ParserState, function contexts, the token cursor, syntax errors
│   │   ├── grammar/         ; tokens → syntax tree
│   │   │   ├── literal.coil     ; numbers, strings, templates, regex literals, object and array literals
│   │   │   ├── expression.coil  ; primaries, member chains, calls, the precedence ladder, assignment
│   │   │   ├── pattern.coil     ; binding patterns and the cover grammar
│   │   │   ├── statement.coil   ; statements and declarations
│   │   │   ├── function.coil    ; parameters, declarations, expressions, arrows, methods, strictness
│   │   │   └── class.coil       ; elements, keys, heritage, private names
│   │   ├── early.coil       ; early errors over the finished tree: strict mode, declarations, jumps
│   │   ├── analysis/        ; facts about the tree, computed before lowering
│   │   │   ├── declarations.coil ; what each scope declares; Script declarations and globals
│   │   │   ├── capture.coil      ; which bindings a nested function captures, and their owners
│   │   │   ├── throws.coil       ; which functions can complete with the exception sentinel
│   │   │   └── arguments.coil    ; how a function uses its arguments object
│   │   ├── lower/           ; syntax tree → ideal graph, straight through ScopeNode
│   │   │   ├── expression.coil  ; the expression dispatcher
│   │   │   ├── statement.coil   ; blocks, declarations, if, loops, switch, labels
│   │   │   ├── name.coil        ; scope slots, lexical and Script bindings, typeof operands
│   │   │   ├── reference.coil   ; an assignment target prepared once, then read and written
│   │   │   ├── operator.coil    ; unary, binary, short-circuit, conditional, assignment, delete, relational guards
│   │   │   ├── literal.coil     ; object, array and template literals
│   │   │   ├── member.coil      ; member reads and optional chains
│   │   │   ├── call.coil        ; plain, member, keyed, spread and new
│   │   │   ├── function.coil    ; headers, adapters, bodies, function objects, this, new.target, arguments
│   │   │   ├── class.coil       ; constructors, members, fields, static blocks, super
│   │   │   ├── environment.coil ; ✦ environment records for captured bindings
│   │   │   ├── pattern.coil     ; destructuring
│   │   │   ├── iteration.coil   ; for-in and for-of
│   │   │   ├── jump.coil        ; return, break, continue as pruned scope merges
│   │   │   ├── exception.coil   ; ✦ the sentinel completion through catch and finally
│   │   │   └── jsl.coil         ; ✦ calls from lowered source into the JSL library
│   │   ├── realm/           ; ✦ the global environment a program starts in
│   │   │   ├── globals.coil     ; the var-like binding table, assignment marking, global loads and stores
│   │   │   ├── intrinsics.coil  ; standard globals declared from JSL
│   │   │   ├── image.coil       ; the global object, function objects, prototypes as static heap data
│   │   │   ├── instantiate.coil ; GlobalDeclarationInstantiation for a Script
│   │   │   └── demand.coil      ; intrinsics lowered only once something observes them
│   │   ├── regex.coil       ; RegExp pattern early errors: strict, web-compat and v-mode grammars; re-exports its parts
│   │   ├── regex/  { chars.coil  ; code-unit constants, grammar character classes, Unicode property tables
│   │   │             class.coil } ; legacy classes and v-mode class sets
│   │   ├── tstype.coil      ; TypeScript annotation syntax → our lattice
│   │   └── decl.coil        ; hoisting, binding resolution, module records
│   │
│   ├── jsl/
│   │   ├── reader.coil      ; the s-expression reader for .jsl
│   │   ├── prims.coil       ; the primitive table
│   │   ├── check.coil       ; the checker — refuses BY NAME what it cannot lower; forms, definitions, units
│   │   ├── check/  { types.coil      ; type codes, names, assignability, joins, tag predicates
│   │   │             primitive.coil  ; result types of binary, unary and runtime primitives
│   │   │             expr.coil }     ; admitted expression forms and the type each yields
│   │   ├── lower.coil       ; JSL → ideal graph: graphs, link modes, units, the library index, the transition check
│   │   ├── lower/  { expr.coil        ; the environment, macro values, types, the expression dispatcher
│   │   │             primitive.coil   ; operators, property stores, runtime calls, pending throws, the argument vector
│   │   │             object.coil      ; ordinary and shaped allocation, string literals
│   │   │             call.coil        ; calls between definitions, calls of function values, closures
│   │   │             specialize.coil } ; a definition's own idealization rules (docs/SPECIALIZE.md)
│   │   └── decls.coil       ; (intrinsic …) read and flattened into the realm surface; (internal-slot …), (slot-list …) still stubs
│   │
│   ├── rt/                  ; the runtime, in Coil, built as its own object (Coil.toml `runtime`)
│   │   ├── number.coil      ; Number conversions shared by compiler and runtime: exact radix integers, `strtod` decimals, StringToNumber, parseInt/parseFloat, the NaN-box word; the libm-backed Math table
│   │   ├── abi.coil         ; RtHeap, realm lexical cells, unit data/key/shape bindings + folded offsets shared with encoders
│   │   ├── shapes.coil      ; the runtime shape tree: static `__aot_shapes` blob + runtime transitions
│   │   ├── rt.coil          ; the C ABI surface: the symbol table and the export-c list; re-exports everything below
│   │   ├── layout.coil      ; object headers, NaN-box prefixes, payload offsets, card and barrier kinds
│   │   ├── host.coil        ; libc declarations, output, time, rendering an uncaught value
│   │   ├── code.coil        ; registered text ranges, their stack maps and unit identities, frame walking
│   │   ├── stackmap.coil    ; stack map records, frame sizes, slot locations by return pc
│   │   ├── heap.coil        ; spaces, statistics, boot and reset, allocation
│   │   ├── gc.coil          ; the generational copying collector, root collection, the write barrier
│   │   ├── verify.coil      ; heap and root verification (`AOT_RT_GC_VERIFY`)
│   │   ├── statics.coil     ; adopting the linked heap image, unit identities and objects, static roots
│   │   ├── lexical.coil     ; realm lexical cells: top-level let/const storage and its state
│   │   ├── string.coil      ; code units, comparison, concatenation, substrings, UTF-8, key interning
│   │   ├── numeric.coil     ; Number::toString, StringToNumber, parseInt, parseFloat, the Math table
│   │   ├── symbol.coil      ; symbol creation, keys, descriptions
│   │   ├── property.coil    ; generic own-property get, set, define, delete; integrity levels
│   │   ├── array.coil       ; the elements store, growth, holes, length
│   │   ├── keys.coil        ; own-key enumeration and the argument tail
│   │   └── throw.coil       ; throw entry points, invariant traps, named refusals
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
│   ├── support.coil                 ; shared test construction helpers
│   ├── type-test.coil  node-test.coil  peephole-test.coil  phicon-test.coil
│   ├── bits-test.coil  compare-test.coil  control-test.coil  call-test.coil  copy-test.coil
│   ├── dynamic-test.coil  gc-test.coil  gcmeta-test.coil  select-test.coil  pipeline-test.coil
│   ├── scope-test.coil  mem-test.coil  shape-test.coil  rt-shapes-test.coil
│   ├── opto-test.coil  gcm-test.coil  sched-test.coil  regalloc-test.coil
│   ├── encode-test.coil  compunit-test.coil  verify-test.coil  text-test.coil
│   ├── lex-test.coil  parse-test.coil  regex-test.coil  tstype-test.coil  jsl-test.coil
│   ├── number-test.coil             ; StringToNumber grammar and the Number word (aot.rt.number)
│   ├── imagefacts-test.coil         ; the closed-world image facts: named, parameter and runtime-key stores
│   ├── property-test.coil           ; memory-position property proofs, identity propagation, storage transitions and worklist-order regressions
│   ├── image-test.coil              ; in-memory relocation, entry ABI, realm isolation and moving GC
│   ├── library-support.coil         ; the runtime-library provider retained Script units import from, for tests
│   ├── test262-test.coil            ; metadata, runner policy and accounting regressions
│   ├── web-test.coil                ; browser graph snapshots over the production frontend and optimizer
│   ├── bloat-test.coil              ; graph-size budgets: node-count ceilings after optimization
│   ├── versions-test.coil           ; callable version contracts, reuse, fallback and lifetime
│   ├── budget-test.coil             ; compile-time budgets as gates: rounds, shape, wall time (docs/COMPILE-TIME.md §7)
│   ├── execution-test.coil          ; cases that must RUN, not merely compile
│   └── differential-test.coil       ; compiled output vs. a JavaScript engine
├── benchmarks/              ; JavaScript/TypeScript input fixtures for native comparisons
├── web/                     ; GitHub Pages graph playground; HTML/CSS/JS presentation over Coil/Wasm
└── tools/
    ├── lint/
    │   ├── unused-imports.coil ; project lint rule (Coil.toml `[lint] rules`): an import nothing uses; `--fix` removes it
    │   ├── layout.coil      ; project lint rule: every source file has a row in this document, and every row a file
    │   ├── cond.coil        ; project lint rule: a staircase of three or more nested ifs is a cond; `--fix` rewrites it
    │   ├── ctor.coil        ; project lint rule: a struct zeroed then filled by set! is a named constructor; `--fix` rewrites it
    │   ├── written.coil     ; shared by the fixing rules: is a node the author's, and how to put it back as written
    │   └── size.coil        ; opt-in report: functions and files over a line budget
    ├── refactor/            ; refactoring metaprograms, inert unless named with `coil lint --use` (docs/REFACTORING.md)
    │   ├── source.coil      ; a module's top-level forms with the lines that travel with them; file reads and writes
    │   ├── split.coil       ; move selected forms into other modules; the source re-exports them
    │   ├── rename.coil      ; respell a definition everywhere, atomically, from the reader's symbol positions
    │   └── methods.coil     ; gather a module's functions into an `impl` block
    ├── dot-dump.coil
    ├── memory-run.coil      ; source-to-memory compilation and execution without subprocesses
    ├── compile-study.coil   ; diagnostic retained-Script pass timings, graph counts and project DOT snapshots
    ├── control-study.coil   ; identical-graph pairwise versus covered-subtree dominator scaling
    ├── test262-metadata.coil ; test262 frontmatter, required variants and include ordering
    ├── test262-policy.coil   ; independent source-unit plans and observed-result classification
    ├── test262-worker.coil   ; bounded sequential compiler/linker/native process execution
    ├── test262-memory.coil   ; persistent native-memory workers, bounded protocol and supervision
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
