# HANDOFF

State of the tree and what to do next. Read `CLAUDE.md` first — its two rules are absolute — then
`docs/LAYOUT.md` for the architecture and `docs/FRONTEND.md` for how the frontend meets JSL.

**Gate:** `coil check` 0 · `coil fmt --check` 0 · `coil verify` 0 · **0 lint warnings** · **161 tests**

Run all four before claiming anything. `coil lint --fix` is mandatory on every change, and the
project carries zero warnings at all times.

---

## What is real

Fifteen modules with no stubs in them, and 144 of the 161 tests are real (the other 17 are one-line
placeholders, one per not-yet-built area, deliberately named so gaps show in `coil test --list`).

| area | module | what works |
|---|---|---|
| engine | `node/node.coil` | header + `NodeOps`, bidirectional edges, keep/kill/subsume, GVN table with lock/unlock, far-field deps, the peephole, the arena, the control-version counter |
| worklist | `util/worklist.coil` | seeded random pop; the seed is the point |
| fixpoint | `codegen/iterpeeps.coil` | peepholes to a fixpoint, **the inline worklist interleaved**, the `progressOnList` invariant check |
| lattice | `type/type.coil` | interned, `meet`/`dual`/`join`/`isa`, int ranges, floats, tuples, function pointers, **the dynamic tag axis** |
| values | `node/constant.coil` `arith.coil` `bits.coil` `compare.coil` | Con · Add Sub Mul Shl Minus · And Or Xor Shr Sar · EQ NE LT LE ULT · Not |
| control | `node/control.coil` `cfg.coil` `phi.coil` | Start Stop Region Loop If CProj Proj XCtrl Never Return Phi, both construction windows, dominators |
| calls | `node/call.coil` | Fun-as-Region, Parm-as-Phi, Call, CallEnd, FunPtr, linking, tri-state `maybeInline`, **trivial inlining that clones nothing** |
| dynamic | `node/dynamic.coil` | Box Unbox TypeTest Cast, the pair-cancel, `guard!` |
| rewrite | `node/phicon.coil` | push a constant up through a Phi |

### The five JSL links are all closed

```
Call(JsAdd, a, b)        a, b proven int
  inline                 Fun-as-Region + Phi-as-Parm    ✅
  %IsString folds false  If / CProj dead-control        ✅
  the dead arm vanishes  Region dead-path removal       ✅
  Box/Unbox cancel       the dynamic unit               ✅
  Add(a,b) folds         the arithmetic engine          ✅
```

Every mechanism `JsAdd` needs to specialise from a call into one machine `Add` exists and is tested.
**No new IR machinery is required to run JSL.**

---

## Next: `src/jsl/` — the front half

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

## Owed before or alongside, in priority order

1. **`Div`, `ToFloat`, `RoundF32`** — opcodes exist, nodes do not. `ToFloat` is cited as owed by
   `compare.coil`'s float-conversion rule, so that rule cannot fire. Small; finish the value family.
2. **Region rule 5** — flatten stacked Regions. Described in `control.coil`'s header as if it exists;
   it does not. `hasMidUser` is the guard, and Simple is candid that fusing without it is unsafe.
3. **The CProj Not-flip** — Simple rewrites `CProj(If(Not(x)))` to swap the arms and drop the `Not`.
   Not implemented and not previously recorded as owed.
4. **The clone-inline path** (`INLINE-CLONE`) — needs a general graph copier, which the serializer
   also wants, so write it once. Until then a multi-caller function is not inlined: correct, weaker.
5. **`Node.java` API not ported** — `copy` (the clone path needs it), `walk`, `err` (Simple's whole
   diagnostic path), `addDepForwards`, `killOrdered`, `isMem`, `popUntil`, `insertDef`, `setDefX`.
6. **Audit the 32 `n-in-safe` sites.** It was applied by a blanket `sed`. It is right where a killed
   node is legitimately walked; some of those may be masking a real out-of-range read that `n-in`'s
   panic would have caught.
7. **Phi rules 3 and 4** — the same-op pull-down and the two null-check merges. Need MemOp and
   Guard/Cast respectively.

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
  claim someone computed. `ty-proven?` is still a stub, and every irreversible rewrite that should
  be gated on it currently is not.
- **Construction has windows.** A Region under construction reports CONTROL and its Phis report
  their DECLARED types; close the Phis before the control back edge or the loop is deleted with no
  error. An `If` is in progress until ALL its projections exist — use `if-arms!`.
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
