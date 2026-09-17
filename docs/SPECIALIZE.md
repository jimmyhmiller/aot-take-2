# Proof-driven specialization: idealization as a JSL feature

This is the design for making a JSL definition carry its own idealization rules, and the inventory of
where to apply it. It is a proposal: nothing here is law until it lands and `docs/DECISIONS.md` records
it. Every number in it was measured on 2026-09-17 at commit `9c221b1`; the commands are in §9.

---

## 1. The idea, and why it is not a new IR

A JavaScript operation is a JSL definition — `a + b` is a call to `JsAddOperator`, `o.x` is a call to
`JsGetNamed`. Whether that call disappears is decided today by the *inliner*: a size cap on the
unspecialized body, and an evidence gate. That is the wrong decider, because the question is not "is
this body small" but "does what I know at this site collapse this body".

The mechanism for asking the right question already exists and is used by three definitions:
`:specialize` (and its variant `:inline-when`). A declaration lists **proofs**; when the lattice proves
one at a site, the compiler re-lowers **the JSL body itself** at that site, where the now-constant tag
tests fold during lowering:

```
jsl/compiler/property.jsl:63   JsGetNamed        :specialize [(%OwnDataProperty object key) (%StringLength object key) (%ArrayLength object key)]
jsl/compiler/property.jsl:145  JsDefineOwnNamed  :specialize [(%OwnWritableDataProperty object key)]
jsl/compiler/call.jsl:7        JsInvokeCallable  :inline-when [(%IsFunction callee)]
```

So idealization is already a JSL feature. The semantics stay in one place — the JSL source — and the
compiler contributes only the proof and the decision. An ideal node per operator whose `idealize`
emitted raw integer and float operations was the alternative considered and **rejected**: it would put
the int and binary64 arms of `+` in `src/` as well as in `jsl/`, which the second project rule forbids
in spirit and which would drift.

What is missing is that the numeric operators carry no rules, the rule language cannot say what
arithmetic needs, and the mechanism has two invariant bugs outside the one shape it has been used in.

## 2. What it costs us today (measured)

`JsLtOperator` is 106 nodes at construction, over Simple's cap of 100 (`INLINE-MAX-SIZE`,
`src/node/call.coil:171`), so the ordinary inliner answers `NEVER` — permanently, since a construction
size never changes. With rules it would never consult that cap: the specialize path runs first
(`src/node/call.coil:1536`) and does not look at size at all.

Because it was the inliner's job, `fib` was made fast by reshaping JSL until the bodies fit under the
cap. That cost:

| | ideal nodes, test262 harness realm | fib(30) |
| --- | ---: | ---: |
| integer ranges only (`2eba26c`) | 4,083 | 8.1 ms |
| operator arms + `:noinline` generics (`9c221b1`) | 4,769 | 5.2 ms |
| same, generics inlinable | 4,436 | 17.9 ms |

Half of the +686 is three-way dispatch inlined at sites where no arm folds; half is `:noinline`
preventing per-site specialization, which keeps `RangeError`, `Symbol` and `JsToString` bodies alive.
Six `:noinline` marks in `jsl/compiler/int-arith.jsl` and a budget ceiling raised from 6,500 to 7,000
machine nodes are the visible scars. Both come out if the operators specialize on proof instead.

## 3. Two invariant bugs to fix first

Both were reproduced by adding `:specialize [(%IsNumber a) (%IsNumber b)]` to the six operators in a
throwaway worktree and compiling `benchmarks/fib-steady.js`.

### 3.1 A specialization must preserve the proof the site already had

```
n-set-ty!: monotonicity violated: new type dyn is not at least as specific as
  old dyn{bool,int,double,string}
  node: Cast :dyn{bool,int,double,string}   origin: frontend expression source
```

The parser wraps a throwing call's result in a Cast asserting "not the exception sentinel"
(`lower-exception-check!`, `src/parse/parser.coil`). `prop-access-forward!`
(`src/node/property.coil:373`) rewires the site's projections to the residual body's value, which is
typed by the *declaration* and still includes every tag. The Cast then recomputes wider than before.

`JsGetNamed` never hits this because its declared result is already the widest type. An operator's is
not.

**Fix.** When forwarding, if the residual value's type is not `isa` the projection's existing type,
interpose `Cast(ctrl, value, old-type)`. This is sound: the old type is the meet of the callee's own
Returns joined with the declaration — a fact the callee proved, which specializing must not discard.
Verified: with this fix, `fib-steady` compiles with `JsLtOperator` specialized and runs at 5.4 ms.

### 3.2 Linking a call must not widen a Parm in the pessimistic pass

```
n-set-ty!: monotonicity violated: new type dyn{int:100,double,string} is not at least as
  specific as old dyn{double,string}
  node: b :dyn{double,string}   in3: iterations :dyn{int:100}
```

A residual body contains calls of its own. `call-idealize` links a call to its callee as soon as the
function pointer is a singleton (`src/node/call.coil:1047`) — in the pessimistic pass as well as the
optimistic one. Linking adds a caller, and a `Parm` is the meet over its callers, so a new caller with
a type outside the current meet **widens** it. In the pessimistic pass that is a monotonicity
violation.

Simple links in the very same place — `CallNode.idealize` (`node/CallNode.java:96-112`) links during the
pessimistic peephole — so this is not a phase-ordering divergence. It is safe there for two reasons.
Before Opto every Fun carries its unknown-caller hook (`FunNode.compute`, `:135-148`), so its Parms hold
their declared types and no link can widen them; `unlinkStart` removes the hook inside Opto, exactly as
`parser-close-world!` does here. Simple then runs a pessimistic iterate as well (`Opto.opto`), but it
never MANUFACTURES a call: its only body-growing transform is cloning, and a clone's links carry
argument types already in the meet. JSL specialization does manufacture calls — re-lowering a body at a
site brings that body's own calls with it — and that is the divergence. The three definitions that
specialized before this work happened to re-lower into bodies whose callees' Parms were already at
their widest, so it never showed.

**Fix.** Linking is an optimistic-pass action. Concretely: in `call-idealize`, before linking, if the
link would widen any of the callee's Parms and we are not in the optimistic pass, do not link — register
a dependency and let the next optimistic pass do it. This is Simple's phase discipline stated as a local
rule, and it keeps the existing clone-inline links (whose argument types are clones of types already in
the meet) working unchanged.

### 3.3 While here: the specialize path has no budget at all

`jsl-specialize-call!` consults no size, no caller count and no global counter
(`src/jsl/lower.coil:283-316`). That is *why* it works for arithmetic, and it is also unbounded. §5 adds
the two guards that keep it honest.

## 4. The rule language

### 4.1 What exists

A rule list is `:specialize [rule …]` or `:inline-when [rule …]`, evaluated by
`jsl-specialization-proven?` (`src/jsl/lower.coil:258`):

- `(%IsX param)` — a tag predicate over one named parameter, proven when the argument's lattice type
  `isa` that tag set (`jsl-tag-predicate`, `src/jsl/check.coil:154`).
- `(%OwnDataProperty object key)`, `(%OwnWritableDataProperty object key)`, `(%StringLength object key)`,
  `(%ArrayLength object key)` — the property-specific proofs, which additionally consult memory and the
  interned key.

The list means **any** rule proven grants permission to re-lower. A proof is permission only: ordinary
JSL lowering still decides what folds. Each rule registers a dependency on the argument it names, so a
declined site is re-asked when SCCP sharpens it.

### 4.2 What arithmetic needs added

1. **Conjunction.** `+` wants "both operands are Numbers", not "either". A top-level rule element that is
   itself a list of predicates means all-of:
   `:specialize [[(%IsNumber a) (%IsNumber b)] [(%IsString a) (%IsString b)]]`
   Top-level elements stay alternatives. `[(p)]` and `(p)` are the same rule.
2. **Tag-set predicates in rules.** `%IsNumber` (int or double) exists as a predicate since
   `9c221b1`; the rule vocabulary should admit any name `jsl-tag-predicate` answers, including
   `%IsObjectLike` and `%IsNumber`, rather than a hand-listed subset.
3. **Payload proofs.** Now that `dyn` carries an integer range, a rule can ask for more than a tag:
   - `(%IntPayload a)` — `a` is an integer whose range is inside the signed-48 payload, so the overflow
     arm of `JsBoxInt48` folds without any guard.
   This is the first proof that reads the new lattice component, and it is what makes `fib`'s arithmetic
   collapse without the operator-body gymnastics.
4. **Checker validation.** `jsl-check` must refuse a rule naming a parameter the definition does not
   have (it does), and additionally refuse a rule whose named parameter the body never tag-tests — a rule
   that cannot fold anything is a declaration bug, and this is the static half of "evidence must fold".

### 4.3 What is deliberately not added

Negative proofs (`(%NotString a)`), disjunction inside a conjunction, and proofs over two parameters'
relationship (`a` and `b` have the same tag). Each is expressible later; none is needed by tiers 1–2, and
the equality operators can use `[(%IsInt a) (%IsInt b)]` style all-of rules instead.

## 5. The decision, end to end

`jsl-specialize-call!` keeps its current preconditions — definition has rules; the call's pointer is a
singleton local `FunPtr` (or a declared import); argument count matches the parameter list; control is
not XCTRL; memory is not high; no JSL definition is pending — and gains two guards:

- **A proof must resolve a dispatch.** Enforced statically by §4.2.4 (every rule names a parameter the
  body tests), so no dynamic check is needed at the site.
- **A per-definition specialization cap.** A counter per definition per compilation unit; past the cap
  the site *declines* and keeps the shared call. It is a backstop against a proof that turns out to fold
  little at a great many sites, not a budget anyone should be tuning; the default should be high enough
  never to bind on the test262 harness (measure, then set — on the numbers in §2 a cap of 64 per
  definition is about 8× headroom).

On a positive decision the body is re-lowered at the site (`jsl-specialize-body-inner!`), the site's
projections are forwarded **with the proof preserved** (§3.1), the old call is unlinked, the fresh nodes
are queued, and the inline size epoch is bumped. Calls the residual creates link per §3.2.

Nothing else about the inliner changes: a definition *without* rules still goes through the evidence gate
and the size caps.

## 6. Where to apply it

Measured: **193** builtins in `jsl/compiler/` tag-test a `dyn` parameter in their body; **3** carry
rules. Surviving shared bodies in the compiled test262 harness realm, by remaining call sites:

| body | sites | what it needs |
| --- | ---: | --- |
| `JsThrowTypeError` | 41 | nothing — error paths stay out of line (tier 4) |
| `JsGetNamed` | 20 | has rules; the proofs fail — needs object shape in the lattice (tier 3) |
| `JsOrdinaryToPrimitive` | 10 | tag rules (tier 2) |
| `JsGetFromHolder` | 9 | tier 3 |
| `JsStrictNotEqual` / `JsStrictEqual` | 8 / 7 | tag all-of rules (tier 1) |
| `JsDefineOwnNamed` | 8 | has rules; tier 3 |
| `JsSetFail` | 7 | nothing — failure path (tier 4) |
| `JsInvokeCallable` | 7 | has a rule; the callee is not proven a function — narrowing work |
| `JsTruthy` | 6 | one rule per tag (tier 1) |
| `JsBinaryOnPrimitives` | 5 | tag rules (tier 2) |

### Tier 1 — arithmetic and predicates, with proofs we already have

`JsAddOperator`, `JsSubOperator`, `JsMulOperator`, `JsDivOperator` and the four relational operators:

```
:specialize [[(%IntPayload a) (%IntPayload b)]
             [(%IsNumber a) (%IsNumber b)]
             [(%IsString a) (%IsString b)]]     ; the string rule for `+` and the relations only
```

`JsStrictEqual` / `JsStrictNotEqual` (15 harness sites), `JsTruthy` (6), `JsNegateOperator`,
`JsPositiveOperator`, and the update operators. Once these land: revert the operator-body restructuring
in `jsl/compiler/toprimitive.jsl` toward its original two-arm form, delete the six `:noinline` marks in
`jsl/compiler/int-arith.jsl`, and lower the budget ceiling from 7,000/1,400 back toward the measured
truth. Success is `fib(30)` at or under 5.2 ms **and** the harness realm at or under 4,083 nodes.

### Tier 2 — conversions, also with proofs we have

`JsPrimitiveNumber` (61 inline queries on the harness), `JsToString`, `JsToStringValue`,
`JsToNumberValue`, `JsToPropertyKey`, `JsOrdinaryToPrimitive`, `JsBinaryOnPrimitives`,
`JsExoticToPrimitive`. All are tag dispatches on one or two `dyn` parameters; all are reachable from
every operator and every property access, so tier 2 is what makes tier 1's residuals shrink further.

### Tier 3 — gated on lattice work, not on rules

`JsGetNamed` already has rules and still leaves 20 generic sites on the harness: the proofs
(`%OwnDataProperty`) need an object's **shape** to be visible through a parameter, a Phi or a call
result, and today `dyn{object}` cannot say which layout. Likewise the 25 tag-dispatching builtins in
`jsl/compiler/array.jsl` need an **element type and length** on arrays, and `jsl/compiler/string-methods.jsl`
(12) needs a string's length. These are lattice gaps (`TShape` and `TStr` exist in the type sum with
`unimplemented` constructors; there is no counterpart to Simple's `TypeConAry` or to `Field._t`). Writing
rules for them before the lattice can prove anything would add declarations that never fire.

### Tier 4 — deliberately out of line

`JsThrowTypeError` (41 sites), `JsSetFail`, `JsSymbolToStringRefused`, `JsThrowRangeError` and the other
refusal paths. They keep `:noinline`. Engines do the same. Note that the *generic inliner* currently
inlines cold paths anyway — `JsSymbolToStringRefused` six times into the harness — which is the separate
evidence-gate fix below.

## 7. What this does not fix

Three findings from the same audit are orthogonal and want their own work:

- **The evidence gate asks the wrong question.** For a definition with no rules, evidence is "some
  argument is sharper than the callee's Parm", which — because a Parm is the meet over callers — reduces
  to "the callers disagree". Cold paths get inlined for no fold. Fixing it is independent of this design
  and complementary: rules for the hot dispatches, a fold requirement for everything else.
- **Nothing inlines in `PHASE-ITER`.** 276 inline queries, 0 fired, 203 deferred on the harness: every
  Fun still carries its unknown-caller hook and our guard defers where Simple clone-inlines.
- **The lattice payloads.** `dyn{double}` and `dyn{bool}` cannot say which double or which boolean, so a
  parameter loses a constant that an integer parameter now keeps. Measured: a dead branch survives for a
  `double` or `bool` parameter and folds for an `int` one.

## 8. Tests

Each item lands with its test, in this order:

1. **Invariants (§3).** `tests/jsl-test.coil`: a specialized site whose consumer holds a narrower type
   keeps that type (the Cast is interposed); a residual body whose new call would widen a callee Parm
   does not link in the pessimistic pass. Both as graph-shape assertions, plus `fib-steady` and the
   `measure`-shaped program as compile-and-run cases in `tests/execution-test.coil`.
2. **Rule language (§4).** Reader and checker tests: all-of parsing, an unknown parameter refused, a rule
   naming an untested parameter refused, `%IsNumber` and `%IntPayload` admitted, `:specialize` and
   `:inline-when` unchanged for the existing three definitions.
3. **Per-tier behaviour.** For each tier-1 definition: a site with the proof has no call in the final
   graph; a site without it has exactly one. This is the assertion that would have caught
   `JsLtOperator` never inlining.
4. **Budgets.** `tests/budget-test.coil` ceilings move *down* in the same commit that lands tier 1, with
   the measured numbers in the comment.
5. **Semantics.** Extend the numeric edge-case script from `9c221b1` with equality and truthiness cases;
   the JSL arms are unchanged, so any diff against Node is a specialization bug, which makes this the
   sharpest test in the set.

## 9. How every number here was produced

```sh
# the harness realm the budget test compiles, extracted to a file
sed -n 17,52p tests/budget-test.coil | …            # see §2 table
build/release/aot dump harness.js opto --script | grep -cE '^#[0-9]+ '
# surviving shared bodies and their call sites
build/release/aot dump harness.js opto --script | grep -oE '^#[0-9]+ Js[A-Za-z0-9_.]* :CTRL <- _.*' | awk '{print NF-3, $2}' | sort -rn
# inline decisions, per callee, with sizes and caller counts
AOT_INLINE_TRACE=1 build/release/aot dump harness.js opto --script
# steady-state benchmark, after in-process warm-up (CLAUDE.md: Node must warm up too)
build/release/aot run-script benchmarks/fib-steady.js /tmp/f.o /tmp/f && /tmp/f
```

## 10. As landed — tier 1 (2026-09-17)

§3.1, §3.2, the conjunction rule and tier 1's operators landed together; `docs/DECISIONS.md` has the
decision. Four things differ from the plan above, all found by measuring:

- **Rules must not make a definition specialize-only.** §5 read as though a proof were the only way in.
  It is not: an unproven site must fall through to the ordinary inliner, because a recursive site's
  operands are polluted by the shared body's other callers and no proof exists until a clone breaks the
  cycle. `fib(n-1) + fib(n-2)` is that shape; gating it on proof alone cost 5.2 → 6.5 ms. Specialization
  and speculative cloning are complements.
- **`%IntPayload` was not needed.** A proof only grants permission; the arms fold from the argument
  types during re-lowering, so `[(%IsInt a) (%IsInt b)]` is enough. Payload proofs remain available for
  a case that wants them.
- **The per-definition specialization cap was not implemented.** Compile time on the harness realm did
  not move (0.63 s), so there was nothing to bound yet; it stays in this document as the guard to add
  the moment a tier-2 or tier-3 rule makes a definition specialize at many sites.
- **The string rule is blocked by a loop-tree bug.** `[(%IsString a) (%IsString b)]` on `+` panics
  `looptree-walk!: postvisited child has no loop tree` (a CProj) during GCM, on a program that needs a
  ternary-recursive `fib`, an escaping function array and string concatenation of both results. Tier 1
  landed with the two numeric rules only; the repro is in the project pad and at
  `/tmp/specialize-string-rule-repro.js`.
- **`jsl-finish-opto!` released a Return that specialization had collected.** A definition specialized
  at every one of its sites loses its last caller and is collected during Opto, so the hold
  `jsl-prepare-opto!` installed is gone with it and releasing it again broke the keep invariant. It now
  skips a Return that is already dead.
- **The residual's edges are peepholed after the forwarding walk**, not at construction: the folds that
  matter (a Region with one live input) depend on the users the walk installs, and peepholing while the
  walk still holds those edges can subsume a node it is keeping.
- **"Evidence must fold" is not a one-line rule.** Requiring the callee to tag-test the parameter was
  tried and rejected: it left cold-path inlining unchanged (7 vs 6 on the harness) and broke real folds
  (`*` stopped folding, three parse tests). §7 stands as unfinished work, not as a quick fix.

Measured after: harness realm 6,631 → 6,248 machine nodes, 1,315 → 1,235 blocks, budget ceilings back
to 6,500/1,300; the six `:noinline` marks removed; `fib(30)` 5.16 ms. The operator bodies kept their
int/binary64 arms: a proven site then folds in one hop, where moving the arms back into `JsAdd`/`JsSub`
would leave a second call to fold.

## 11. Order of work

1. §3.1 and §3.2 with their tests. No behaviour change otherwise; this is the unlock.
2. §4 rule language, with checker refusals.
3. Tier 1 rules; revert the operator restructuring; delete the six `:noinline`; lower the budgets;
   re-measure fib, binary trees and the harness.
4. The evidence-must-fold fix in the ordinary inliner (§7), re-measuring cold-path inline counts.
5. Tier 2 rules.
6. Lattice payloads (`bool`, `double`, then string length/contents) and structure (object shape, array
   element type), which unlocks tier 3 — the largest remaining win for real programs, and the reason
   `JsGetNamed` still has 20 generic sites.
