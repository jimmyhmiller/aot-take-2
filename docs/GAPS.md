# Implementation gaps

This is the inventory of work that is absent or incomplete. “Implemented core gap” means the
surrounding module is live and the omission must not be hidden behind a future-phase label.
“Unwritten subsystem” means its public scaffold hard-errors by name. `HANDOFF.md` owns priority;
this file owns completeness.

## Implemented core gaps

| Area | Missing behavior | Consequence |
|---|---|---|
| Dynamic values | Box/Unbox construction and payload access beyond numeric tags | Every checker-admitted singleton TypeTest is selected and encoded; producing and consuming the remaining tagged payload families still requires their runtime nodes |
| Return | Concrete RPC nodes/types for the final four-input shape | Source/JSL Returns carry concrete bulk memory; RPC is reconstructed as a Parm before code generation while Fun ownership remains separate metadata |
| Calls | Multi-target SCCP lookup | Direct calls, clone inlining, arbitrary fixed arity and bulk-memory threading are complete; multi-target lookup awaits compilation units |
| Node API | Complete for every implemented node family | Includes cycle-safe two-pass selected-subgraph copy, payload preservation and Fun/Return + Call/CallEnd cross-link repair |
| Phi | Memory-specific same-op guards and the dominance-walk null merge | MemPhi construction, unary/binary scalar pull-down and structural zero/truthy-Cast merging are complete; Load/Store/MemMerge exist |
| Verification | Pointer/control/safepoint/unreachable-use checks | Core edge, dead-input, Phi arity, type and GVN checks are live; the remaining checks require their node families |
| Text IR/eval | Round-trippable graph text and IR interpreter | No durable reduced graph corpus or differential execution oracle |

Add’s Simple left-spine reassociation, constant sinking, Minus conversion, Phi-aware ordering and
Phi-constant push are implemented and regression-tested as of 2026-08-30; they are not open gaps.
Sub's two Minus normalizations and Mul's zero/power-of-two/`2^n ± 1` strength reductions and
Phi-constant push are also implemented and regression-tested.
Shl range sharpening and small-constant distribution are implemented. Dynamic-tag and function
pointer set meet now uses the exact complemented-set algebra in mixed high/low cases and carries
direct associativity regressions, preventing worklist-order-dependent SCCP results.
Tuples/signatures now support arbitrary arity, including memberwise dual/meet and return-type
replacement. Function pointers now carry a high/low set state and implement multi-target set
union/intersection, memberwise signature meet, dual, join and direct-call detection. Their lattice
laws and function indices above machine-word width are regression-tested.
Integer types now carry Simple's widening stage, arithmetic propagates it, and falling Loop Phis
advance through three widening identities before jumping to their declared bound. This bounds the
induction-range fixpoint and is regression-tested at both the type and graph levels.
Float Add/Sub/Mul/Minus and comparisons now fold IEEE constants and insert explicit `ToFloat`
nodes for mixed numeric operands. FunPtr types refresh when their Fun signature sharpens.
IterPeeps now performs Simple's unused-node cleanup and dependency wakeup after progress, and its
fixpoint audit checks monotonic types, both worklists, unused live nodes, and unapplied peepholes.
Optimistic SCCP now snapshots pessimistic types, resets to TOP, enforces both monotonicity bounds,
propagates to a fixed point, links direct calls lazily, resolves recursive numeric modes, and exposes
a node/input-cone fixed-point proof predicate. Branch-local JavaScript truthiness produces pinned
Casts on each CProj for integer and dynamic-tag precision. Scalar Phi same-op pull-down and the
zero/truthy-Cast merge are implemented. The core graph verifier is live.
Temporarily HIGH CallEnd result projections remain attached during optimistic target discovery so
later Return linking can sharpen the original result node.
Phi uniqueness is control-live-aware, all-dead Regions collapse directly, SCCP numeric evidence
crosses CallEnd result projections, and post-SCCP peepholes receive every live node. The verifier's
GVN freshness check recomputes current structure. IEEE float rewrites preserve evaluation grouping
and independently rounded division rather than inheriting Simple's integer-safe algebra.
Calls remain deliberately site-unique in GVN. Production parser and JSL lowering construct calls
with bulk memory, linking aligns the callee memory parameter, and Return/CallEnd thread the result;
the null-memory constructor remains only for focused incomplete-graph tests.
Phi openness follows both its Region and its final input, including the reverse-close state. Nested
If folding recognizes the dominating predicate through a true-arm truthiness Cast. Same-op Phi
pull-down covers every currently implemented eligible unary and binary scalar arity.

## Partial frontend and JavaScript semantics

- The lexer/parser lower named functions, hoisted calls, decimal integer spellings with full
  binary64 Number semantics, arithmetic calls, bindings, assignment, lexical blocks, conditional
  expressions, statement `if`/`else`, and nested `while`. Bare returns and live function
  fallthrough produce boxed `undefined`; early and loop-body returns merge through the function
  exit accumulator. Function parameter and return annotations are optional, admitting the
  corresponding ordinary JavaScript syntax. Strings, objects, classes, `for`, loop exits,
  exceptions, properties, closures, and most expressions remain.
- Scope SSA bindings, lazy Phis, branch merges, loop closure, memory binding, and guard machinery
  exist. The frontend uses binding/branch merge and atomic lazy-Phi loop closure today;
  source-level narrowing and nonlocal loop exits remain.
- JSL reading, indexed two-pass declaration/body lowering, refusal diagnostics, integer literals,
  lexical `let`, `if`, semantic calls, tag tests, complementary-edge Cast narrowing, and the
  numeric/undefined generic fallback exist. The full production JSL grammar and primitive surface
  remain.
- `JsOp` construction and the string/object/number primitives below JSL.
- Distinct JS32 primitive lowering for `%BitAnd/%BitOr/%BitXor/%BitNot/%Shl/%Shr/%Ushr`, including
  float-to-int32 conversion and modulo-32 counts. The implemented scalar bit/shift nodes are
  Simple-style internal i64 operations and must not be reused for this observably different job.

## Partial memory, object and runtime subsystems

- Pointer, memory and nominal struct lattice families are implemented with structural interning,
  dual and meet. Shape-set, string and full RPC behavior remain.
- Load, Store, MemMerge and ReadOnly nodes are implemented, including alias-aware Load-after-Store,
  distinct-alias bypass, Store-after-Store, precise MemMerge lookup, and the `MemOps` interface.
  MemPhi, allocation initialization and bulk call-memory threading are implemented. Full Simple
  memory escape/finality facts and the remaining Load/Store peepholes remain.
- Hidden-class transitions, inherited alias allocation and stable payload-relative property
  offsets are implemented. Shape-set lattice integration and property nodes remain.
- Named/keyed property and array access nodes.
- Closures and captured environments.
- Exceptional control edges.
- The Coil generational moving core, nursery promotion, compacting old-generation semispaces,
  remembered old-to-young edges, boxed-edge tracing, serialized-map parser,
  SP-relative raw/boxed root rewriting and automatic collection on semispace exhaustion are
  implemented. On Darwin the Coil runtime discovers the linked `__DATA,__aot_stackmaps` section
  through the executable Mach-O header. Explicit relocation nodes/projections, schedule- and
  dominance-sensitive R2 verification, post-write barriers, and typed maps from allocator liveness
  to final call/allocation return-PC offsets exist; Mach-O and ELF carry aligned stack-map sections.
  ELF runtime section discovery remains before linked Linux collection can claim parity.
- Coil throw paths. The Coil-owned `aot_rt_alloc(bytes,shape,map-id,caller-sp)` path, runtime header,
  zeroed payload, generational allocation, per-allocation stress collection and generated-code ABI
  are implemented.

## Unwritten optimizer, backend and compilation infrastructure

- Multi-target/escaping-function SCCP integration and semantic checks for the remaining JavaScript
  value families. Direct-call SCCP, node-aware proof, Stop-reachable type checking and the ordered
  production phase driver are implemented.
- Loop-tree construction and typed infinite-loop exit insertion are implemented for the current IR.
- Arm64 selection and ABI contracts are implemented for current ideal opcodes. The complete JS
  semantic/runtime node surface and x86-64 selection remain.
- GCM, memory anti-dependencies, durable local scheduling, register masks, LRG/IFG construction,
  coalescing, colouring, splitting/spilling retries and frame finalization are implemented. Phi
  edge copies follow final Simple's shared-LRG plus edge-Split model; cold-edge-first loop-Phi
  splitting and legal Split coalescing have direct coverage. Safepoint-specific allocation evidence
  and broader pressure stress coverage remain.
- AArch64 encoding, checked local/symbol relocation, literal pools, valid Mach-O/ELF arm64 objects,
  native Mach-O linking and a complete implemented ideal-to-native execution test are implemented.
  Split encoding includes IFG-proved X16 scratch expansion for stack-to-stack copies. Preference-
  aware branch inversion, iterative B19 relaxation through an inverted-condition/B26 veneer, and
  sparse layout-planned B26/BL26 veneer hubs beyond direct branch range are implemented alongside
  stack-map/object metadata. The ordered source-to-object driver and native execution matrix cover
  every currently admitted source form.
- Ideal-graph serialization, compilation units and dependency resolution.
- Assembly and ordinary IR printers. Graphviz is implemented.
- CLI `compile` and `run` are implemented; a user-facing IR/assembly dump command remains.

## Current Simple comparison boundary

The Stop-rooted hand-built programs in `tests/program-graph-test.coil` establish the structural
spine: Fun is a Region, Parm is a Phi, pure values float, If produces control projections, and
Region/Phi positions correspond. Parser, pipeline and native execution suites separately establish
source-to-graph and source-to-object behavior for every currently admitted syntax form. Return and
CallEnd preserve Simple's final `control, memory, value, RPC` / `control, memory, value` positions,
including concrete bulk memory, clearing RPC during trivial inlining and reconstructing the
architectural RPC Parm before code generation. Persisted compilation units and their serialized
envelope remain outside the implemented boundary.
