# Implementation gaps

This is the inventory of work that is absent or incomplete. “Implemented core gap” means the
surrounding module is live and the omission must not be hidden behind a future-phase label.
“Unwritten subsystem” means its public scaffold hard-errors by name. `HANDOFF.md` owns priority;
this file owns completeness.

## Implemented core gaps

| Area | Missing behavior | Consequence |
|---|---|---|
| Dynamic values | Box/Unbox representations beyond numeric tags | The declared JS value space is not covered |
| Return | Concrete memory and RPC nodes/types for the final four-input shape | Slots and projection numbering are final; memory and RPC are explicit null/`TOP` inputs while Fun ownership is separate metadata |
| Calls | Multi-target SCCP lookup and memory threading | Direct calls and clone inlining are complete; multi-target lookup awaits compilation units and memory threading awaits memory SSA |
| Node API | Complete for every implemented node family | Includes cycle-safe two-pass selected-subgraph copy, payload preservation and Fun/Return + Call/CallEnd cross-link repair |
| Phi | Memory-specific same-op guards and the dominance-walk null merge | Unary/binary scalar pull-down and structural zero/truthy-Cast merging are complete; memory nodes do not exist |
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
Calls are deliberately site-unique in GVN while their memory input is null, preventing identical
argument lists from merging distinct effects. Memory SSA can replace that temporary identity with
the real memory-dependence identity when it is implemented.
Phi openness follows both its Region and its final input, including the reverse-close state. Nested
If folding recognizes the dominating predicate through a true-arm truthiness Cast. Same-op Phi
pull-down covers every currently implemented eligible unary and binary scalar arity.

## Unwritten frontend and JavaScript semantics

- Lexer, parser, declarations/hoisting, TypeScript annotation parser, and source-driven function,
  class, loop, exception and expression graph construction.
- Scope SSA: bindings, lazy Phis, merges, loop closure, memory binding, and guard installation and
  removal.
- Frontend SSA integration of the implemented true/false CProj truthiness refinements.
- JSL reader/index loader, declaration reader, primitive table, checker/refusal diagnostics,
  lowering, and transition verification.
- `JsOp` construction and the string/object/number primitives below JSL.
- Distinct JS32 primitive lowering for `%BitAnd/%BitOr/%BitXor/%BitNot/%Shl/%Shr/%Ushr`, including
  float-to-int32 conversion and modulo-32 counts. The implemented scalar bit/shift nodes are
  Simple-style internal i64 operations and must not be reused for this observably different job.
- `AddNumericValues` must range-check an integer sum before `%Box`: two valid signed 48-bit
  immediates can sum outside the immediate payload and `%Box` truncates that value. Once JSL
  lowering is live, the overflow path must box an f64 result (or numeric addition must use f64
  conservatively).

## Unwritten memory, object and runtime subsystems

- Pointer, memory, struct, shape-set, string and RPC lattice families.
- Memory SSA nodes: Load, Store, New, MemMerge, MemPhi and ReadOnly.
- Hidden-class transitions, inherited alias allocation and property offsets.
- Named/keyed property and array access nodes.
- Closures and captured environments.
- Exceptional control edges.
- Safepoints, barriers, relocation projections, stack maps and collector metadata.
- Coil runtime allocation, collection and throw paths.

## Unwritten optimizer, backend and compilation infrastructure

- Multi-target/escaping-function SCCP integration, type checking and the phase driver. Direct-call
  SCCP and node-aware proof are implemented.
- Loop tree and infinite-loop exit handling.
- Instruction selection for arm64 and x86-64.
- Global code motion, anti-dependencies and block construction.
- Local scheduling.
- Register masks, liveness, interference, coalescing, coloring and spilling.
- Instruction encoding and relocation.
- Ideal-graph serialization, compilation units, dependency resolution, Mach-O and ELF output.
- Assembly and ordinary IR printers. Graphviz is implemented.
- The CLI compile/run/dump pipeline.

## Current Simple comparison boundary

The Stop-rooted hand-built programs in `tests/program-graph-test.coil` establish the implemented
spine: Fun is a Region, Parm is a Phi, pure values float, If produces control projections, and
Region/Phi positions correspond. They do **not** establish source-to-graph equivalence because the
frontend, concrete memory/RPC Return members, compilation-unit envelope and branch-local refinement
above do not exist yet. Return and CallEnd now reserve and preserve Simple's final
`control, memory, value, RPC` / `control, memory, value` positions, including clearing RPC during
trivial inlining and preserving the full linked Return tuple in CallEnd.
