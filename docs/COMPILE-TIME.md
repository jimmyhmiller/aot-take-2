# Compile time: the shape of the graph, the frame model, and the budgets

This document is the architecture for how much a compile may cost and why. It exists because the
same failure has now happened twice: the pipeline was correct, every pass was locally reasonable,
and compiling two hundred lines of JavaScript took seconds. Each time the cause was not a slow
pass but a wrong shape, an invented policy where Simple or the production engines already had an
answer. The corrections below are decisions (docs/DECISIONS.md, 2026-09-08, "the compile-time
architecture"); this file is the reasoning, the budgets, and the road.

Read docs/LAYOUT.md first for the pipeline itself. Nothing here adds a phase or a pass. It changes
what the frontend hands the backend, what a frame promises, and what the allocator is asked to do.

---

## 1. The standard

A compiler's time is spent per node, and its nodes should be proportional to the source. Both
have budgets, and both are gated (§7).

| Quantity | Budget | Why this number |
|---|---|---|
| Machine nodes per source token | ≤ 4 | A dynamic operation with no type evidence is one call; a typed one is one or two nodes; a property access with a visible owner is one Load. Four is generous. |
| Basic blocks per source statement | ≤ 2 | A statement with no branching source has no branching object code. Calls do not split blocks (§4). |
| Register-allocation rounds | ≤ 3 typical, 7 hard | Simple's own expectation and its hard limit. A round is a full live-range, interference and colouring rebuild; needing many is a policy bug, not pressure. |
| Compiler time per machine node | single-digit microseconds | A native compiler's ordinary cost. 78 µs, where we were, is an algorithmic defect somewhere. |
| test262 harness realm (assert.js, sta.js, one test) | under 100 ms wall | This is the floor every one of ninety thousand campaign cases pays. |

The harness, for calibration. "Start" is 2026-09-08 after the string-literal, symbol-table,
dominator and mask fixes; "Now" is after milestones 1, 2, 3 and 6 and the backend constant-factor
fixes recorded in §6.

| Measure | Start | Now | Budget implies |
|---|---|---|---|
| Source | 212 lines, about 1,600 tokens | | |
| Machine nodes entering allocation | 11,200 | 11,000 | ≤ 6,400, and far fewer with evidence-gated inlining |
| Blocks | 3,246 | 3,246 | ≤ 500 |
| Conditional branches | 1,039 | 1,039 | |
| Callee-save nodes | 630 (35 functions × 18) | 18 | 18, in the entry wrapper only |
| Cast moves | 612 | 0 | 0 |
| Split copies | 578 | 1,615 (every value that crosses a call now takes a slot) | |
| Allocation rounds | 8 | 5 | ≤ 3 |
| Register allocation | 526 ms | 50 ms | |
| Stack maps and encoding | 205 ms | 27 ms | |
| Global code motion | 179 ms | 8 ms | |
| Optimizer (iter + opto) | 400 ms | 170 ms | |
| User time | 1.30 s | 0.28 s | < 0.1 s |

The volume rows are unchanged because they are the front end's (§4, §5); the time rows are what
the backend corrections bought. The realm image (§8, row 8) landed after this table: it removes the
realm's fixed part (611 → 56 nodes after opto for `var x = 1;`) and every hoisted function
declaration's object (about 100 → 0 nodes after opto), but the test262 harness builds its
functions as expressions assigned to properties (`assert.sameValue = function …`), which are not
run-once by syntax, so its user time stayed at 0.28 s; the budget test's harness realm, which
declares its functions, went from 5,649 to 4,870 machine nodes and 1,171 to 1,066 blocks.

---

## 2. Where the volume comes from, and the four corrections

Measured on the harness. Each row is a design choice, not a tuning knob, and each has a decision.

| Source of volume | Mechanism today | Correction (decision) |
|---|---|---|
| Type dispatch inlined at every site | Simple's size-only inline rule (100 nodes) inlines `typeof`, `===`, property access as a 5–9-way TypeTest chain even when every argument is bottom, so nothing folds | **Evidence-gated inlining** (§5) |
| A block and five nodes per call | Every source call is followed by a Load of the pending-exception word, a Cmp, an If and two CProjs | **Exceptional CallEnd projection** (§4) |
| Whole-function fixed live ranges | 18 CalleeSave nodes per function, each a live range spanning the whole body; every definition subtracts its register from 18 masks | **All-caller-save frames** (§3) |
| Extra colouring rounds | The invented managed-root splitter forces boxed values live across a safepoint to stack homes, def side and use side, in rounds of their own | **All-caller-save frames** (§3): a call kills every register, so Simple's ordinary empty-mask splitting produces the slot |
| A `mov` per Cast | A Cast selects to a real move "in case allocation does not coalesce" | **Cast is Simple's zero-byte two-address GuardMach** (§6) |
| Full list-schedule per round | `ra-split-all!` re-runs the scheduler over the whole program after inserting splits; Simple inserts a split into its block's order | **Splits enter the block order directly** (§6) |
| Second liveness for stack maps | The encoding phase recomputes liveness with a fixpoint that rescans every node every iteration | **Word-level gen/kill liveness, computed once** (§6) |

---

## 3. The frame model: JavaScript frames preserve no registers

**Decision.** A function compiled from JavaScript or JSL preserves no register across its body.
Every Call, New, JSOP and Safepoint kills every allocatable register, for every live-range kind.
A value live across one of them therefore reaches a stack slot through Simple's ordinary
splitting: the kill empties its mask, the range fails, `split` places the copy. The stack map
records slots and nothing else. CalleeSave nodes exist in exactly one function, the process-entry
wrapper, which is the C boundary and must honour AAPCS64 for its caller.

**What Simple does.** Simple's frames are C frames: a CalleeSave node per AAPCS64 callee-saved
register per function, and a Call kills only the caller-save set, so a value can ride a
callee-saved register across a call. Simple can afford this because it never has to find a value
afterwards; it has no collector.

**What the engines do.** HotSpot's Java convention, V8's JS frames, SpiderMonkey's Ion frames,
Go's register ABI and OCaml all preserve no registers across managed calls; LLVM's statepoint
pass spills every live pointer at the call for the same reason. The two systems that keep
callee-saves pay with machinery we do not want: .NET locates saved registers through per-frame
unwind info, JavaScriptCore scans the stack conservatively and gives up moving collection.

**Consequences in the tree.**

- `regalloc.coil`: `ra-insert-callee-saves!` runs for the entry wrapper only. The safepoint kill
  applies the full allocatable mask to every live range regardless of kind; `root-restricted`,
  the managed-root splitters, and the boxed-scalar distinction that existed to give scalars the
  register policy are removed. The round cap returns to Simple's (fail at round 7).
- `gcmeta.coil`: unchanged in contract. Registers never hold a managed value at a safepoint, so
  the map records slots; the kinds that select what to record stay.
- The runtime's C-ABI calls (`aot_rt_alloc`, primitives) kill everything too. A scalar could
  legally survive one in x19–x28, but one rule is worth more than that register.
- Cost: a store and a load around a call for each value that survives it. JavaScript is
  call-heavy; HotSpot and V8 accept exactly this cost for exactly this language shape.

---

## 4. Exceptions: an exceptional projection on CallEnd

**Decision.** A call that can throw has two control successors: the ordinary CProj and an
exceptional CProj. A callee that throws stores the thrown value in the pending word (as today) and
returns the exception sentinel, a reserved boxed word no JavaScript value can be; the caller's
CallEnd compares the returned word with the sentinel and takes the exceptional edge. A function
with no handler for that edge returns the sentinel itself; a `try` binds the pending word on the
edge and clears it. The pending word's flag field goes away; the sentinel is the flag.

**Landed 2026-09-09** (docs/DECISIONS.md, exceptions are a sentinel completion), in the refined
form below: the exceptional edge is the If on a `TypeTest` of the call's value projection for
`TAG-EXCEPTION`, folded by SCCP wherever the callee's return type excludes the tag. On the harness
the optimized graph lost 71 Loads and 73 compares and gained 50 TypeTests; the graph is smaller and
carries no memory dependence for exceptions. Building the test at every direct call and leaving
the folding to SCCP cost a third more optimizer time (the folds happen after the callee's return
type descends), so the syntactic may-throw filter stays as an optimization with a soundness guard;
with it the harness realm in test262 order compiles faster (opto 169 → 135 ms) while the reverse
order compiles slower (134 → 174 ms), a swing the optimizer already had with program order. The
"−265 blocks, −1,300 nodes" estimate in §8 was wrong: the pending check's block was already
folded into the call's block by the branch layout.

**What Simple does.** Nothing; Simple has no exceptions.

**What the engines do.** HotSpot's Call is a multi-node with a Catch projection; V8's throwing
calls have `IfSuccess` and `IfException` projections. Both then unwind by tables, paying nothing on
the normal path. SpiderMonkey's VM calls return a sentinel the caller tests. Swift keeps the error
in a dedicated register the caller tests after every throwing call. JavaScriptCore does what we
do today: loads the VM's pending-exception field after every operation.

**Why the projection regardless of mechanism.** The representation is the sea-of-nodes shape all
of them share, and it costs two CProjs instead of Load, Cmp, If, two CProjs and a block per call.
The mechanism behind the edge is the sentinel test now, one compare of a value already in a
register; it can become table-driven unwinding later without changing the graph, because stack
maps are already keyed by return PC.

**Mechanism, refined after measurement.** The sentinel is best expressed as a *tag* in the dynamic
lattice, `TAG-EXCEPTION`, with its own reserved NaN-box prefix: then the exceptional test is the
existing `TypeTest(value, TAG-EXCEPTION)` on the call's value projection (a prefix compare, no
load), a Return on a throw path returns the sentinel constant typed `dyn{exception}`, and SCCP does
the may-throw analysis for free: a callee whose return type excludes the tag folds every check at
its callers, and a value that may carry the tag is visibly not a JavaScript value wherever it flows.
That last point is the discipline the pending word never demanded: today a JSL body that calls a
throwing builtin computes on with `undefined` until the enclosing source function's check; with a
sentinel every JSL call site of a may-throw definition needs its own check, and the JSL checker
must infer and enforce a `:throws` property the way it enforces `:transitioning`. The pending word
keeps the thrown value; its flag field disappears.

**Consequences in the tree.**

- `call.coil`: CallEnd produces control at two projection indices. The verifier requires both
  when the callee may throw and neither is a Phi-less dangling edge.
- `parser.coil` and `lower.coil`: `throw` outside a `try` returns the sentinel; the value-call
  and primitive-call pending checks (`lower-throw-value!`, the post-merge checks) are replaced by
  wiring the exceptional CProj to the enclosing catch target or to a sentinel Return. `finally`'s
  completion record is unchanged; it hangs off the exceptional edge instead of a pending check.
- JSL builtins that throw return the sentinel; `%SetPendingException` becomes "store and return
  sentinel". Builtins that cannot throw are marked so and get no exceptional edge.
- Selection: the CallEnd's exceptional projection is a `cmp` against the sentinel immediate and
  a `b.eq`; no load.
- `rt.coil`: the entry reports the sentinel from the last Script as a nonzero exit, as today.

---

## 5. Inlining a JSL operation needs evidence

**Decision.** A CallEnd whose target is a JSL definition inlines only when inlining can fold
something: some argument's type is strictly sharper than the formal it meets, or the body is tiny
(a fixed small cap, currently 12 nodes, the size of a boxing shim). Otherwise the answer is DEFER
with dependencies on every argument, so a later sharpening (SCCP, an outer inline) re-asks; a
JSL call that never earns its inline stays a call to the one shared out-of-line builtin, which
the runtime object already carries. Source functions keep Simple's rule unchanged.

**What Simple does.** Inline when the body is under 100 nodes, the target is unique, the
function is not self-recursive, and the arguments `isa` the formals. That is the right rule for
Simple because Simple never inlines a generic dispatch: `a + b` is one node before any inlining.
A JSL body is a generic dispatch by construction, and inlining it where nothing folds buys the
dispatch tree at the site instead of a call to the same tree.

**What the engines do.** JSL is modelled on Torque, and Torque builtins are shared out-of-line
code; TurboFan inlines a fast path only where type feedback picks one. JavaScriptCore's DFG and
HotSpot's C2 do the same with profiles. We have no feedback and no deoptimisation; we have static
evidence, the SCCP types. The rule is the same with the evidence source swapped.

**What this preserves.** The TypeScript thesis: a discharged annotation is exactly "an argument
sharper than the formal", so typed code specialises fully and the guard folds, as before. A
literal receiver, a known shape, a constant operand: all are evidence. Only the bottom-typed site
changes, and it becomes one call.

**Consequences in the tree.** `callend-inline-candidate` gains the evidence test for JSL-owned
targets (`jsl-fidx?`); the body-size cap stays for source functions. `tests/bloat-test.coil`
gains the per-token ceiling of §7.

---

## 6. Backend corrections that are Simple's algorithm, done Simple's way

These are not decisions about design; they are places where we did more work than Simple does.

- **Cast costs no instruction.** Simple's `GuardMach` is a machine node that encodes nothing and
  is two-address on its input, so allocation gives the guarded value and its narrowing one
  register. Our guards are dense (every dynamic operation narrows on every arm), and the
  two-address union of a value with each of its narrowings made one live range with many
  simultaneously live definitions that the allocator then split apart again (578 splits became
  1,904). So the Cast keeps the part that matters, the pin that bounds GCM and the local scheduler,
  and is erased once the block order is fixed (`sched-erase-casts!`): its users read the value it
  narrowed, and no later phase moves a node.
- **Splits enter the block order.** `ra-split-one!` inserts the copy into the block's schedule
  at the def or use position, as Simple's `insertBefore`/`insertAfter` do. The list scheduler runs
  once, before allocation. `code-schedule-*` gains an insert-at operation; the flat schedule array
  becomes per-block lists.
- **Liveness for stack maps is computed once, word-level.** Per-block gen and kill bitsets over
  live-range ids, a worklist fixpoint on 64-bit words, phi-arm uses added to predecessor live-outs
  once before the fixpoint. `gc-live-new` reads the block row instead of rebuilding an array.
- **Allocator data structures are dense.** Live sets and live-outs are arrays indexed by
  live-range leader (done for the block live set); the interference edge set stays a hash keyed by
  the canonical pair, as Simple's bitset-then-adjacency conversion effectively is.
- **Hard conflicts pre-split in one round.** Rounds 0–3 today each fail one fixed-def/fixed-use
  range in cascade. Simple pre-splits all of them inside BuildLRG. Find why the pre-split leaves
  a new conflict and fix the splitter, not the budget. (Rounds 0 and 1 are structural: BuildLRG
  conflicts, then the kill conflicts only the IFG can see. Rounds 2–4 are copies and constants
  made in one round failing the next.)

Measured and fixed while landing the above (each was a constant factor Simple does not pay):

- Masks are bump-allocated from chunks reset per compile, with the first 128 locations inline
  (`regmask.coil`); every mask operation used to malloc twice.
- Every integer-keyed map uses integer key-ops, and the dependency pair key is mixed before
  hashing: an identity hash of `(dep << 32) | watcher` put every pair a watcher registers into one
  probe chain.
- The stack-map recorder's live set is one scratch filled from the live-out row's set bits, not an
  lrgs-sized array per block; GCM's global-constant clone memo is one scratch cleared through the
  ids it set, not an arena-sized table per constant.
- `cfg-of` tests CProj, If and Region first; the control-edit predicate is memoized per opcode;
  read accessors of the arena do not re-check boot; env flags are read once.
- The allocator's per-block live set and the block schedules are per-block lists, not hash maps
  or one flat array shifted on every insertion.
- The owning Fun of a control node is a memoized dominator walk (`cfg-owner-fun`), shared by the
  self-recursion check, GCM's global splitting and frame finalization; the version guarding the idom
  and owner caches bumps only on control-edge edits (a merge's paths, any node's input 0), not on
  data-input rewires, and a kill is tolerated by a liveness check instead of a bump.
- Three splitter rules Simple does not need under kill-all: a union's representative definition
  prefers a fixed-register endpoint (Simple's `LRG.union`), a rematerializable constant is never
  cloned into a Phi arm whose range lives on the stack, and a range emptied by a kill with no fixed
  endpoint is split on every side regardless of loop depth.

---

## 7. Gates

Deterministic quantities are hard tests; wall time is a coarse ceiling that only catches
catastrophes. This is how V8, LLVM and Rust track compile time: exact metrics gate, noisy ones
alert.

- `tests/bloat-test.coil` asserts, for the harness realm and for each fixture family: machine nodes
  per source token ≤ 4; blocks per statement ≤ 2; Cast machine nodes = 0; CalleeSave nodes = 18.
- `tests/regalloc-test.coil` asserts allocation rounds ≤ 3 on the fixture corpus and that the
  harness realm has no `root-restricted` range (the field no longer exists after §3).
- `tests/execution-test.coil` asserts the harness realm compiles under 1 s wall on any machine
  (ten times the budget; the point is the four-hour campaign, not the millisecond).
- The test262 runner records per-case compile time; the campaign report lists the ten slowest
  cases and fails the campaign if any case exceeds its deadline (`AOT_T262_COMPILE_SECONDS`,
  which drops to 5 s once §3–§5 land).

---

## 8. The road, in order of leverage over risk

Each milestone lands green with its tests and docs, and moves the harness numbers in §1. The
order is chosen so that each step shrinks what the next one has to handle.

| # | Milestone | Acceptance | Expected harness effect |
|---|---|---|---|
| 1 | Splits enter the block order; no per-round reschedule (§6) | Allocator tests green; `sched-run!` called once per compile | **Landed 2026-09-08.** |
| 2 | Cast is a zero-byte node erased after scheduling (§6) | Zero bytes and zero moves from Cast; execution suite green | **Landed.** |
| 3 | All-caller-save frames (§3) | CalleeSave only in the entry wrapper; managed-root splitters and `root-restricted` deleted; GC stress and verify green | **Landed.** 18 CalleeSaves, 5 rounds (target ≤ 3 still open), regalloc 526 → 59 ms |
| 4 | Exceptional CallEnd projection (§4) | Every pending-check lowering path deleted; `assert.throws`, `finally` and nested-catch tests green | **Landed 2026-09-09** as the sentinel completion. Optimized harness graph 7,573 → 7,444 nodes, −71 Loads, −73 compares; harness realm in test262 order (sta.js, assert.js, test): opto 169 → 135 ms, user 0.32 → 0.28 s (the reverse file order goes 134 → 174 ms: the optimizer's time swings with program order either way); the pending flag, its alias and its runtime root are gone, and the JSL checker enforces `:throws` |
| 5 | Evidence-gated JSL inlining (§5) | Bottom-typed sites are calls; typed fixtures unchanged in node count; bloat ceilings hold | **Landed**, but see §10: it removed little on the harness, because almost every argument carries a partial tag set and the volume is made at lowering, per site |
| 6 | Word-level GC liveness, once (§6) | Stack-map tests green; encoding phase under 20 ms on the harness | **Landed.** 205 → 31 ms (the remainder is layout and emission) |
| 7 | Gates (§7) | The listed assertions exist and are red when any of 1–6 is reverted | **Landed in part**: `tests/budget-test.coil` gates CalleeSaves, Casts, rounds, node and block ceilings and a 1 s wall ceiling on a harness realm; per-token and campaign gates remain |
| 8 | The realm's initial heap as data: the static heap image (docs/DECISIONS.md, the realm image) | Realm creation and hoisted function objects are `__aot_heap` entries; no New for them in any graph; GC stress and verify green over image objects | **Landed 2026-09-08.** Smallest realm 611 → 56 nodes after opto; a function declaration 100 → 0; budget harness 5,649 → 4,870 machine nodes, 1,171 → 1,066 blocks. Reordered ahead of 4 on the §10 measurements: cheaper to build, no runtime trade-off, more nodes removed per site |

Milestones 1, 2 and 6 are backend-local and touch no semantics. Milestone 3 changes the frame
contract and is the one with runtime exposure; it lands with the GC stress suite. Milestone 4
changes the IR contract for calls and the lowering of `throw`, `try` and `finally`; it is the
largest and lands with the exception execution tests. Milestone 5 is a one-function change in the
inline decision plus its tests, and is last because its budgets are only meaningful once 3 and 4
have removed the volume that is not the front end's.

---

## 9. Precedent, for the record

| Question | Simple | HotSpot C2 | V8 TurboFan | SpiderMonkey Ion | Others |
|---|---|---|---|---|---|
| Registers across calls | AAPCS callee-saves; no GC | None in Java frames | None in JS frames | None across JS calls | Go: none, by design; OCaml: none; .NET: yes, via unwind info; JSC: yes, conservative scan |
| Root locations | n/a | Slots at calls | Tagged slots | Slots, registers at polls | LLVM statepoints: slots only |
| Generic operation | n/a (typed at parse) | Profile-gated inlining | Feedback-gated fast paths; builtins out of line (Torque) | Same | C2 caps cold inlining at 35 bytecodes |
| Exceptions | none | Catch projection, unwind tables | IfSuccess/IfException, handler table | Unwind for JS, sentinel for VM calls | Swift: error register tested per call; JSC: pending field loaded per call |
| Allocator | Briggs-Chaitin-Click graph colouring with splitting | Same design | Linear scan | Linear scan | GCC IRA, B3 IRC: colouring |
| Rounds | ≤ 7, no reschedule | | | | |

---

## 10. Where the volume actually comes from (measured 2026-09-08)

After milestones 1–3, 5 and 6, the harness graph is still 15k nodes at the end of parsing, before
any inlining; the JSL library itself is 2.9k of that (lowered whole, every compile). So the per-site
cost is made by lowering, not by inlining decisions. One-line programs over the `var x = 1;`
baseline, nodes added at parse and total after opto (the realm baseline after opto is 612):

| Construct | Parse nodes added | After opto, over the realm |
|---|---|---|
| `typeof a` (a unknown) | 151 | 55 |
| `a === b` (unknown) | 158 | 70 |
| `a + b`, `a < b`, `if (a)` (unknown) | 158–163 | 54–55 |
| `o.x` read (unknown o) | 307 | 114 |
| `o.x = 2` (unknown o) | 244 | 77 |
| `f()` (a declared empty function) | 146 | 54 |
| `g(1)` (g an unknown function) | 285 | 229 |
| `new F(1)` | 427 | 298 |
| `try { throw 1 } catch (e) {}` | 159 | 54 |
| string literal | 0 | 0 |

What this says:

- **Every call costs about 50 nodes after optimization**, and the harness has 465 of them. The
  post-call pending-exception check, the boxing of arguments and result, and the call's
  projections are the bulk. Milestone 4 (the exceptional projection) is the direct answer to the
  first of those.
- **A function declaration cost about 100 nodes** at parse: the function object, its `prototype`
  object, and their property storage, each a New with stores; the realm setup another 600. Both are
  now data (§8, row 8): a declaration is 7 parse nodes and 0 after opto, the realm 56. A function
  *expression* at a Script's top level still allocates at its evaluation; it runs once too, but that
  is a fact about straight-line top-level code the layout does not yet use (docs/GAPS.md).
- **`new` and calls through unknown functions** are the most expensive constructs (300 and 230
  nodes): callable checks, the TypeError arm, receiver creation and prototype reads.
- **The evidence rule of §5 is right but rarely decisive here**: a parameter typed
  `dyn{undefined,double,string,function}` is sharper than `dyn` and inlining does fold a test or
  two. Making the rule stricter (a single tag, or a constant) would turn those sites into calls
  and shrink the graph further; that is a knob to revisit with the campaign's numbers.

