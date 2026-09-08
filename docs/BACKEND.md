# Backend contract

This is the dependency contract for the finished backend. It is derived from final Simple's
`CodeGen`, `Machine`, `MachNode`, `GlobalCodeMotion`, `ListScheduler`, `BuildLRG`, `IFG`,
`Coalesce`, `LRG`, `RegAlloc`, `Encoding`, `CFGNode`, and `LoopNode` implementations. It records
which ideal-graph mechanism produces every fact consumed after instruction selection. A backend
pass may not fabricate a missing fact locally: the named producer must supply and verify it.

The pipeline is:

```
IterPeeps -> Opto -> TypeCheck -> LoopTree -> Serialize -> Unlink
          -> Select -> GCM -> ListSchedule -> RegAlloc -> Encode -> Export
```

Serialization precedes destructive machine lowering so compilation units retain the optimized
ideal graph for cross-unit inlining. Calls are unlinked before selection; selected code contains
machine calls and ABI edges, not the optimizer's Call-to-Fun discovery edges.

## Ideal graph handoff

| Backend assumption | Producer in this repository | Required invariant | Current state |
|---|---|---|---|
| Dense stable node identities | `node/node.coil` arena | Every live node has one nonzero `nid`; an arena lookup returns that same node | Implemented and verified |
| Exact use-def symmetry, including duplicate uses | `node/node.coil` edge mutators | Each input occurrence has one matching output occurrence | Implemented and verified |
| Optimized graph is at a fixpoint | `codegen/iterpeeps.coil`, `codegen/opto.coil` | No live node has a pending legal peephole; SCCP types are monotone | Implemented for current node families |
| CFG classification | `node/control.coil::cfg-of` and `node/call.coil::cfg-of-ext` | Every control opcode is recognized in exactly this dispatch | Implemented for current control nodes |
| Pinned classification | each `NodeOps::is-pinned?` | Phi, projections, control and other fixed-placement nodes cannot be moved | Implemented for current nodes |
| Immediate dominator and depth | `CFGOps`, `idom-lca-nodes`, CFG versioning | Every reachable non-root CFG node has a legal idom; mutations invalidate cached depth | Implemented and verified |
| Block heads and tails | each `CFGOps::block-head?` | Start/Fun/Loop/Region/CProj/CallEnd head blocks; If/Call/Return tail blocks | Implemented for current nodes |
| Loop membership and depth | `codegen/looptree.coil`, stored per CFG node | Every reachable CFG node belongs to exactly one innermost loop tree; parents are acyclic | Implemented and verified for finite and forced-exit loops |
| Reachable exit for every loop | `codegen/looptree.coil::looptree-force-exit!` | A no-exit loop receives a Never split and a typed Return merge | Implemented and verified |
| Final Return/CallEnd tuple positions | `node/control.coil`, `node/call.coil` | Return is `(ctrl, mem, value, rpc)`; CallEnd projects `(ctrl, mem, value)` | Implemented for the current direct-call path; full RPC behavior belongs to compilation units |
| Calls have explicit effects | frontend/JSL plus memory SSA | Calls with observable effects are ordered by memory, never by GVN identity tricks | Production parser and JSL calls thread bulk memory; null-memory construction is test-only |
| Alias identity | `shape.coil`, `type/type.coil`, `node/memory.coil` | Every load/store carries a stable alias class; equal classes may conflict | Implemented for hidden-class fields |
| Load/store memory chain | `node/memory.coil`, `node/scope.coil` | Load and Store name their memory input and pointer; MemPhi follows Region arity | Implemented and verified |
| No unresolved representation guards | dynamic nodes plus typecheck | A live Unbox reaching selection has representation proof or an explicit generic path | Implemented; every checker-admitted singleton tag predicate has a concrete runtime classifier |
| Machine-lowerable type | typecheck plus machine selector | Every live ideal opcode/type pair has one legal target lowering or a named rejection | Missing |
| Safepoint semantics | GC ideal nodes and `gcmeta` | References do not survive relocation without redefinition; barriers are explicit | Produced and structurally verified |

## Instruction selection contract

Selection replaces the optimized ideal subgraph with machine nodes while preserving control,
data, memory, and projection relationships. It is not tree matching: shared nodes stay shared and
Phi cycles stay cycles.

Each selected node must provide:

- one allowed-register mask per data input;
- one result mask, or no result for pure control/effect nodes;
- a kill mask for implicit clobbers;
- a two-address input index when the output must reuse an operand;
- commutativity information used to satisfy a two-address constraint without an extra split;
- exact encoded-size and emission behavior;
- assembly rendering that describes the same selected instruction;
- relocation records for every unresolved symbol or PC-relative target.

The selector must also produce concrete machine forms for Start, Fun, Parm, Return, Call, CallEnd,
projections, constants, integer and floating arithmetic, comparisons, branches, loads, stores,
allocation, split copies, callee saves, safepoints, and barriers. The arm64 port is first and owns
one authoritative register numbering shared by masks, allocation, stack maps, and encoding.

Current producer: `codegen/machine.coil` now distinguishes absent non-register edges from empty
hard-conflict masks and declares indexed multi-results, post-selection actions, exact sizes,
rematerialization, kills, split metadata, branches, RPC and frame/argument-slot queries.
`codegen/regmask.coil` is an unbounded immutable mask with a cofinite stack tail, so arm64 flags do
not impose an accidental spill ceiling. `node/cpus/arm64/arm64.coil` implements the Darwin/AAPCS64
physical, caller-save, callee-save, reserved-register, argument-bank, overflow-slot and return
contracts. The first concrete family now exists: `node/cpus/arm64/base.coil` represents unpinned
scalar forms with exact input/output classes, immediate payloads, cloneability, fixed size and
allocator-facing metadata. `arm64/arith.coil` selects integer/register, unsigned-imm12, floating
and conversion forms; constants are cloneable definitions. `arm64/bits.coil` selects exact A64
logical-immediate payloads, constant and register shifts, and the explicit CMP/FCMP FLAGS -> CSET
dependency; `Not` advertises its FLAGS kill and two-instruction size. `arm64-select-graph` installs a shell
in its ideal-to-machine map before walking inputs and rebuilds output edges only after mapping,
preserving cycles and leaving the ideal graph untouched. CFG, bits, memory, call, GC-boundary and
encoding families are implemented for every ideal opcode that currently exists. Whole-language
selection is not claimed because much of the JavaScript/runtime ideal-node surface does not exist.

`arm64/mem.coil` now provides concrete Load/Store nodes. It strips the zero-code ReadOnly proof,
selects scaled unsigned imm12, unscaled signed imm9, or register-offset addressing, removes folded
offset constants from allocator inputs, distinguishes control/memory edges from base/index/value
register edges, preserves precise aliases through the generic MemOps hook, and selects GPR versus
FPR data registers. Memory/control lattice constants become zero-byte, non-LRG pseudo-values in a
selected graph. `New` now exists as final Simple's fresh-pointer/private-memory Multi, with an
additional public-memory ordering input because JavaScript object initialization and publication
may contain adjacent allocations. Shape identity remains distinct from its referent struct type;
arm64 selects a constant-size nursery bump path plus the
`aot_rt_alloc(bytes,shape,map-id,caller-sp)` exhaustion path. X28 holds the runtime heap state,
X0 carries bytes and the resulting payload, and the slow path materializes shape/map identity in
X1/X2 plus caller SP in X3. MemMerge and MemPhi
cross selection as zero-register memory pseudos; Safepoint and post-write Barrier have explicit
selected forms.

`arm64/branch.coil` lowers comparisons to direct FLAGS-consuming branches, inserts an explicit
test-against-zero for other predicates, represents Never's null predicate, and makes CProj a
zero-byte block head. Start, Stop, Region, Loop and XCtrl also cross selection as concrete CFG
pseudo-operations. The selected-CFG hook keeps `cfg-of` target-independent, and the selector copies
loop membership, loop parents/depth and CFG preorder before recursively mapping inputs. Region
dominator LCAs and Loop entry dominators continue to use the generic control algorithms.

`arm64/phi.coil` selects scalar Phi and zero-register MemPhi forms. `arm64/call.coil` selects Fun,
Parm, Call, CallEnd, Return, projections, frame setup/teardown and callee-save pseudos with exact
ABI masks. `arm64/split.coil` handles register moves, spills, reloads and stack-to-stack copies; the
latter use X16 as an IFG-proved fixed scratch, as recorded in `docs/DECISIONS.md`. Selection is
complete for every currently implemented ideal opcode. Missing selector families correspond to
ideal JS/runtime/GC node families that do not exist yet, rather than fallthrough in the target.

## Global code motion contract

GCM consumes the selected graph and constructs blocks. Final Simple requires these rules in this
order:

1. Walk the reachable control graph from Start in reverse postorder, skipping Call-to-Fun and
   Return-to-CallEnd optimizer links.
2. Schedule every movable node as early as legality permits: after the deepest scheduled input.
   Never recurse through Phi backedges.
3. Clone constants shared by different functions so no live range crosses function boundaries.
4. Schedule late from Stop only after every use is placed. The latest bound is the dominator-tree
   LCA of use blocks.
5. Treat a value used by Phi arm `i` as used in Region predecessor `i`, not in the Region block.
6. Choose the legal block with the shallowest loop depth, then the greatest dominator depth; never
   leave a value at an If tail.
7. For each Load, inspect users of its memory input and add anti-dependences against Stores of the
   same alias before choosing the final block.

Producers: CFG/idom/block-head facts, loop depth, memory SSA, aliases, and load/store classification
are implemented. `CodeGen` now owns explicit selected Start/Stop roots and CFG RPO storage.
`gcm-rpo!` walks selected control outputs, rejects a surviving Call-to-Fun optimizer edge, skips
Return-to-CallEnd links, records reverse postorder, and assigns every control node its block head.
`gcm-schedule-early!` schedules definitions before uses, skips Phi backedges, anchors pinned nodes,
and places movable nodes after their deepest scheduled input with a real control edge. The early
bound is preserved independently from the chosen block. `gcm-schedule-late!` waits for every use,
computes dominator LCAs, accounts for Phi arms on predecessor edges, and chooses the shallowest
loop then deepest control block without leaving work on an If tail. Loads additionally wait for
memory users; same-alias Stores and Calls raise the legal bound and a same-block Store receives an
explicit anti-dependence edge. Start-pinned constants and materialization chains shared by several
functions are recursively cloned and re-owned between early and late scheduling. Escape-specific
anti-dependences await the Escape node family.

## Local scheduling contract

List scheduling orders the already block-assigned machine nodes. Its dependency DAG contains:

- ordinary data dependencies;
- memory dependencies and GCM-discovered anti-dependencies;
- fixed control-tail placement;
- machine kill and fixed-register constraints;
- call ordering and safepoint ordering;
- explicit zero-byte projections placed immediately after their multi-definition.

The scheduler computes readiness from all dependencies, chooses among ready nodes using the same
latency/pressure policy for deterministic output, and emits every node exactly once. It may not
repair missing GCM placement or invent alias information.

Current producer: `codegen/listsched.coil` builds a strict block-local dependency DAG from the
GCM-assigned selected graph and writes a flattened, durable order plus per-block bounds into
`CodeGen`. It uses Simple's separate blocked/ready dependency counts, counts duplicate data edges
and explicit anti-dependencies, emits the block head first, treats Phi arms as predecessor-edge
uses, places explicit zero-byte projections directly after their multi-definition, and forces CFG
tails behind ordinary work. Its pressure score accounts for remote definitions, constrained ranges,
fixed input masks, two-address propagation, cheap cloning, and ranges closed by single uses.

Phi-edge splitting is allocator work. This is not a local-scheduler omission: final Simple unions
each Phi and its arms into one LRG, then inserts edge-local `SplitNode`s when that range
self-conflicts. There is no separate parallel-copy pass in final Simple, and this allocator follows
that same contract, including cold-backedge deferral for loop Phis.

## Register-allocation contract

Allocation is iterative graph coloring, not a one-pass greedy assignment:

1. Insert CalleeSave nodes and cache machine register constraints.
2. Build live ranges while intersecting every def/use allowed mask.
3. Pre-split a range whose allowed mask becomes empty, then restart the round.
4. Build liveness and the interference graph together. A singleton fixed register denies that
   color from neighbors instead of creating a dense row of interference edges.
5. Detect self-conflicting ranges, especially Phi cycles, and split them. Loop Phis receive the
   cold-edge split before a hot-edge split.
6. Coalesce noninterfering copies without violating masks.
7. Simplify trivially colorable ranges first using Simple's fixed/ordinary/Split reverse-color
   priority, then optimistic ranges; assign colors in reverse with biased Split-chain choices.
8. Split every failed range deterministically and retry, with the documented sixteen-round hard
   limit required by explicit moving-root boundaries.
9. Number spill slots after physical registers so split copies use one location namespace.
10. Remove no-op copies after coloring and finalize frame size, callee saves, and stack arguments.

Our extension carries a liveness kind on every live range: scalar, raw managed reference, boxed
word that may contain a reference, or boxed word proven not to contain one. Both boxed families can
receive addressable spill homes across calls, but only reference-bearing kinds enter relocation
maps. Coalescing and splitting preserve the conservative join of this evidence.

Current producer: `regmask.coil` represents arbitrary fixed locations plus the infinite spill tail
and is covered beyond location 512. `regalloc.coil` builds and unions LRGs, carries conservative GC
kinds, builds the IFG backwards over the durable schedule, applies fixed constraints and call kills,
coalesces, colours, inserts fixed-use and pressure splits, retries, removes no-op copies, inserts the
AAPCS64 callee-save ranges and finalizes stack frames. A live range restricted to root homes by a
safepoint is flagged `root-restricted`, and only such ranges take the managed-root split
boundaries; every live range with a register use must have a machine definition, checked after
BuildLRG. Safepoint relocation nodes, typed stack maps,
and aligned object sections are implemented as described below.
Direct regression coverage proves conservative copy coalescing unions a legal Split/source pair,
while interference and fixed masks prevent illegal unions.

## Encoding and object contract

Encoding is layout-sensitive and iterative. It must:

- assign block order using control frequency and loop depth, keeping cold exits out of line;
- choose branch inversion and fallthrough without changing Phi predecessor meaning;
- compute instruction and block offsets until displacement-dependent sizes stabilize;
- emit exact bytes only after allocation and frame layout are final;
- record internal branches, external symbols, literals, and compilation-unit references as typed
  relocations;
- emit stack maps keyed by final return-PC/safepoint offsets;
- write a valid arm64 Mach-O object first, then add ELF and x86-64 without changing the generic
  machine contract;
- link with `cc` only as a linker and execute without any authored C shim.

Current producers: `encoding.coil` projects GCM RPO through the loop tree so every nested loop body
is a contiguous interval while relative RPO within each nesting level is retained. It records stable
scheduled offsets, aligns every function entry to 16 bytes, verifies selected sizes during
emission, makes physical fallthrough explicit by inverting selected branches or appending a
target-owned unconditional jump, applies checked AArch64
`B.cond`/`B` local fixups, retains typed symbol-bearing `BL` fixups, and writes aligned exact-bit
deduplicated f64 literal islands. A monotone relaxation loop expands an out-of-range conditional
into an inverted `B.cond +8` followed by a checked `B26`; sparse layout-planned veneer hubs route
`B26` and closed-world `BL26` targets beyond direct range without consuming a scratch register.
Local-fixup addends identify the relaxed instruction exactly. Structural tests cover nested-loop
splicing; exact-byte tests cover both branch polarities, the neither-successor-adjacent case, every
B19 boundary, conditional relaxation and far B26/BL26 routes.
The arm64 machine families emit
scalar, memory, copy/spill, branch, call, frame and return instructions. `objfile.coil` writes
independently validated arm64 Mach-O and ELF64 relocatable objects with definitions, undefined
targets and branch relocations; its typed subprocess path links Mach-O with `cc` as a linker and
executes a selected `main` returning 42.

`gcmeta.coil` now reconstructs liveness backwards from the allocator's final block live-outs,
recognizes calls and allocations as safepoints, and records raw-reference or reference-bearing
boxed-word locations at their final encoded return PCs. Scalars and proven non-reference boxed
words are deliberately omitted. Direct tests cover both an empty
call map keyed at byte four and a typed raw-reference register entry. It serializes one versioned,
target-neutral little-endian format with text-relative return PCs and fixed-width typed location
records. `objfile.coil` emits those identical bytes as aligned `__DATA,__aot_stackmaps` Mach-O and
`.aot_stackmaps` ELF sections. `otool` and LLVM object inspection independently validate both.

`node/gc.coil` also supplies the explicit moving-GC relocation form: Safepoint is a pinned tuple of
control, memory and live managed values, and each live value re-emerges through its indexed ordinary
Proj. The verifier rejects scalar live entries and missing relocation projections. Arm64 selection
preserves Safepoint as a zero-byte machine boundary with GPR constraints on both live inputs and
relocated outputs, so register allocation sees the relocation dance instead of erasing it.
After local scheduling, `gc-verify-relocations?` checks the authoritative instruction order and CFG
dominance: an earlier use is legal, while a same-block-later, dominated-block, or Phi predecessor-edge
use of the pre-relocation value is rejected.

Reference-bearing Stores are also rewritten through one idempotent post-write Barrier. Arm64 lowers
the boundary inline using header-embedded generation/card metadata and fixed scratch kills; it has
no call, relocation, or safepoint. Scalar Stores remain
barrier-free.

`New` normally compares and advances the nursery cursor inline through the compiler-reserved X28
heap-state register, writes the three-word header, and zeroes its constant-size payload. Exhaustion,
GC stress, and statistics mode branch to `aot_rt_alloc(bytes,shape,map-id,caller-sp)`, which remains
the collecting safepoint. Consequently shape field offset zero remains the
first user-visible word; generated code has no host-allocator symbol or header arithmetic.

Allocation uses a Coil-owned copying nursery and a compacting two-semispace old generation. Minor
collection ages first survivors in the other nursery semispace, promotes repeated survivors, scans dirty 512-byte old-space cards through a per-card
object-start table, and clears the nursery. The post-write ABI carries a compiler-proven raw/boxed
kind so remembered raw references and NaN-boxed references take their respective forwarding paths. Major
collection copies the reachable young-and-old closure into the other old space. On exhaustion the Darwin runtime discovers the
linked `__DATA,__aot_stackmaps` section, selects the record by X2 identity, rewrites SP-relative
raw and boxed roots, walks generated callers by saved return PC, traces boxed object fields, and
retries the allocation. `AOT_RT_GC_STRESS` runs the same collection path before every generated
allocation without changing normal policy when it is absent. `AOT_RT_GC_VERIFY` checks, before and
after every collection, that each mapped frame root and each field of every live object points
into the active young or old space, and aborts naming the frame, return PC and slot of the first
stale pointer; `AOT_RT_GC_STATS` reports collection counts and barrier activity at exit.

Work outside this nine-stage backend slice remains: compilation-unit/serialized-IR sections,
explicit loop-backedge safepoint placement, and cross-platform linked execution coverage. The
source-to-object phase driver and execution suite
cover the complete implemented source-to-native arm64 path—parsing, optimization, selection, GCM,
local scheduling, iterative allocation, frame finalization, encoding, Mach-O writing, linking and
execution—without hand-assigned registers.

## Required implementation order

The dependency order is strict:

1. loop tree and typed forced exits;
2. pointer/memory lattice, aliases, memory SSA, and real call threading;
3. complete machine-node and arm64 ABI contracts;
4. arm64 instruction selection;
5. GCM with memory anti-dependencies;
6. local scheduling and parallel copies;
7. iterative register allocation with GC-kind liveness;
8. encoding, relocations, stack maps, Mach-O output, linking, and execution tests.

Every stage receives structural tests before the next stage begins. Placeholder backend tests are
deleted when the first real test lands; they never remain beside real tests and inflate the count.
