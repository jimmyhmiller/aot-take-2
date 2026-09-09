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
| Register allocation | 526 ms | 59 ms | |
| Stack maps and encoding | 205 ms | 31 ms | |
| Global code motion | 179 ms | 16 ms | |
| Optimizer (iter + opto) | 400 ms | 185 ms | |
| User time | 1.30 s | 0.31 s | < 0.1 s |

The volume rows are unchanged because they are the front end's (§4, §5); the time rows are what
the backend corrections bought.

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
| 4 | Exceptional CallEnd projection (§4) | Every pending-check lowering path deleted; `assert.throws`, `finally` and nested-catch tests green | −265 blocks, −1,300 nodes |
| 5 | Evidence-gated JSL inlining (§5) | Bottom-typed sites are calls; typed fixtures unchanged in node count; bloat ceilings hold | blocks 3,246 → under 500 |
| 6 | Word-level GC liveness, once (§6) | Stack-map tests green; encoding phase under 20 ms on the harness | **Landed.** 205 → 31 ms (the remainder is layout and emission) |
| 7 | Gates (§7) | The listed assertions exist and are red when any of 1–6 is reverted | |

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
