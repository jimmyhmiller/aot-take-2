# Scaling: whole-program analysis, per-function optimization

**Status: proposal with a plan.** Nothing here is built except where a section says "measured" or
"exists". When a milestone lands, its decision moves to `docs/DECISIONS.md` and this file records
what was learned. The two requirements are not traded against each other:

1. **Compile time is linear in the program.** Twice the source costs about twice the time.
2. **The generated code is as good as the global fixpoint's, or better.** Fast compiles that emit
   worse code are a failure of this plan, not a version of it.

---

## 1. What was measured (2026-09-20)

lodash 4.17.21 — one 17,209-line file — did not finish compiling: 15 minutes, one core pinned,
1.8 GB resident, no output. `clang -O3` compiles 17k lines of C in a couple of seconds.

The behaviour reproduces in seconds with N trivial functions and N calls to them:

| N functions + N calls | lines | compile | |
|---|---:|---:|---|
| 250 | 500 | 7.0 s | |
| 500 | 1,000 | 28 s | 4.0× for 2× source |
| 1,000 | 2,000 | 69 s | |

`AOT_TIME=1` now prints where a fixpoint's time went (rounds, specializations, inlines, peephole
visits, inline candidates asked, wall time of each part of a round). That breakdown, not leaf-frame
sampling, is what found every cause below; four guesses made from leaf frames were each measured,
found useless, and reverted.

**Everything outside the optimizer is already fine.** At N=250: parse 0.6 s, and selection + GCM +
scheduling + register allocation + encoding together under 0.6 s. The optimizer phase was 6.3 s of
7.0 s. The backend needs nothing from this plan except the parallelism it makes possible.

### The structure of the cost

`iter-run!` is Simple's `IterPeeps.iterate`: run peepholes to a fixpoint over the WHOLE graph, admit
ONE inline, repeat. So **rounds ∝ call sites**, and anything a round does that touches the whole
program makes the compile quadratic. Three such things were measured:

| per-round cost | measurement | state |
|---|---|---|
| Specialization walked the entire arena every round | 1,370 walks over 37k–93k ids at N=250; ~1,200 CallEnds re-asked per walk; every verdict UNHANDLED but at most one — 1.6 M proof checks for 259 specializations, 44% of the optimizer | **fixed** (a candidate worklist, Simple's own `_workInline` design): 7.0 → 2.5 s, 28 → 7.7 s, 69 → 30 s |
| Every fold into a GVN-shared constant re-queues all of that constant's users | 31,638 bulk pushes totalling **253 million** worklist entries at N=1000 | **fixed.** A Constant's old users cannot gain a user-sensitive peephole when the Constant gains another user; the replacement's new user is queued through the replaced node. Exhaustive fixpoint checks found no missed peephole. Inlining order changes because the removed storm no longer perturbs the worklist |
| Each inline *ask* grows with the program | 0.036 ms at N=250, 0.24 ms at N=1000 | **open.** The body-size cache is invalidated for every function after every inline |

A fourth appeared only on lodash: `n-del-use!` finds the use to remove by scanning the def's output
list from the front, and ~95% of samples were inside it scanning a list of Parms.

### Why: hubs

Simple's rules are O(1) in Simple's programs and O(program) in ours because a closed-world
JavaScript unit is full of **hubs** — nodes with thousands of edges:

- a GVN-shared constant (`undefined`, `0`, `true`): ~8,000 users at N=1,000;
- `Stop`: every Return in the program is an input;
- a shared runtime function (the JSL definition of `+`): a Fun whose inputs are **all of its call
  sites**, and each of its Parms likewise — "a Parm is a Phi over its callers" makes every popular
  function a hub by construction.

Simple pushes `x._outputs` and `x._inputs` after a peephole and finds a use by linear scan. None of
that is wrong. It is written for units of a few dozen lines.

### How Simple itself handles scale, and what production compilers do

Simple optimizes a whole **CompUnit** in one graph — one Start, one Stop, one global worklist — and
its answer to scale is *separate compilation*: `Serialize` writes the ideal graph into the object
file so another unit can link and inline across the boundary. It never claims the single graph
scales; its units are small.

Every production sea-of-nodes compiler is per-function: HotSpot C2 (the original) compiles one method
plus its inlinees and bails out past roughly 80k nodes — our N=1,000 toy graph was 264k–356k.
Graal/Truffle JS compiles one call target with a budgeted inliner. **Graal native-image is the one
that matches this project**, because it is AOT and closed-world: a whole-program points-to
*analysis* runs first over a cheap dedicated graph, and then every method is compiled
independently, in parallel, consuming the analysis's results as facts.

### Smaller units, measured

`memory-run --retained` already compiles each input file as its own unit against the JSL runtime as
a separate provider unit. The same 1,000 functions:

| | optimizer time |
|---|---:|
| one unit of 1,000 | ~30 s |
| each unit of 100 | ~0.62 s, steady across all ten |
| ten units, sequentially | ~7 s — and independent, so ~1 s wall on twelve cores |
| the JSL provider unit | 16 s, ONCE — identical for every program, so cacheable |

And the cost was visible at once: the single unit performed **1,009 specializations; the split
units performed 0.** Across the provider boundary `+` and `===` become calls to the generic
out-of-line definition. Files are also the wrong granularity for lodash, which is one file. Units
help and are not enough; precision has to cross the boundary some other way (§3).

---

## 2. The architecture

**Global analysis decides what to build and who may call it. Local optimization builds it.**

```
parse ─ link ─ GLOBAL ANALYSIS ─ select contracts, route sites ─ FREEZE ─ unlink
                                                                            │
      ┌─────────────────────────────────────────────────────────────────────┘
      ▼  for each (function, contract), callees before callers, under a node budget:
   peepholes + inlining to a LOCAL fixpoint ─ select ─ GCM ─ schedule ─ allocate ─ encode
```

### What stays global, and why that is affordable

Optimistic SCCP over the linked graph, the call graph it discovers, and the closed-world image
facts (this property is never written; this prototype never changes; these are the functions a
code word can hold). These are *analyses*: they read the graph and publish facts. At N=1,000 the
optimizer phase was 25 s and `iter-run!` was 24 s of it — **SCCP is not the problem; the
peephole-and-inline fixpoint is.** Keeping the analysis global costs almost nothing and is what
keeps the closed world's power: interprocedural type inference still falls out of "a Parm is a Phi
over its callers", because that is where SCCP reads it from.

### The interface: an entry contract

Today a function cannot be optimized alone, because its Parm types are the meet over every call
site and can change whenever any caller changes. That single fact forces the global fixpoint, and
it is also what makes Fun and Parm hubs.

A **contract** fixes a function's parameter and memory types at entry. It is a signature. Once a
function has one, nothing a caller does can invalidate its body: callers stop being *inputs* and
become *obligations* — prove you satisfy this contract, or call the generic entry. That last clause
is already the project's thesis: a failed guard is ordinary control flow into a generic version
compiled into the same binary.

`docs/FUNCTION-VERSIONS.md` already defines contracts precisely and `src/node/versions.coil`
implements them: keys normalized to runtime categories, every redirected call must PROVE containment,
unknown or incompatible sites keep the generic target, no speculative guards, and "private entries
hold fixed parameter contracts while routing is open" (`version-open` in `parm-in-progress?`) — the
mechanism that makes a Fun's types independent of its callers exists today. What changes is its
ROLE: versions are now a bounded add-on admitted late, after the inliner drains; here they become
the primary interface, selected from the analysis BEFORE any peephole runs. Expect rework of the
admission policy, not reuse as-is.

### What becomes local

Peepholes, inlining, specialization and the whole backend run on one (function, contract) at a
time, **callees before callers** over the call graph's strongly connected components:

- By the time `g` considers inlining `f`, `f` is already optimized and its size is final. Simple's
  policy is "no real heuristic, first come, first served"; bottom-up order with finished callees is
  what production inliners use because it produces *better* code, not only faster compiles.
- A function's return type is known once its body is optimized under its contract, and callers
  read it as a summary. Inside a recursive component a small local fixpoint (assume TOP, iterate)
  is bounded by the component, not the program.
- Cost is proportional to the body plus what it inlines, under a node budget, as in C2.
- The hubs stop existing rather than being special-cased: an unlinked Fun has no caller inputs; a
  per-function graph has per-function constants; Stop has one function's Returns.

---

## 3. "Optimal code": every source of precision, and where it goes

The global fixpoint buys precision from six places. The plan must account for each; this table is
the contract this proposal makes about code quality.

| Today's source of precision | Where it comes from in the new design |
|---|---|
| Parameter types: the meet over a function's callers | Global SCCP, unchanged. Its per-site argument types select the contracts. A function called with `(int,int)` and `(string,string)` gets TWO precise bodies instead of one body typed `dyn` — strictly better than the meet |
| Return types flowing back to callers | Bottom-up summaries; a local fixpoint inside a recursive component |
| Closed-world folds: never-written properties, fixed prototypes, known call targets | The same image facts, published by the analysis before optimization starts |
| TypeScript annotations discharged by proof | The same SCCP types; an undischarged annotation keeps its guard, as now |
| JSL operator specialization (`+` on two ints becomes an integer add) | Contracts cross unit boundaries: the provider exports `JsAdd[int,int]` as an entry and the site routes to it. This is what recovers the measured 1,009 → 0 |
| Feedback: a fold inside `f` sharpens a parameter of an unrelated `g` in the same run | **The one real loss.** Recovered only by a second analysis round after local optimization. Milestone 6 measures the gap before deciding whether the round is worth its cost |

One more row the measurements forced: **dependencies nobody wrote down.** Skipping the constant
re-queue changed the optimizer's outcome, so some peephole's correctness of *scheduling* currently
leans on being re-visited by accident. Early unlinking will surface every such case as a lost
optimization. That is a reason to run the experiment behind a flag, and each one found gets a real
`n-add-dep!` — which improves the current architecture too.

---

## 4. The plan

Each milestone lands on its own, green, and is useful even if the ones after it never happen. The
order is leverage over risk. "Gate" is what must be true to call it done; the numbers are measured
on the pinned scaling benchmark and the quality baseline of M0, never estimated.

### M0 — Instruments and baselines

*Build the ruler before building anything it measures.*

- **Scaling benchmark as a deterministic test.** Generate the N-functions program at N = 250, 500,
  1,000 inside a test; assert on COUNTS, never wall time (`CLAUDE.md`: a wall-clock assertion
  measures the machine's load): peephole visits per node, inline candidates asked per inline,
  bulk-push entries per node. The assertion is a ratio between sizes — visits at 2N ≤ 2.2 × visits
  at N — which is the linearity requirement written as a gate.
- **Quality baseline**, recorded once from today's global pipeline and compared on every milestone:
  generated-code time for `benchmarks/v8/` plus fib and binary trees (warmed, per `CLAUDE.md`);
  STATIC counts from the same compiles — specializations, inlines, guards discharged, final machine
  nodes; and the 3,000-file test262 sample as the correctness backstop.
- **Real programs**: lodash, acorn, and the test262 harness, timed by phase.

Gate: the scaling test exists and FAILS on main for the right reason; the baseline table is checked in.

### M1 — The measured quadratics, in the current architecture

Worth doing under either design, and each is days, not weeks.

- **Body-size invalidation.** `fun-size-epoch-bump!` invalidates every function's cached size after
  every inline. An inline changes the caller's body and, if it folded, the callee's. The cache's own
  safety argument — a stale size is only stale upward, which delays an inline and never admits one
  wrongly — covers invalidating exactly those two.
- **`n-del-use!` on a hub.** O(1) removal needs the use to know its position in the def's output
  list. Measure first whether scanning from the END (recently added uses die first) is enough.
- **The constant storm.** Do not skip the re-queue: FIND what it is standing in for. Instrument
  which re-visited users actually change, register those as real dependencies, and only then remove
  the storm — verified by an unchanged outcome, not by an argument.

Gate: the M0 scaling ratios improve with **byte-identical objects** for the quality baseline, or a
difference that is explained and measured equal-or-better.

### M2 — Cache the provider (Simple's own answer)

The JSL runtime is one unit, identical for every program: compile it once, key it by the content
hash of `jsl/` and the compiler, keep the object and its serialized graph on disk. The source cache
in `aot.codegen.sourcecache` already does this in memory for the test262 runner.

Gate: a second compile of any program spends no time on JSL; the 16 s provider cost is paid once
per change to `jsl/`.

### M3 — Every node knows its function

Scoping work to a function needs an owner for every node, and in a sea of nodes only CONTROL nodes
have one (`cfg-owner-fun`); an Add floats. Two ways, to be decided by a spike, not by argument:

- *an owner derived on demand* — from a data node's control-dependent inputs — cached under the
  control-edit version the way `owner-nid` already is; or
- *per-function arenas* — what C2 does: each function's nodes, GVN table and constants are its own,
  so ownership is structural and the constant hub cannot form.

Gate: `verify-all` checks that no edge crosses functions except through a Call, a FunPtr or a
declared boundary node. (That check is worth having today: it is the unlinked-graph invariant the
backend already assumes.)

### M4 — The flagged prototype: `AOT_PER_FUNCTION=1`

Both pipelines in one binary, selected like `AOT_NO_SPECIALIZE`, so every comparison is the same
compiler on the same input.

`link → global SCCP under facts → record each Parm's proven type as its contract → FREEZE → unlink
early → for each component bottom-up: local peepholes + inlining under a node budget → backend`.

This milestone uses ONE contract per function (its SCCP meet — exactly today's precision, no
versions yet). Its purpose is to isolate one question: **what does early unlinking alone cost and
buy?** Every lost optimization is a dependency from §3's last row; each gets fixed or recorded.

Gate: the M0 scaling test passes under the flag; test262 sample unchanged; the quality table is
filled in for the flag, with every regression explained by name.

### M5 — Contracts as the primary mechanism

Contract selection moves in front of optimization: from SCCP's per-site argument types, choose the
contracts each function gets (the policy and budgets of `FUNCTION-VERSIONS.md`, re-tuned — the
default of two private entries was chosen for a late add-on), route every site that proves
containment, leave the rest on the generic entry. Exported contracts cross unit boundaries, so a
provider's `JsAdd[int,int]` is reachable from a client.

Gate: static specialization counts under the flag ≥ the global baseline (recovering 1,009 → 0 in
the split configuration), and no benchmark slower than baseline beyond noise.

### M6 — Summaries, recursion, and the feedback gap

Return-type summaries; the local fixpoint inside a recursive component; then MEASURE the one real
loss of §3 — how many parameter types would sharpen if a second analysis round ran after local
optimization — on the V8 suite and lodash. Build the second round only if the number says so.

Gate: the gap is a number in this file, and the decision it led to is in `DECISIONS.md`.

### M7 — Isolation pays out: parallelism and per-function caching

With per-function graphs the backend runs across cores, and an unchanged (function, contract,
callee-summaries) triple need not be recompiled.

Gate: lodash compiles in seconds on twelve cores; an edit to one function recompiles that function
and its dependents only.

### M8 — Flip the default and delete the global fixpoint

When the flag's quality table is equal-or-better everywhere and the scaling gate holds, the flag
becomes the pipeline. `DECISIONS.md` records the divergence from Simple (next section), `DESIGN.md`
and `LAYOUT.md` are rewritten for the new phase order, and the global `iter-run!` path is removed —
two pipelines are kept only for as long as the comparison needs them.

---

## 5. The divergence from Simple, stated once

`CLAUDE.md` makes fidelity to Simple the default and a divergence a recorded decision. This is one:

- **Kept:** the node, the lattice, GVN, peepholes, `compute`/`idealize`, ScopeNode SSA, memory SSA,
  "a Fun is a Region, a Parm is a Phi" *as the representation the analysis reads*, optimistic SCCP
  discovering the call graph, and the entire backend.
- **Changed:** the pessimistic fixpoint stops being global. Simple iterates one worklist over the
  unit and inlines first-come-first-served; this design optimizes one function at a time, callees
  first, against a frozen contract. Simple's own scale mechanism — separate units with serialized
  IR — is kept and leaned on (M2), but it cannot be the whole answer when one file is 17k lines.
- **Why it is forced:** JavaScript makes the unit large (a program drags in a runtime library that
  C-like Simple does not have) and makes it hub-shaped (every operator is a call to a shared
  definition). Those are properties of the language, not mistakes in the port.

---

## 6. Risks

- **The first quality numbers will look worse than the last.** Early unlinking exposes every
  accidental dependency at once. That is the experiment working; the flag is what makes it safe.
- **Version explosion.** Contracts multiply bodies. The budgets exist (`AOT_FUNCTION_VERSIONS`, the
  growth-percent cap) but were tuned for a different role; M5 re-tunes them against code size as
  well as speed.
- **Ownership (M3) is the milestone most likely to be larger than it looks.** Per-function arenas
  touch the `CODE` singleton, nids and the GVN table. That is why it is a spike with a decision at
  the end rather than a task with an estimate.
- **The analysis could become the next bottleneck.** It is 4% of the optimizer today; at 100× the
  program it may not be. If so, the answer is native-image's: run it over summaries, not over the
  optimizer's graph. Not needed until a measurement says so.

---

## 7. Progress log

What has landed against the plan, with the counts that justified it. Every row was found by a
COUNTER, not a guess — three guesses made on the way (bounding the size walk, the clone's
arena-sized bitmaps, skipping constants) were each refuted or reshaped by the count that followed.

### 2026-09-20 — M0, and three of M1's quadratics

The stress program is the worst shape found so far: N two-argument functions and
`t = t + f_i(t, i)` for each — every call inlines, with its JSL operators, into ONE function whose
dominator chain grows with N. `aot compile-script`, whole compile, wall clock on one machine
(a description of the trend, not a gate — the gate is the counts):

| N   | main `265c1ea` | + hub hints | + owner cache, caller-only size | + `AOT_NO_CONSTANT_REQUEUE` |
|-----|---------------:|------------:|--------------------------------:|----------------------------:|
| 250 |  not measured  |      5.3 s  |                           4.6 s |                       5.9 s |
| 500 |        68.9 s  |     58.3 s  |                          46–49 s |                        31 s |

Same rounds (4,087), same visits (14,065,762), same arena and **byte-identical objects** between
the last two columns at both sizes.

**M0.** `tests/scaling-test.coil` compiles two shapes at N and 2N and ratchets the RATIO of
deterministic counts: peephole visits, worklist pushes, inline asks, rounds, use-scan steps, dep
asks, depths computed. `AOT_TIME=1` prints the same counts per fixpoint, split by which half of a
round paid. It also prints one final static row: specializations, inlines, discharged Cast guards,
machine nodes, blocks and allocation rounds. A discharge is counted only when the real peephole
replaces a Cast with its already-proven input; the expensive fixpoint assertion does not count its
speculative probe.

The first current-baseline rows (Apple M2 Max, 2026-09-21, three process runs after each workload's
in-process warm-up) are:

| workload | aot-take-2 | Node 26.5.0 | specializations | inlines | guards discharged | machine nodes | blocks |
|---|---:|---:|---:|---:|---:|---:|---:|
| `fib-steady.js` | 7.39–7.47 ms | 5.81–5.91 ms | 13 | 157 | 292 | 4,964 | 1,057 |
| `binarytrees-steady.js` | 454–504 ms | 44.1–50.9 ms | 14 | 247 | 570 | 7,159 | 1,538 |

The current compiler does not produce runnable code for any V8 suite program, so their M0 baseline
is an exact failure outcome rather than a generated-code time. The older node-count/failure table
in `benchmarks/README.md` covers all eight programs. Fresh 2026-09-21 measurements establish the
current boundaries rather than carrying those outcomes forward as assumptions:

| workload | measured current outcome |
|---|---|
| Richards | phase 1 10.203 s; Opto 172.095 s and 1,534 inlines; allocator split-budget panic on harness Phi #140474 |
| EarleyBoyer | frontend refusal: mapped arguments object whose observable formal aliasing includes a write |
| RegExp | phase 1 19.761 s; phase 2 1.579 s and 63 specializations; still in Opto after 10 min (8:44 CPU, 2.10 GB resident), stopped at the M0 cutoff |
| DeltaBlue, Crypto, RayTrace, Splay | prior checked-in baseline: allocator split-budget panic in their common harness; no generated-code timing |
| NavierStokes | prior checked-in baseline: allocator split-budget panic; no generated-code timing |

The real-program rows pin both the input and the cutoff. A successful compile reports every phase;
a refusal is a zero-ambiguity frontend outcome, and a cutoff records the last completed phase plus
CPU and resident memory:

| input | identity | measured current outcome |
|---|---|---|
| lodash | 4.17.21; SHA-256 `4c04561befdf653aef017a42ac5addf68ea943cdfca6bdee5ce04e04e8139f54` | phase 1 97.284 s; phase 2 4.426 s (7 rounds, 7 specializations, 0 inlines, 698,130 visits); still in Opto after 10:23 (10:22 CPU, 3.66 GB resident), stopped |
| acorn | 8.14.0; SHA-256 `bec194b9abb10147d3bb77e544d95cf1c7b4f9f42dad00dfc83791909ebf49c7` | frontend refusal: strict and non-simple arguments objects require the `%ThrowTypeError%` callee accessor |
| Test262 harness | pinned `assert.js` + `sta.js` from revision below | phase 1 4.014 s; phase 2 0.113 s; phase 3 73.370 s; remaining phases 2.636 s; 0 specializations, 1,077 inlines, 1,081 guards discharged, 60,178 machine nodes, 12,830 blocks, 5 allocation rounds |

The pinned 3,000-file Test262 backstop is recorded in `docs/TEST262.md`: 932 passing files from
5,754 variants in 234.450 s, with exact verdict counts and all eight abnormal terminations named.

**`n-del-use!` on a hub (M1).** Scanning from the end was NOT enough: the misses were duplicate
edges (a Parm whose N callers all pass the same `undefined` uses it N times) and the KEEP edge
(held across surgery on a hub while uses pile up behind it). Each (def, use) pair of a def with 32+
outputs now keeps a validated stack of positions; the keep edge has one too. Use-scan steps at
N=120: 4,233,274 → 411,089, and it now tracks visits (1.2 steps a visit) rather than hub size.

**Body-size invalidation (M1).** Done as planned — the inline invalidates its CALLER only — plus
one thing the plan did not say: the epoch is bumped for everyone before the defer list is retried,
so "stale upward delays an inline" can never become "loses one". Measured gain was small (inline
20.2 → 16.7 s at N=500): the walk was not where the inline half's time went.

**Where it went: owners (new).** `fun-self-recursive?` asks the owner of EVERY caller of the
callee, a shared runtime function has a caller per call site, and the owner cache died at any
control edit — so every round re-walked the caller's whole dominator chain, recomputing depths on
the way. A cached owner now lasts until its Fun dies. Owner-walk steps in inline 47,937,553 →
144,261; depths computed in inline 29.7M → 1.5M; inline 16.1 → 5.4 s.

### 2026-09-22 — M2 provider artifact and cross-process cache

The provider now crosses both durable boundaries named by M2. `CodeImage` has a versioned,
fully validated arena-independent codec. The ideal graph codec writes the complete structural type
table and a deterministic closure from Stop through ordered inputs and semantic back-references;
loading allocates every node shell first, then reconnects exact ordered edges. The real JSL provider
graph re-encodes byte-for-byte after compiler-region destruction: **4,884,523 bytes identical**.

The disk container is keyed by a dual content hash over the exact compiler executable, worklist
seed and exact ordered JSL snapshot. It repeats the key, checksums the graph and native-image
payloads, validates both formats, writes a pid-qualified temporary file and publishes by atomic
rename. A per-key advisory file lock serializes publishers; after acquiring it a contender checks
the cache again, so it never recompiles a provider another process just published.

M2 gate, using one prebuilt `tools/memory-run.coil` executable and a fresh cache directory:

- sequential processes reported `miss`, then `hit`;
- two processes started simultaneously both completed successfully, produced one artifact, and
  only one entered the 52,918-node provider compile; the waiter reported `miss` then `hit` after
  the lock and proceeded directly to its 44-node host;
- a different seed and a one-byte-different ordered JSL snapshot are misses.

Thus the second retained-program compilation spends zero time compiling JSL; the provider cost is
paid once for each exact compiler/JSL/seed identity. The final disk-layer gate passed **965/965**
after a clean release build.

### 2026-09-22 — M3 ownership spike

The spike chose **derived ownership**, following final Simple's `GlobalCodeMotion.useFun` and
`RegAlloc.funOf`, rather than changing allocation and GVN identity to per-function arenas before
the flagged pipeline exists. Return, Parm and Fun name their owner directly; control nodes use the
nearest dominating Fun; pinned data uses that control; unpinned chains receive ownership backward
from their users. Conflicting consumers identify an intentional shared/global boundary.

The implementation is a batch worklist rather than a recursive query. Direct owners seed it and
ownership propagates backward over ordinary value edges. Ownership inherited from control or a
definition may also move forward into an unfinished sink; ownership inferred from a user may not,
so a shared Constant never broadcasts one consumer's Fun into its other consumers. A node changes
only from unknown to one Fun and at most once more to shared, so the pass is linear and an
8,192-node value-chain regression requires no native recursion. Propagation stops at the declared
interprocedural edges: Fun caller arms, Parm arguments, FunPtr identity, Stop roots and CallEnd's
linked callee Returns. CallEnd itself follows its caller-side Call because its dominator may cross
into a linked Return; value Projections inherit their multi-result producer.

`verify-all` now reports the named `function-edge` error when two nonzero owners differ across any
ordinary edge. A focused corruption routes a first function's Parm through a shared Add into a
second function and proves that shared-node classification cannot conceal the illegal input edge.
The complete JSL provider graph passes the invariant. The final release gate passed **967/967**.

### What the counters say is left (N=500, after the above)

| cost                          | count        | where                          |
|-------------------------------|-------------:|--------------------------------|
| peephole visits               |   14,065,762 | 3,440 a round; 96% change nothing |
| dep registrations asked       |   84,646,827 | peeps; 6 per visit             |
| dominator depths computed     |   55,819,393 | peeps; 13,600 a round          |
| self-recursion owner lookups  | ~40,000,000  | inline; asks × callers, cached |

1. **Depths.** Every inline invalidates every cached depth (Simple's rule: "blows all cached
   idepth fields past the inline point"), so each round re-depths the whole function being inlined
   into. Scoping the version to the Fun helps programs whose inlines are spread over many
   functions and does nothing for one big function; that case needs depths that survive an
   insertion (an order-maintenance labelling), or the per-function architecture of §2, where the
   function being optimized is small by construction.
   A third option, cheaper than either and NOT yet designed against the code: the only consumer
   of depths inside the fixpoint is the Region LCA (`idom-lca-nodes`, `region-lca-path`,
   `region-lca-covered`), which uses them to decide which side to step. An LCA needs no depths —
   step both sides alternately and stop at the first node one walk reaches that the other has
   visited — so the fixpoint could ask for no depth at all and an inline would have nothing to
   invalidate. The cost is a visited set on long walks, and the three variants carry dead-root
   rules (`region-idom`'s header) that a rewrite must reproduce exactly; GCM keeps its depths. This
   is a design to agree before coding, not a patch.
2. **The constant storm, re-measured.** A node that folds to the shared `undefined` re-queues all
   ~1,500 of that constant's users, 2,255 times at N=120 (`x._outputs` in Simple's `iteratePeeps`).
   With that one push skipped for constants: N=500 runs 4,087 → 2,969 rounds, 14.1M → 4.0M visits,
   46 → 31 s, and the object is 12% SMALLER; N=250 is 2.7% larger. `iter-check-fixpoint` after
   every round finds no violation the baseline does not also have — so no peephole was standing
   behind the storm. What it stands in for is re-ASKING every call site each round, i.e. inline
   order, and inlining is not confluent. That is a policy question, not a missing dependency, so
   it first landed as the measurement switch `AOT_NO_CONSTANT_REQUEUE`. The 2026-09-21 decision
   makes the Constant exception the sole rule: ask order is not allowed to remain an accident of
   an unrelated hub's fanout.

   The evidence for making it the default, gathered the same night. The whole suite run with the
   switch SET: 959 of 960 pass — every execution test, the budget and bloat ceilings, and the four
   suites that assert `iter-check-fixpoint` — and the one failure is this document's own ratchet
   (the hub shape's dep-ask RATIO, x280 against a x240 ceiling, because N=60 fell further than
   N=120 did; both absolute counts are lower). `fib` and binary trees built each way run in the
   same time (1,340 vs 1,340 ms; 441–472 vs 444–455 ms) from objects of the same size. And the wide
   scaling program becomes LINEAR in the counts M0 gates on:

   | N=60 → 120 (wide) | unset            | set              |
   |-------------------|-----------------:|-----------------:|
   | visits            | x3.31            | **x1.99**        |
   | worklist pushes   | x3.16            | x2.29            |
   | rounds            | x3.08            | **x1.62**        |
   | depths computed   | 1,810,323        | 732,786          |
   | dep asks          | 2,738,972        | 1,785,588        |
3. **Dep asks.** Six per visit, nearly all refused as duplicates after a hash probe and two input
   scans. Constant factor, but 85M of them.
   Counted per visited kind: nearly all of them come from `Parm` visits — a Parm's `compute` is a
   meet over every caller and registers a dependency on each, so one visit of a 500-caller Parm is
   500 asks — and ALL of the depths in item 1 come from `If` visits, whose dominating-test hunt
   walks the dominator chain to its predicate's definition or to the root. Both are Simple's rules
   doing what they say; it is the hub (N callers) and the depth (N inlined calls in one function)
   that are ours. The storm in item 2 is what re-visits those Parms: with the switch set, dep asks
   fall 84.6M → 27.9M.
   Sampled on lodash, the pair-set probe inside `n-add-dep!` is ~30% of the optimizer, with the
   type meets of `Parm` compute (function-set interning) next. Tried and REJECTED on measurement:
   answering "already registered?" by scanning the watched node's own list when it is short (exact —
   objects byte-identical) made the peephole half 35% SLOWER, because each comparison in the scan
   is a dynamic dispatch and the probe is one hash. The cost is the number of asks, not the ask.
4. **`fun-self-recursive?`** is O(callers) per ask even with every owner cached. It was memoized
   once and un-memoized for a correctness reason recorded at the function; a sound key needs the
   Fun's caller edits AND its FunPtrs' uses AND inlines into it.

### lodash, the same night

Still does not finish: 25 minutes and killed, inside the optimizer fixpoint, with the landed fixes;
the run with `AOT_NO_CONSTANT_REQUEUE` set was likewise still in the fixpoint when the night ended.
Two things it showed that the synthetic programs do not:

- **Phase 1 alone is 104–106 s**, before any optimizer round, and a sample puts ~97% of it in the
  image-facts surface scan: `scan--has?` under `scan--copy-into!` (`aot.node.imagefacts.scan`). A
  value that may be any of the program's functions has an entry set as large as the program, every
  node it flows through holds its own copy as a list, and a copy is the product of two set sizes.
  The obvious patch — a (nid, entry) pair set for membership — was built and measured and is
  WORSE (phase 1 not finished at 170 s): the pairs number in the hundreds of millions, so a hash
  probe per pair loses to a sequential scan of a list. The fix is representational — shared or
  bit sets, or one "any function" summary element — and is a design, not a patch. It belongs with
  M6 (summaries): this scan is exactly the global analysis this document wants to keep cheap.
- The first optimizer fixpoint on lodash is 7 rounds and 8 s. The time is in the ones after it.

### 2026-09-22 — M4 flagged per-function prototype

`AOT_PER_FUNCTION=1` now follows the M4 boundary: one global SCCP records each live entry's erased
Parm contract and the retained caller graph, Tarjan orders recursive components bottom-up, all
discovery edges are removed, and each component alone receives a worklist and temporary entry
roots. Calls to finished components are restored only while the caller is optimized. Calls inside
an SCC are also restored for its local fixpoint, but are marked never-inline so mutual recursion
cannot unroll the component. Frozen CallEnd and Return summaries survive the next unlink. The final
whole-unit backend is deliberately still shared by the prototype; M7 replaces that handoff with
parallel per-function backend work and cached artifacts.

Published source identities root their stable shared-ABI adapters during global SCCP; private local
bodies remain reachable through concrete adapter calls. Treating those bodies as externally
callable widened the hidden arguments-vector contract to `dyn` and was caught by two Test262
`JsRestFrom` representation proofs. Planned Fun nodes have an explicit compilation-unit lifetime
pin because Return ownership is metadata, not a graph edge. This matters after local optimization
eliminates the last Parm or FunPtr use.

The deterministic scaling gate passes under the flag:

| N=60 → 120 | wide | hub |
|---|---:|---:|
| visits | x1.67 | x1.39 |
| worklist pushes | x2.19 | x1.97 |
| inline asks | x1.74 | x1.41 |
| rounds | x1.72 | x1.00 |
| use-scan steps | x2.09 | x1.67 |
| dependency asks | x2.90 | x2.98 |
| dominator depths | x1.81 | x1.53 |

The pinned 3,000-file Test262 campaign preserved all **1,803 passing variants and 932 passing
files**. Compiler errors (132), crashes (7) and unsupported variants (2,009) are identical to M0.
The sole verdict-table difference is
`built-ins/RegExp/property-escapes/generated/Diacritic.js` mode 1: M0 timed out, while the flagged
run completed as the same ordinary failure class as mode 2. There were no flagged timeouts.

M4 quality table (Apple M2 Max, 2026-09-22, three process runs after the workload's unchanged
in-process warm-up):

| workload | M0 time | M4 time | specializations | inlines | guards discharged | machine nodes | blocks |
|---|---:|---:|---:|---:|---:|---:|---:|
| `fib-steady.js` | 7.39–7.47 ms | 30.61–30.75 ms | 0 | 30 | 6 | 7,539 | 1,665 |
| `binarytrees-steady.js` | 454–504 ms | 489.15–492.55 ms | 2 | 30 | 8 | 8,323 | 1,809 |

Every regression has the same named source: **JSL operator contracts are not yet primary**. Early
unlinking removes the global caller feedback that admitted 13/14 JSL specializations and then let
their small integer/property bodies inline (157/247 total in M0). The generic shared entries remain
calls, so their guards remain instead of being discharged and the backend receives more nodes and
blocks. Fib is dominated by those generic arithmetic and comparison calls and slows accordingly;
binary trees spends most of its time allocating and collecting, so its generated-code time remains
inside the M0 range despite the static loss. M5 exists specifically to select precise contracts
before local optimization and must recover at least the baseline specialization counts and runtime.

### 2026-09-22 — M5/M6 contract and recursive-summary boundary

Primary selection now runs once over the globally analysed call sites before any local body is
optimized. It creates bounded contract entries, routes only sites whose argument and memory types
prove containment, closes admission, and permits a later local site to retarget only to an exact
entry already admitted. The latter recovers the integer Fibonacci entry's recursive calls without
reopening global admission. The scaling test remains green (wide visits x1.99, hub visits x1.44 in
the current N=60 → 120 run).

The plan must read a primary entry's interface from the version registry. A primary body is copied
AFTER global SCCP, so its copied Parm node initially retains the source body's merged type. Rebuilding
the plan from that node silently replaced an admitted `int` contract with
`dyn{bool,int,double,string}`. The registry is now authoritative for every live contract slot, and a
regression checks that the plan preserves it. Each recursive component starts its own optimistic
solve from TOP under those contracts. If exact closed-admission routing changes a recursive edge,
the component repeats that solve, matching the whole-program optimizer's existing rule.

This establishes the precise remaining M6 gap. In the narrow Fibonacci entry the parameter is now
`dyn{int}`, and both recursive calls route back to that entry, but its return remains
`dyn{bool,int,double,string,exception}`. The surviving `JsAddOperator` call consumes the two recursive
results; its context-insensitive shared return is broad, which keeps those results broad and prevents
the integer specialization that would in turn prove the return integer. Another worklist visit or
another identical SCCP solve cannot break that semantic cycle. M6 therefore needs a return summary
indexed by the callee contract (or an equivalent context-sensitive transfer), not a handwritten
Fibonacci rule and not mutation justified by an unproved optimistic guess.

Current generated-program timing after in-process warm-up is 9.8–10.2 ms per `fib(30)` iteration;
this is NOT compiler wall time. It improves the first M5 prototype's 27–31 ms but remains slower
than the M0 generated-runtime baseline of 7.39–7.47 ms. Binary trees remains about 475 ms, inside
its M0 range. M5 is not complete until the static counts and generated runtime meet its gate.

### 2026-09-22 — disconnected-function proof of concept

`AOT_DISCONNECTED_FUNCTIONS=1` measures the smallest correct boundary found by the spike. It runs
one interprocedural SCCP pass for reachability and interface discovery, snapshots those types and
contracts, removes the discovery edges, and drains the ordinary peephole worklist one recursive
component at a time. It does not publish closed-world image facts and it deliberately does not run
local inlining or source specialization yet.

The exclusions are findings, not intended policy. Compiling every materialized JSL helper under a
broad declared `dyn` contract is invalid: helpers such as `JsDateParseValue` contain representation
unboxes that are legal only in a selected specialization. Re-solving a component independently
also needs exception-aware return summaries indexed by entry contract; without them,
`baseIndexOfWith` loses the proven exclusion of the exception sentinel at its loop index Phi. The
single analysis snapshot preserves both proofs for this experiment.

The separate inline worklist is not component-scoped. Calling `iter-run!` once per component on
Lodash repeatedly scanned a compilation-wide queue of 77,656 candidates and made phase 3 take
6,161 seconds. Draining only the scoped ordinary worklist reduced phase 3 to 26.8–27.6 seconds.
This names the immediate implementation task: partition or index the inline and specialization
queues by owning component, then restore local transformations.

Pinned Lodash 4.17.21 (`4c04561befdf653aef017a42ac5addf68ea943cdfca6bdee5ce04e04e8139f54`)
reached register allocation in about 150 seconds:

| phase | time |
|---|---:|
| realm/image surface analysis | 116.4–117.2 s |
| pessimistic Iter | 4.8–4.9 s |
| analysis snapshot plus component-local peepholes | 26.8–27.6 s |
| typecheck through scheduling | 1.8 s |

It then exposed a pre-existing backend limit in the enormous top-level Lodash function: register
allocation still had an uncolourable numeric Phi after both 8 and 16 split rounds. Therefore the
POC does not yet produce a Lodash object. Increasing the guard is not a fix and was reverted.

On `fib-steady.js`, phase 3 is 73 ms and whole compilation is about 0.55 seconds. With local
inlining intentionally disabled it produces 0 specializations, 0 inlines, 60 discharged guards,
10,197 machine nodes and 2,255 blocks; the warmed generated loop takes 27.74 ms rather than the
global pipeline's roughly 5.3 ms. The spike demonstrates the compile-time boundary and identifies
the two missing interfaces, but it is not a replacement default or a code-quality result.
