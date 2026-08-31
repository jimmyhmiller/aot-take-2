# HANDOFF

State of the tree and what to do next. Read `CLAUDE.md` first — its two rules are absolute — then
`docs/LAYOUT.md` for the architecture and `docs/FRONTEND.md` for how the frontend meets JSL.

**Gate:** `coil check` 0 · `coil fmt --check` 0 · `coil verify` 0 · **0 lint warnings** · **250 tests**

Run all four before claiming anything. `coil lint --fix` is mandatory on every change, and the
project carries zero warnings at all times.

---

## What is real

The implemented areas below are real and tested. Of the 250 tests, 236 are real; the other 14 are
one-line placeholders, one per not-yet-built area, deliberately named so gaps show in
`coil test --list`.

| area | module | what works |
|---|---|---|
| engine | `node/node.coil` | header + `NodeOps`, bidirectional edges, keep/kill/subsume, GVN table with lock/unlock, far-field deps, the peephole, the arena, the control-version counter |
| worklist | `util/worklist.coil` | seeded random pop; the seed is the point |
| fixpoint | `codegen/iterpeeps.coil` | peepholes and inlining to a fixpoint, including unused-node cleanup, far-dependency wakeup, and Simple's full `progressOnList` invariant |
| lattice | `type/type.coil` | interned simple types, ints, floats, arbitrary-arity tuples/signatures, multi-target function-pointer sets with meet/dual/join, and dynamic tags |
| values | `node/constant.coil` `arith.coil` `bits.coil` `compare.coil` | Con · Add Sub Mul Div Shl Minus ToFloat RoundF32 · And Or Xor Shr Sar · EQ NE LT LE ULT · Not, including IEEE float constants and mixed numeric conversion |
| control | `node/control.coil` `cfg.coil` `phi.coil` | Start Stop Region Loop If CProj Proj XCtrl Never Return Phi, both construction windows, dominators |
| calls | `node/call.coil` | Fun-as-Region, Parm-as-Phi, Call, CallEnd, FunPtr, linking, tri-state `maybeInline`, trivial and shared-body clone inlining |
| dynamic | `node/dynamic.coil` | Box Unbox TypeTest Cast, the pair-cancel, `guard!` |
| rewrite | `node/phicon.coil` | push a constant up through a Phi |

### The narrow integer-specialization chain is closed

```
Call(JsAdd, a, b)        a, b proven int
  inline                 Fun-as-Region + Phi-as-Parm    ✅
  %IsString folds false  If / CProj dead-control        ✅
  the dead arm vanishes  Region dead-path removal       ✅
  Box/Unbox cancel       the dynamic unit               ✅
  Add(a,b) folds         the arithmetic engine          ✅
```

Those five mechanisms are tested independently for a hand-built, two-argument integer fixture.
This is not a claim that real `JsAdd` or general JSL can run: JSL lowering, `JsOp`, memory, and
broader dynamic representations are still absent. Direct-call linking, arbitrary-arity tuples and
the multi-target function-pointer lattice are implemented.

### Correctness blockers found by the Simple audit

1. Box/Unbox currently covers numeric representations, not the full declared JavaScript tag set.
2. Multi-target SCCP linking needs the compilation-unit function-index registry. Direct FunPtr
   calls link automatically today; no global registry is fabricated in its absence.

### Correctness repairs already landed

The latest audit fixed these silent failures. They are part of the baseline now, not work still
owed:

- float constants intern by their IEEE-754 bits, keeping `+0` and `-0` distinct and making an
  identical NaN payload stable; float meet now follows Simple's width/high-low ordering
- JavaScript branch truthiness sends `nil`, both signed zeros and NaN down the false arm
- function-index sets are canonical, unbounded side-table sets, so function 64 cannot alias 0
- a `Fun`'s signature participates in GVN identity
- CallEnd control and result projections use the Multi `pcopy` hook, including projections created
  after trivial inlining starts
- HIGH result projections from an unresolved CallEnd remain attached during optimistic call-graph
  discovery so later Return linking can sharpen them
- duplicate uses are rewired one edge at a time during `subsume`
- an open Phi input is neither a constant nor GVN-equal to another open Phi merely because its
  missing edge is represented by null
- unsigned ranges crossing zero stay undecided under `ULT`, and `ULT(x,x)` folds false
- resetting the node arena clears the inline and deferred-inline queues as well as the main
  peephole worklist
- Add now implements Simple's complete left-spine formation for the scalar core: Minus conversion,
  RHS-Add rotation, constant sinking, Phi-aware spine ordering, and Phi-constant pushing. The
  equivalent arithmetic program reaches `Add(Add(arg, Sub), 3)` after Iter.
- Sub normalizes both `x - (-y)` and `(-x) - y`; integer Mul lowers zero, powers of two, and the
  profitable `2^n ± 1` shapes, and participates in Phi-constant propagation.
- Shl sharpens non-overflowing ranges and distributes over a canonical Add with a small constant.
- Dynamic-tag and function-index high/low set meet uses complemented-set difference in mixed cases;
  meet is associative and commutative across optimistic and proven values.
- Phi uniqueness skips dead control and waits on dead Loop entries; same-op probing allocates no
  throwaway node. All-dead Regions collapse directly to XCtrl without a second-visit crash.
- Phi construction remains open until both its Region and its own final value are closed, preventing
  reverse closure from enabling compute, folding, idealization, or GVN. Same-op pull-down covers
  the implemented unary and binary scalar operations.
- SCCP numeric evidence crosses CallEnd result projections and hands every live node to post-SCCP
  peepholes. HIGH CallEnd projections stay attached until late Returns sharpen them.
- GVN verification recomputes structure instead of echoing the cache; unary Minus mode participates
  in GVN identity.
- Calls with the temporary null memory input remain distinct GVN sites, so one effectful execution
  cannot erase another before memory SSA supplies the ordering edge.
- Stop and folding CallEnd expose final-Simple CFG metadata. Internal i64 shifts mask counts modulo
  64. IEEE float algebra does not use integer reassociation or pre-rounded reciprocal division.
- A nested If recognizes the structurally proven true-arm Cast of its dominating predicate, not
  only pointer-identical repeated predicates.
- Return now has the final four inputs `(control, memory, value, RPC)`, with Fun ownership stored as
  separate node metadata exactly as in Simple. CallEnd has the matching three projections and
  preserves the full linked Return state. Trivial inlining clears RPC before the ordinary Fun/Parm
  collapse. Until memory and RPC land, those graph inputs are explicit null/`TOP` slots.
- Float Add/Sub/Mul/Minus and comparisons fold IEEE constants and convert mixed numeric operands
  explicitly; signed zero and NaN behavior are covered.
- FunPtr values refresh their signature when the referenced Fun sharpens, preserving their target
  set and waking affected calls.
- IterPeeps now matches Simple's cleanup and progress bookkeeping, and its expensive fixpoint audit
  covers monotonicity, normal and inline worklists, unused live nodes, and missed peepholes.
- Optimistic SCCP snapshots bottom-up types, resets live nodes to TOP, checks both monotonicity
  bounds, propagates to closure, lazily links direct calls, and resolves recursive numeric modes.
  Provenness is now a greatest-fixed-point query over a stable node/input cone, not a type property.
- CProj-local JavaScript truthiness builds pinned Casts with integer-range and dynamic-tag
  refinement. Phi pulls matching scalar operations below a merge and recovers a value merged from
  zero plus its structurally proven truthy Cast.
- The verifier checks exact bidirectional edge multiplicity, dead inputs, Phi/Region arity, type
  direction, and stale GVN hashes, and reports named codes.

---

## How to build the frontend without losing Simple's trick

Final Simple does not parse into an AST and later run an SSA conversion. Its recursive-descent
parser owns one current `ScopeNode`; parsing an expression constructs ideal nodes immediately, and
parsing control flow duplicates and merges scopes. A binding is an ordinary graph edge held by the
Scope, so SSA is a consequence of graph construction rather than a later pass.

JavaScript requires one deliberate adaptation, already specified in `docs/FRONTEND.md`: first
build a **thin syntax-only tree** to resolve cover grammars, hoisting, forward TypeScript names and
closure capture. Then make exactly one lowering walk over that tree. That walk is our equivalent of
Simple's parser. It constructs the sea of nodes directly through `ScopeNode`; it must not produce a
typed AST, a bytecode-like IR, or a second SSA representation.

The invariant is:

```
syntax question             ask the temporary Syntax tree
current control/memory/name ask ScopeNode
JavaScript semantic step    emit Call(<JSL entry point>, ...)
optimization/type fact      ask the ideal graph
```

### The lowering context

At every point the lowering walk owns one current Scope and the current function state. The Scope
holds control in slot 0, memory in slot 1, and every live lexical binding in subsequent slots. The
context also carries the current break, continue, return and exceptional-exit scopes. Those are
merge destinations, not side lists of statements.

Reads use `scope-lookup`; assignments replace the binding edge with `scope-update!`. A declaration
installs its declared type, finality and initial value in the Scope. Nothing consults a separate
symbol-to-value map after declaration resolution—the Scope is the current SSA environment and is a
real user of every value it binds.

### Control flow recipes to copy from final Simple

- **If / conditional / short-circuit:** create `If` and both `CProj`s before optimizing either;
  duplicate the incoming Scope; lower each arm under its projection; install lexical guards on the
  arm; remove those guards at arm exit; balance declarations; merge the two Scopes with one Region
  and create Phis only for slots whose node identities differ. Expression forms add one result Phi
  on that same Region.
- **Loop:** create an open Loop from entry control; retain the entry Scope and duplicate it in loop
  mode. Non-final variable and memory slots initially point to the entry Scope as lazy-Phi
  sentinels. Reading or updating through a sentinel materializes the Phi. Lower the predicate,
  false exit, true body, continues and increment while the Loop is open. `scope-end-loop!` is one
  protected finalization operation: final Simple wires the Loop control backedge first and then
  immediately fills all materialized Phi backedges, kills the backedge Scope and removes useless
  Phis. No peephole may observe the intermediate state.
- **Break / continue / return / throw:** duplicate the current Scope into the corresponding merge
  destination, merge it there, then set current control to dead. This preserves memory and locals
  on every exit; it is not merely a control jump.
- **Narrowing:** install Casts into Scope bindings on the appropriate CProj, so later reads receive
  the refined value directly. Keep this lexical mechanism visible until the branch is lowered.

### JavaScript semantics belong behind calls

The lowering walk knows syntax-to-entry-point names, not ECMA-262 algorithms. `a + b` emits a Call
to `JsAdd`; a property read emits a Call to `GetNamedProperty` or `GetElement`; a user call emits
the JSL `Call` operation with the correct receiver and argument-list construction. JSL definitions
lower into ordinary `Fun` graphs and specialize through the existing inliner and peepholes. Never
emit raw `Add`, `Load`, or shape operations merely because a common case looks obvious—the JSL
graph must expose and then prove that fast path.

TypeScript annotations follow the same rule. Declaration resolution records the claimed type, but
lowering installs a guard unless closed-world graph evidence proves the claim. The annotation may
select a specialized path; it never changes JavaScript behavior by fiat.

### Implementation order and acceptance tests

1. Implement the JSL reader/checker/lowerer for `FixtureSub`, then prove a hand-built
   `Call(FixtureSub, 5, 3)` folds to `2`. This validates the semantic-call boundary before the
   source frontend can emit unresolved names.
2. Implement `ScopeNode` completely and test it without a parser: lexical shadowing, branch merge,
   lazy variable and memory Phis, loop finalization, break/continue/return merges and guard
   installation/removal.
3. Implement tokens and the dense syntax arena, then cover-grammar and declaration-pass tests.
4. Implement the lowering context and a minimal function body containing constants, bindings,
   assignment, return, If and Loop. Compare each graph structurally with an equivalent program
   built by hand using the Simple recipes above.
5. Add syntax-to-JSL dispatch incrementally. Every new syntax family must have a graph-shape test,
   an observable execution test once execution exists, and a refusal diagnostic for unsupported
   forms. Never silently fall back to a placeholder node.

The first source-level vertical slice should be intentionally small but structurally complete:

```js
function chooseAndCount(flag, n) {
  let x = 0;
  if (flag) x = 1;
  while (x < n) x = x + 1;
  return x;
}
```

Its acceptance criterion is not merely “a graph was produced.” The graph must contain the expected
Fun/Parm/Return/Stop spine, If/CProj/Region/Phi merge, open-then-closed Loop and loop Phi, Scope-held
memory state, and Calls to the appropriate JSL comparison/addition/truthiness entry points. After
optimization, graph verification and the peephole fixpoint audit must still pass.

## Next milestone: JSL fixture lowering, ScopeNode, then the frontend

`tests/graph-gen.coil` builds shrinkable, well-formed expression DAGs and control diamonds.
`tests/graph-property-test.coil` checks edge multiplicity, model agreement, peephole closure, and
Region/Phi arity over 200 generated cases per property. The existing-core audit is closed. Proceed
with the fixture JSL lowering boundary, then `ScopeNode`, then syntax and source lowering in the
order above.

`tests/program-graph-test.coil` now builds complete Stop-rooted equivalents of the two Simple
comparison programs. It proves the `Start → Fun/Parm → Return → Stop` spine, floating data control
slot, shared uses, `If → CProj → Region`, and positional `Region/Phi` correspondence. The dump tool
emits both pre-Iter and post-Iter graphs; these are program graphs rather than disconnected
expression/Phi fragments.

### `src/jsl/` — the front half

This is the work. Four modules, all currently hard-error stubs:

| file | what it owes |
|---|---|
| `jsl/reader.coil` | read `.jsl` with `coil.reader`; `jsl-load-index!` over `jsl/index` |
| `jsl/prims.coil` | the `%Name` table → `aot.node.jsops` indices, arity, `transitioning?` |
| `jsl/check.coil` | the checker, which **refuses by name** what it cannot lower |
| `jsl/lower.coil` | JSL → `Fun` graphs of the nodes above |

### Do it on a fixture first

Put it in `tests/fixtures/*.jsl`, loaded only by tests. **`jsl/` stays exactly the real ECMA-262
library so that no coverage claim can ever cite a fixture.**

The first target must have no transitive closure:

```lisp
(builtin FixtureSub :params [(a dyn) (b dyn)] :ret dyn
  (%Box (%Sub (%UnboxInt a) (%UnboxInt b))))
```

A real `jsl/` builtin does not work yet as a first step, and the reason is worth knowing: `JsSub`
looks isolated, but `NumberRaw` is `(%UnboxNumber (ToNumberValue v))`, and `ToNumberValue` reaches
`ThrowTypeError`, `IsNumber`, `ToPrimitiveNumber` and thence `ToPrimitive`, `GetMethod` and `Call`.
**Lowering is transitive even when folding is not** — on two proven integers `IsNumber` folds true
and the whole `ToPrimitive` arm is dead, but the arm still has to be BUILT before it can be deleted.

The end-to-end test to aim at: hand-build `Call(FixtureSub, 5, 3)`, run the fixpoint, watch it fold
to the constant `2`. That exercises the reader, lowering, the primitive layer, Fun/Call, the
inliner, Box/Unbox cancellation and the peephole fixpoint in one assertion.

### Two things `src/node/jsops.coil` needs first

It is stubbed. The `JsOp` node carries a primitive index — **one node kind, not one per builtin** —
and the constants are already written. `%Box`, `%Sub`, `%UnboxInt` map to existing nodes rather than
to `JsOp`, so the fixture above needs almost none of it; a real builtin needs the string and object
primitives, which need the memory unit.

---

## Recently closed existing-code debts

- General graph copy and the `INLINE-CLONE` path are implemented and invariant-tested.
- Function body size is recorded from the dense construction span when the Return is attached and
  recomputed from the CFG-bounded live body at each inline decision, covering later graph growth.
- The blanket `n-in-safe` usage was audited: strict `n-in` now covers computations, graph walks,
  verification, printing and bounded loops. The remaining uses are only killed-node control queries
  and CallEnd's explicit mid-death candidate check.
- Phi scalar same-op pull-down and truthiness-Cast recovery are implemented. Memory-specific Phi
  rules correctly wait for the unwritten memory node family rather than fabricating weaker behavior.

---

## Traps that have already cost time

**The three ways a falsification silently lies.** A test that cannot fail is not a test, so every
mechanism gets broken deliberately to confirm the right test goes red. Three times the sabotage
"passed", each for a different reason and all identical from outside:

- a `sed` pattern spanned lines and never applied — **verify the injection landed**
- there was no test for that case at all — a real coverage gap
- `compute` returns high before `idealize` runs, so the guard is **unreachable through `peephole`**;
  test those by calling the rule directly, asserting both the refusal AND the legitimate case

**Text edits that do more than intended.** An `awk` rewrite once ate everything after its marker —
`bits.coil` went from ~230 lines to 78, deleting a whole node family. `coil check` passed, because
nothing referenced the constructors until a test did. Prefer whole-file rewrites over clever
in-place surgery, and check line counts after.

**`coil lint --fix` rewrites your code.** Always follow it with `coil check` and `coil test`. It has
a known defect where a failed run can report `all changes reverted` while leaving files modified
(filed in the `coil-bugs` pad).

**Exit codes through pipes.** `cmd | head` reports `head`'s status. I twice concluded something
passed or failed on that basis. Redirect and check `$?` directly.

---

## Rules that are load-bearing, restated

- **A rewrite may only act on a PROVEN type** — transitively over the whole input cone, as a
  fixpoint, not "is it not TOP". `ANY` is the absence of information; every other high type is a
  claim someone computed. The live `n-proven?` graph walk enforces this for irreversible rewrites;
  new node families must extend that proof boundary rather than bypass it.
- **Construction has windows.** A Region under construction reports CONTROL and its Phis report
  their DECLARED types. Finalize a loop through `scope-end-loop!`: it wires control first and then
  immediately fills every materialized Phi, with no peephole between those steps. A Phi's own null
  final input independently keeps it open during that interval. An `If` is in progress until ALL
  its projections exist — use `if-arms!`.
- **Region arity and Phi arity are ONE invariant**, and a Parm IS a Phi, so `phi-like?` counts it.
- **Types RISE in `iterpeeps` and FALL in `opto`.** The two assertions differ; one shared assertion
  would be wrong for one of them.

---

## Known divergences from Simple, deliberate and recorded

- **Empty diamond**: Simple guards it `nIns()>3` and then opens with an `nIns()==3` branch that guard
  makes unreachable, so its live path only handles the fat case. Both cases are individually correct;
  we implement both. Tested in both shapes.
- **`x == x` in float mode**: Simple returns TRUE unconditionally, which is wrong for NaN. Simple's
  floats never carry NaN on that path; JavaScript's do. Ours is integer-only, like `x - x -> 0`.
- **The lattice is one module.** `docs/LAYOUT.md` originally proposed per-family type modules; that
  cannot work, because `meet` and `dual` CONSTRUCT types and Coil has no cyclic imports. Java gets
  the split free through virtual dispatch on `xmeet`. Recorded at the top of `type/type.coil`.
- **Mixed-flavour meet on the dynamic axis** is conservative — `low (A ∪ B)` is a sound lower bound
  but not necessarily the greatest. Precision, never soundness.
