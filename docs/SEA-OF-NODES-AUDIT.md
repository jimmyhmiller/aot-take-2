# Are we doing proper sea of nodes?

**Callable versions, 2026-09-19:** [FUNCTION-VERSIONS.md](FUNCTION-VERSIONS.md) records the
research and implementation of bounded reusable entries for JavaScript and local JSL functions.
Versions use ordinary Fun/Parm/Return typing, proven argument and memory contracts, generic
fallback, and per-function limits independently of inlining. The saved allocation-proof experiment
now recovers Fibonacci's numeric return when versioning isolates its unrelated string caller;
the separate binary-trees runtime gap remains. Validation and measurements are in that document.

**Implementation amendment, 2026-09-18:** the subsequent repair is specified in
`DESIGN.md`. It replaces opcode-based own-property proofs with identity and
memory-position queries, admits one specialization per round, budgets source
expansion, and compares actual fact snapshots. The image-shape promotion proposal
below is not implemented: precreating a property can change inherited reads and
setters even without explicit presence tests. The original measurements below
describe the audited revision, not the repaired revision.

The historical claim that round-boundary placement alone explains or repairs all
five seam bugs is also superseded. Type monotonicity, safe call linking, ownership
of replacement edges, and CFG invalidation remain separate obligations. A residual
smaller than its shared callee can still grow the caller and the compilation.

An audit that started from an instinct — "this seems to make an end run around the sea-of-nodes
setup rather than leaning into it" — and ended somewhere other than where it aimed. This document
is the whole chain: what was actually wrong, what was fixed, what was diagnosed and left, what the
measurements say the next work is, and which confident claims along the way turned out to be false.

`docs/SPECIALIZE.md` §13 and §14 hold the detail (the cross-compiler comparison, the A/B harness,
the measured clone-vs-re-lower table, and the image-shape promotion design). `docs/DECISIONS.md`
holds the rule that landed. This file is the narrative that connects them.

---

## 1. The question

Our JSL specialization seam had accumulated five recorded invariant bugs (SPECIALIZE §3, §10), each
fixed individually with its own guard. Fixing bugs one at a time and finding a sixth is the signal
that the bugs are symptoms. The suspicion was that specialization — re-lowering a JSL definition
from source under a site's proofs — was fundamentally not a sea-of-nodes transform, and that the
elegant answer was being missed.

Two questions followed from that:

1. Is re-lowering the wrong mechanism, and should it be replaced by graph cloning?
2. Where else is this compiler reaching around the IR instead of through it?

---

## 2. What the other sea-of-nodes compilers actually do

The reference we follow, Simple, has no generic operation — no `JsAdd` whose meaning is a type
dispatch — so fidelity to Simple cannot settle a question Simple never faced. The honest references
are the three production sea-of-nodes compilers, and they agree with each other.

| compiler | how a callee's IR reaches the call site |
|---|---|
| **HotSpot C2** | `Parse::do_call` parses the callee's BYTECODE into the caller's graph. Every node is created through `PhaseGVN::transform`, which runs Value (constant folding), Ideal and Identity at creation, so a branch whose test already folded is never parsed. Inlining is not a graph operation at all. |
| **TurboFan** | `JSInliner` does not copy an optimized callee graph: it runs the `BytecodeGraphBuilder` on the callee for a fresh subgraph and replaces the `Call` with it. |
| **Graal/Truffle** | The one graph-to-graph variant. Each method's graph is encoded once; `PEGraphDecoder` decodes it incrementally, canonicalizing as it decodes, so "dead branches are not parsed in the first place" (Würthinger et al., PLDI 2017 §5.1). Partial evaluation runs to completion, then hands a finished graph to the optimizer. |
| **Simple** | `copyBody` clones already-typed nodes and `IterPeeps` folds afterwards — sound only because Simple's callees have no dispatch tree to collapse. |

**All three build the callee fresh at the site and fold as they build.** Our JSL re-lowering *is*
that mechanism. It should not be replaced.

Note the cost of the alternative we'd rejected for the wrong reason: V8 keeps **two**
implementations of `+` — the Torque builtin and the C++ typed lowering — and has a team to keep them
in sync. SPECIALIZE §1's rejection of "operator as a node" stands, though the sharper reason is that
a `Call`+`CallEnd` already *is* the node, with a `compute` derived for free from the callee's
Returns.

### What actually diverged: placement, not mechanism

The specializer was consulted **per CallEnd, from inside `callend-maybe-inline!`** — interleaved with
inline decisions, while the worklist was draining and types were still moving. Simple's `IterPeeps`
states the invariant that bends:

> This should be linear because peepholes rarely (never?) increase code size.

Simple grows the graph in exactly one rationed way, `copyBody`. We were re-lowering entire JSL
bodies mid-fixpoint.

**All five recorded seam bugs are instances of that one violation**, not five separate bugs:

- a Cast recomputing wider (SPECIALIZE §3.1)
- a fresh link widening a callee's Parm (§3.2)
- a held Return released twice
- residual edges peepholed after the walk
- a loop tree built over a half-rewritten graph

---

## 3. What was fixed

### 3.1 Admission moved to a round boundary

`specialize-admit-round!` is now called once per `iter-run!` round, **after `iter-peeps!` has fully
drained the peephole worklist** — the graph is quiescent and every type has settled before a residual
is lowered into it. A round that specialized anything counts as progress exactly like a fired inline,
so the deferred inline set is retried.

Admission is **batched**, not rationed one-per-round like inlining: re-lowering replaces a call with
a residual *smaller* than the generic body it came from, so it is not the code-growing transform
inlining is. Truffle runs its partial evaluator to completion for the same reason.

`CallSpecializeExt` and its per-CallEnd consult are deleted. `aot.node.call` holds only an opaque
round-level hook and knows nothing about JavaScript.

**A design error caught by the gate.** The first cut put the rounds in `pipeline.coil` only. There
are **twelve** opto drivers across `src/` and `tests/`, and `parser-test-run-opto!` silently lost
specialization altogether — caught by the object-literal fold test. Requiring each driver to
remember a rounds call is exactly the kind of silent divergence that should be impossible, which is
why admission belongs inside `iter-run!` rather than in the pipeline.

### 3.2 Declining without registering a dependency

`prop-access-idealize` returned `None` on its early paths while registering nothing — and its own
comment claimed the access "is asked again". Nothing made that true. Simple's `LoadNode.idealize`
calls `addDep` on exactly the thing that blocked it (`addDep(st.ptr())`, `addDep(off())`,
`addDep(phi)`). This compiler's law is "deferred, never declined".

Fixed for the two early paths: control and memory when the optimistic pass has not reached the
access, receiver and memory on `PropUnknown`. **The remaining decline paths in that function still
register nothing** — unfinished work, listed in §6.

### 3.3 Instrumentation

`AOT_SPECIALIZE_TRACE=1` names the refusing condition on both sides — the JSL decision (definitions
pending, not one linked target, argument count, dead control, memory at TOP, no rule proven, callee
self-recursive) and the property proof (key not constant, receiver not a Box, facts not ready, image
shape lacks the key *with its name and written flag*, layout unknown, accessor, read of a written
key).

`AOT_INLINE_TRACE=1` now names the guard behind every `DEFER`.

An A/B harness for the seam, both presence switches (any value, including `0`, turns them on):

```sh
AOT_NO_SPECIALIZE=1     # admit no re-lowering; proven sites take the clone path instead
AOT_INLINE_UNCAPPED=1   # a JSL callee skips the evidence gate and both size caps
```

---

## 4. What the measurements said

### 4.1 Cloning vs re-lowering, by shape of program

| fixture | re-lowered | cloned |
|---|---|---|
| `s = s + i` in a loop (typed operators) | 100 nodes | **100** |
| `s.length + s.length` | 63 | **63** |
| `{x: n, y: 1}` then `p.x + p.y` | 39 | **736** |

Operators and strings are at **exact parity**: where the lattice already carries the fact, the seam
buys nothing. Property access is 19×, and it is *not* the size caps — `AOT_INLINE_UNCAPPED` does not
move it.

### 4.2 Why property access cannot be cloned — three findings

1. **A guard we added that Simple does not have.** 40 of 57 defers were `unknown-callers`.
   `jsl-close-world!` deliberately keeps the Start hook on shared provider definitions, and the
   decision asked `fun-unknown-callers?` *before* the trivial/clone split — so every shared JSL
   definition deferred forever and could never be cloned. Simple's `inlineCandidate` has no such
   check: the hook is just another input, so `fun.nIns() > 2` holds and it takes the **clone** path,
   which is sound because a clone is a private copy that leaves the shared body standing. Only the
   *trivial* fold destroys that body, so only the trivial arm may refuse.

2. **Correcting it is not a win on its own.** Default went 39 → 51 nodes: cloning shared definitions
   currently *costs* nodes. The corrected order therefore sits behind `AOT_INLINE_UNCAPPED` rather
   than landing as default behaviour.

3. **The real blocker is self-recursion.** With `unknown-callers` gone, all 109 remaining defers are
   `self-recursive` — `JsGetFromHolder`, the prototype-chain walk. Exactly one `object` Parm survives
   in the whole cloned graph, with five inputs **one of which is itself**. That is monovariant (0-CFA)
   erasure in its purest form: a self-recursive body whose parameter is the meet over all callers
   *including its own recursive edge*. Cloning a self-recursive function is loop unrolling, correctly
   refused, so no specialization mechanism reaches it.

Re-lowering wins here only because, working from source with the key constant, it folds
`%IsObjectLike` and `(%Eq key (%PropertyKey "length"))` **before any node exists**, so the entire
else-cascade — string, undefined, null, bool, symbol, number, containing all five `JsGetFromHolder`
calls — is never built.

### 4.3 The result that reframed everything

`AOT_SPECIALIZE_TRACE=1` on the harness realm, 2,484 refusals:

| refusal | count |
|---|---|
| **image shape lacks the key** | **1,605** |
| receiver is not a Box | 712 |
| key is not a constant | 167 |

And the missing keys:

| key | refusals | written? |
|---|---|---|
| `sameValue` | 501 | yes |
| `throws` | 334 | yes |
| `_isSameValue` | 334 | yes |
| `thrower` | 167 | yes |
| `toString` | 166 | yes |
| `Symbol.hasInstance` | 103 | no (genuinely absent) |

**Every one is a property assigned during realm setup** — `assert.sameValue = function…`,
`Test262Error.prototype.toString = …`. `AOT_FACTS_TRACE=1` shows the stores that create them
resolving to a *single named image entry* (`top false, 1 named`) on `StaticRef` receivers.

So the compiler knows the entry and knows the key. What it lacks is a **slot for the key in that
entry's image shape**, because the shape is fixed when the image is built and these properties only
appear while the Script initializer runs.

---

## 5. So — is it proper sea of nodes now?

**Partly. One real violation fixed, one still there, and the thing actually costing us is not a
sea-of-nodes problem at all.**

**Fixed — growing the graph mid-fixpoint.** This was the genuine violation, and all five seam bugs
were instances of it. Admission is now a round-level operation on a quiescent graph.

**Fixed — declining without a dependency**, on the two paths touched. That is peephole discipline,
not bookkeeping.

**Diagnosed, not fixed — two mechanisms where every production compiler has one.** We still have
clone-the-typed-graph for source functions and re-lower-from-source for JSL. C2, TurboFan and Graal
each have exactly one. But the mechanism we have is the *right* one, so this is cleanup, not a defect.

**Not fixed — folding from side tables instead of from types.** This is the original instinct,
precisely located. `prop-image-resolve!` reads `facts-written?`, `heap-storage-shape` and
`facts-layout-unknown?` — side tables frozen at a moment — keyed on the **node shape**
`(= (n-op object) OP-STATICREF)` in `prop-access-idealize`. Simple's `LoadNode.compute` reads the
field type off the **pointer's type**, which is why it is order-insensitive and why the optimistic
pass is a proof. Ours is structural and order-sensitive. That *is* an end run around the sea of
nodes, and it is still there.

**The twist.** What is actually leaving 17 `JsGetNamed` dispatch sites is none of the above. Even a
perfectly pure sea-of-nodes compiler with shape in the lattice would still fail here, because there
is **no shape fact to put in the lattice** — the property does not exist in the image yet. That is
an AOT whole-program modelling gap, not an IR-discipline gap.

The architectural instinct was right, the main instance of it is fixed, and it was not what was
making the compiler slow.

---

## 6. What to do next

### Step 1 — image-shape promotion (the one measured win)

65% of all refusals. Designed in full in SPECIALIZE §14. Promote `(entry, key)` into the entry's
image shape as a writable, enumerable, configurable data property with initial image word
`undefined`, when all of:

1. every store to that key resolves to that **one** entry — no `facts-any-key?`, no top/unknown
   owner, no escaped-with-unknown-owner;
2. at least one such store is **unconditional in the Script initializer** — its block dominates the
   initializer's Return and is not in a loop (`cfg-idom` / `idom-lca`);
3. `facts-layout-unknown?` is false — already `(descriptors OR deletes) AND written`, so any
   `delete`, `defineProperty`, `freeze`, `seal` or `preventExtensions` anywhere vetoes it;
4. the key is not an accessor;
5. the entry's **presence is never observed**.

**Why the slot is enough:** `prop-image-read` with the key present, writable and `written` true emits
two Loads — the properties word, then the slot at `shape-offset-key` — and no dispatch. Promotion
needs presence and attributes, *not* the stored value. We are adding a layout fact, not evaluating
the realm.

**The soundness hazard:** `PROP-HAS` consults shape presence, so a promoted key would make
`'sameValue' in assert` fold to `true` — including inside the initializer, before the assignment
runs. Condition 5 closes it and requires a **new fact**: the imagefacts scan must mark an entry when
it sees `PROP-HAS`, `PROP-ATTRS`, `JS-OBJECT-OWN-NAMES` or `JS-OBJECT-KEYS` on it. Coarse (any `in`
disables a whole entry) but sound; the exact version wants a presence bit distinguishing "absent"
from "present holding undefined", which is what real engines carry.

Promotion runs in **program order**, because a shape transition fixes a field's offset by its
introducing edge and therefore fixes enumeration order. It runs inside the existing `facts-signature`
loop in `pipeline-opto-under-facts!`, is monotone (promoted once, never demoted), so convergence is
unaffected.

Order of work: **1a** the presence-observed fact (the gate everything depends on) → **1b** the
promotion pass → **1c** pipeline wiring. Test on the deterministic harness-realm site count, never
on wall time.

### Step 2 — classify the second bucket BEFORE building for it

"Receiver is not a Box" is 712 refusals. A sample of 15 surviving receivers was 4 `Cast`, 3
`jsl.if{undefined,function}`, 1 Parm, 1 `Load` — and the Casts wrapped genuinely polymorphic values
(`this :dyn{undefined,bool,int,…}`). If that sample is representative, **most of this bucket is real
polymorphism and identity in the lattice would not touch it.**

Extend the refusal trace to print the receiver's node kind and type, run it once, and *then* decide.
One build, and it either justifies step 3 or saves it.

### Step 3 — identity in the lattice (the discipline fix)

This is what addresses §5's remaining defect: make the property fold read the receiver's **type**
instead of matching `OP-STATICREF`. Worth doing for order-insensitivity even if step 2 shows the
immediate payoff is small.

**One design correction:** model identity as **a type** — a real sub-lattice with distinct top and
bottom — the way the `int` component already meets through `ty-meet` recursively. The earlier attempt
(SPECIALIZE §11) used the `TY-DYN-NO-ENTRY` / `TY-DYN-ANY-ENTRY` sentinel pair, which made the
component self-dual and let GVN's `ty-join` drop it.

### Hygiene, worth folding in

- **The evidence gate does nothing in `PHASE-ITER`** — 276 queries, 0 inlines fired. Dead work on
  every compile.
- **`prop-access-idealize`'s remaining decline paths** still register no dependency.
- **Pure JsOps take `JSOP-MEM` and never GVN** — `eq-extra`/`hash-extra` compare **nids**, so a JsOp
  is only ever equal to itself, and `no-const-fold?` is `true`. A real defect — but it could not be
  shown to cost anything, so it is hygiene, not a performance item.

### Parked

The `unknown-callers` guard correction is Simple-faithful but costs nodes without fold-on-copy, so it
stays behind `AOT_INLINE_UNCAPPED`, documented in SPECIALIZE §13, rather than landing a regression.

---

## 7. Results

912 tests green, lint and `coil check` clean.

| measure | before | after |
|---|---|---|
| harness realm, ideal nodes | 4,464 | **4,289** |
| harness realm, `JsGetNamed` call sites | 18 | **17** |
| fib(30) steady state | 5.21–5.29 ms | **5.16–5.22 ms** |
| binary trees | 461 ms | **441 ms** |
| compile time, richards / deltablue | 12.73 s / 19.64 s | 12.75 s / 19.54 s |
| fixture node counts (ops / prop / str) | 100 / 39 / 63 | unchanged |

The placement change was expected to be behaviour-neutral — its point is removing a bug *class*, not
moving numbers — so the small harness improvement is a bonus, from types having settled before
admission runs.

---

## 8. Claims made during this audit that were false

Recorded because the pattern matters more than any one error.

- **"`JsOpNode.idealize` returns `None`, so the whole JsOp family is terminal and that is the root
  cause."** The source facts are real — `eq-extra` compares nids so a JsOp never GVNs,
  `no-const-fold?` is `true`, pure primitives still take `JSOP-MEM` — but it was never shown to cost
  anything, and both attempts to demonstrate it failed. Duplicate `.length` on a constant folded to
  `Con :int:10` with zero JsOps, and the JsOps surviving a real program were `JS-UNCAUGHT`, correctly
  effectful. A source smell was pattern-matched into a causal story.
- **"The `Box(StaticRef)` receiver is not recognized."** `property-specialization-proven?` already
  accepts it.
- **"The `written` flag blocks the read proof."** Removing it moved nothing.
- **"Simple only adds call-graph edges in the optimistic pass."** `CallNode.idealize` links in the
  pessimistic pass too.
- **"One expansion becomes twelve copies."** Most `JS-PROP-GET` come from JSL lowering itself
  (`src/jsl/lower.coil:945`).
- A gate was reported green when it had failed 910/2 — the exit code read was a `tail`'s, not the
  test run's.

Three confident diagnoses in a row, each costing a build. What produced knowledge was
instrumentation, not source reading: the refusal trace answered in one run what the guesses had not.
**When a fold, inline or specialization does not fire, the first change is the trace that names the
refusing condition.** A tri-state answering `DEFER`, or a proof answering one bool behind seven
conditions, carries no information about which guard fired.
