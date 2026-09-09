# Decisions

## 2026-09-09 — Generic array methods and the `in` operator

The callback and search methods of `Array.prototype` — forEach, map, filter, some, every, find,
findIndex, reduce, indexOf, includes — threw "called on a non-array" for every receiver that was
not an array; test262 applies them to array-likes throughout (50 cases of the 1-in-20 campaign),
and the `in` operator was a refusal.

**Decision.** Each method has two arms. The array receiver keeps the element-store fast path
(`%ArrayLoad`/`%ArrayHasIndex` over the raw payload). Any other receiver takes the specification's
own generic algorithm, in `jsl/compiler/array-generic.jsl`: LengthOfArrayLike over the receiver's
`length` (ToLength: NaN reads as zero, the value clamps to 2^53 − 1), HasProperty per index
(`JsArrayLikeHas`: an array's element or its chain, a string's code unit, an object's own key or
its chain, nothing on another primitive), and [[Get]] through the ordinary keyed access — so a
plain object with `length` and indexed keys, a string, or an `arguments`-shaped object all serve,
and `null`/`undefined` are the ToObject TypeError. `in` is `JsIn`: a TypeError for a non-object
right operand, then HasProperty of ToPropertyKey(left), the array index reaching the elements. It
is a throwing completion in the parser and the may-throw filter, as `instanceof` is. The generic
arms live in their own unit so the stable function indices of the earlier units stay put
(tests/jsl-test).

The mutating methods (push, pop, shift, unshift, reverse, slice, concat, join, at) still require
an array; their generic forms wait on [[Set]] and [[Delete]] over array-likes (docs/GAPS.md).

## 2026-09-09 — Math and the number globals are image data over a libm-backed runtime table

`Math` is an ordinary object (§21.3) with function-valued properties and eight binary64
constants; `isNaN`, `isFinite`, `parseInt` and `parseFloat` are plain global functions (§19.2).
The 1-in-20 campaign refused 28 cases by the name `Math` and 16 by the names of the four
functions.

**Decision.** The intrinsic table gains a *namespace* kind (`intrinsic-namespace`): an object of
the realm image on %Object.prototype%, bound as a global, carrying the methods the table lists for
it under `INTRINSIC-TARGET-NAMESPACE` — each a hoisted JSL builtin compiled into the program when
the program names it as a member, exactly as a prototype method is. Its value properties are
image words (`realm-image-math-constants!`), so `Math.PI` folds to a constant under the
closed-world facts, and `image-word-node` now knows a binary64 word (any prefix outside the tag
range, the canonical NaN included). The four functions are constructor-shaped intrinsics whose
bodies throw a TypeError when constructed.

The functions themselves are one runtime table, not one primitive each: `%MathUnary op x` and
`%MathBinary op x y` (`JS-MATH-UNARY`, `JS-MATH-BINARY`) take an operation code and Number
words and return a Number word; `aot.rt.number` maps the code to the libm function through Coil
`extern` declarations (`sqrt`, `sin`, …, `hypot`), and writes out the cases where the
specification departs from C: `Math.round` rounds ties toward +∞ and keeps -0 for −0.5 ≤ x < 0
(C `round` rounds away from zero); `Number::exponentiate` makes any NaN exponent NaN and ±1 to ±∞
NaN (C `pow` gives 1). `Math.random` draws 53 bits from `arc4random`. `abs`, `sign`, `max` and
`min` are JSL arithmetic, with the +0/-0 order told apart by a division. `parseInt` and
`parseFloat` are their own grammars in `aot.rt.number` over code units (`%ParseInt`, `%ParseFloat`):
the longest digit run below the radix and the longest StrDecimalLiteral prefix, with the radix-10
value handed to `strtod` for correct rounding. The per-function primitive ids the table had
reserved (`JS-SQRT` … `JS-ROUND`) are gone: a primitive is a machine or runtime *capability*, and
the capability here is "call the libm table".

**What the four ABI slots cost.** `Math.max`, `Math.min` and `Math.hypot` see at most four
arguments, and an argument that arrived as `undefined` is indistinguishable from an absent one,
so `Math.max(1, undefined)` is 1 where the specification says NaN (docs/GAPS.md, standard
globals). Every builtin function in the image, these included, carries a `prototype` object it
should not have (§10.2.4 gives none to built-in functions); the layout treats every hoisted
function alike.

## 2026-09-09 — Image object property reads fold under closed-world facts

The realm's initial objects are image data (the realm image, below), so their properties are
constants of the compilation until the program stores into them. Every named read on a receiver
that may be a primitive had grown a lookup arm on %String.prototype%, %Number.prototype% and
%Boolean.prototype% — each a runtime shape-tree dispatch — and the budget harness went from 4,811
to 7,349 machine nodes (docs/COMPILE-TIME.md §8 rows 9–10) for reads whose answer the image
already held.

**Decision.** Once the world is closed — every source function lowered and every JSL definition
they demand built — one pass over every graph (`aot.node.imagefacts`) establishes, per image
object X and key K, whether the program can have stored K on X, and records it in `aot.facts`. A
value's abstract state is the set of image entries it may denote plus TOP; stores name their
owners through that state; a value that reaches a position the transfer does not follow (a stored
value, an array element, a runtime primitive's operand, the entry wrapper's return) escapes, and an
escaped object counts every key some unnamed-owner store writes as written. The call graph is
closed and finite, so values flow through it rather than escaping at it: a Parm is the union of
its callers' arguments, a Call the pessimistic pass has not linked yet is simulated over the finite
set its pointer type names (the edges SCCP adds in Opto), and a call's value is the union of its
targets' Returns. The pass is monotone over a finite abstraction and runs to a fixpoint.

With the facts in, a `PropAccess` whose owner is a `StaticRef` folds in its idealize: a key in the
image shape that the program never stores is its image word (a method is its function object; a
global function declaration is its object); a key in the shape that may be stored is one load at
the key's fixed offset through the properties word (every transition keeps the offsets it
inherits, so the offset the image fixes holds at run time), and a store of such a key is the
matching fixed-offset store; a key absent from the shape that nothing can store is `undefined`
(and `HasOwnProperty` is false); an absent key that may be stored keeps the generic dispatch. A
[[Prototype]] Load from a `StaticRef` folds to the image word while no store writes a prototype
word after allocation (`Object.create` initializes a fresh object; nothing today writes an
existing one). The global object is an image object like any other, so a Script's global variable
reads and writes are these accesses (`lower-global-load`, `lower-global-store!`), and the earlier
fixed-shape path with its trapping arms (`property-shaped-named`) is gone: a property another alias
of the global object adds at run time (`globalThis.k = v`, a function's sloppy `this`) transitions
the shape without disturbing any access, where before it made every global read trap.

**Why this is sound under optimization.** Inlining replaces a Parm with the argument the analysis
already flowed into it, and replaces a call's result with the Return value the analysis already
flowed out of it; folds replace nodes with constants the analysis accounted for. What would
invalidate the facts is a graph the pass never saw, so `jsl-build-graph!` refuses to build a JSL
definition after the facts are computed, and a query about an image entry added after them
panics. `delete` and `Object.defineProperty` are refusals today; when they land they are stores in
this pass's sense and must mark what they touch.

**Effect.** The budget harness (docs/COMPILE-TIME.md §7): 7,349 → 3,015 machine nodes, 1,611 →
517 blocks, 138 → about 105 ms. `Test262Error`, `assert` and the intrinsic constructors are
constants at every use; `x` after `var x = 1` is one load; `(255).toString(16)` is a direct call of
the image method. With it, `prop-owner-store` applies Simple's Load-after-Store bypass to the
properties word: the walk to an owner's governing Store steps over Stores into provably distinct
allocations, over other slices' Stores on an initialization chain, and from a fresh allocation's
private memory to the public memory its New consumed — so a function expression's own `prototype`
definition, which follows its prototype object's initialization, resolves statically instead of
taking the runtime shape-tree store (six sites in the harness; 2,957 → 3,015 nodes, the static
transition being larger than the call it replaces and free of the runtime lookup). An access the
optimistic pass has not reached (dead control, memory at TOP) is not folded: nodes built for it
would carry memory types below the TOP its projections hold, which SCCP reports as a monotonicity
violation (three cases of the 1-in-20 campaign).

**Found on the way.** Three latent backend faults that the new graph shapes exposed, each fixed at
its cause. The runtime's frame walk panicked as "cyclic" when the call depth exceeded the number of
stack-map records — a heuristic, not an invariant; a 500-deep JSL array copy tripped it once the
folds removed enough call sites. The walk now checks the real invariant, that each frame's parent
stack pointer is strictly above it. The AArch64 indirect-call encoder took its target from the
node's last input, but GCM appends anti-dependence edges as further inputs; the target is the last
operand the selector masked. And the allocator treated every input with a live range as a register
use, so a Load kept alive only by the Store it must precede stretched across every call between
them with no use the splitter could split before, and never coloured; an input without a register
mask is an ordering edge, not a use (Simple's BuildLRG: "use_mask is also null for anti-dep").

## 2026-09-09 — Function objects sit on %Function.prototype%; fresh objects on %Object.prototype%

Every function object — a hoisted declaration's image object, an intrinsic, a function expression
made at run time — has %Function.prototype% as its [[Prototype]] once the realm materializes
`Function` (the program names it, or names `call` or `apply`), and every fresh ordinary object — a
literal, a function's `prototype` object, `Object.create(null)` aside — has %Object.prototype% once
the realm materializes `Object`. Until then those words are null, as before: the chain is what the
program can observe, and a program that names no method of either prototype observes nothing.
`Function.prototype.call` and `apply` are JSL over `%CallFunction`; the `Function` constructor
itself is a hard refusal (`%TrapDynamicCode`): it compiles source text at run time, and this
compiler is ahead-of-time by design.

The intrinsic prototypes are named uniformly: `(%IntrinsicPrototype "Name.prototype")` is the image
object of any materialized constructor's prototype, or null (it replaces the per-name
`%ArrayPrototype`/`%StringPrototype`); the realm registers every materialized constructor's
prototype under that name. A number or boolean receiver resolves its properties on
%Number.prototype% or %Boolean.prototype% the same way a string does on %String.prototype%
(docs/DECISIONS.md, strings), so `(5).toString(16)` and `true.valueOf()` work without wrapper
objects. `Object.keys` is the one new runtime capability (`%ObjectKeys`): the shape tree's edges
from the root to the object's shape name its own keys in insertion order, and the runtime builds
the array of their names.

The image builder now rejects a cyclic prototype chain at compile time: the first version of this
change made `Object.prototype` its own prototype, and every program that walked a chain overflowed
its stack. A structural invariant of the image is checked where the image is built.

## 2026-09-09 — Strings have no wrapper objects; their properties resolve on %String.prototype%

A property read on a primitive string is `length` for that key and otherwise a lookup on
%String.prototype% (`JsGetNamed`'s string arm through `%StringPrototype`), and `s[i]` is the
code unit at an array index (`JsStringIndexGet`). This is GetV without the wrapper: ToObject
would make a String object whose [[Prototype]] is that very object, and the only difference a
program could observe — identity of the wrapper — has no consumer here until wrapper objects
exist (docs/GAPS.md, strings). The methods on the prototype (`jsl/compiler/string-methods.jsl`)
receive the primitive as `this` and throw a TypeError for any other receiver.

The prototype is an image object like Array's, registered as the well-known intrinsic
`String.prototype` when `String` is materialized, and `String` is materialized when the program
names it or names one of its methods as a member — the closed-world property names decide, as for
the other intrinsics. A computed key that spells a method name only at run time (`s['charAt']`)
finds nothing unless the program also names it somewhere; that is the approximation every by-name
intrinsic already makes (`this['Error']`), and materializing the prototype for every computed
access would compile the whole String library into most programs.

**Methods materialize one by one.** An intrinsic's method is a hoisted function compiled into
the program and a property of an image object, so only the methods the program names as a member
somewhere exist (`syntax-names-member?`); `toString` alone, which almost every program names,
brings one small method, not the library. This is the same closed-world rule that decides which
intrinsics exist, with the same approximation: a method reached only through a computed key the
program never spells is absent, and so is enumeration of a prototype's methods (docs/GAPS.md).
Compiling every method of a materialized owner had put the whole String library into the harness
realm (8,297 machine nodes against the 8,000 budget) because the harness names `toString`.

Two new runtime capabilities carry the methods: `%Substring` (a fresh string over a clamped
range) and `%StringFromCharCode` (a one-unit string); indexOf and friends are JSL recursion over
`%StringCharCode`. `toUpperCase`/`toLowerCase` are not written: a correct implementation needs the
Unicode case tables, and an ASCII-only one would be wrong on the first non-ASCII input.

## 2026-09-09 — A loop's parent is the innermost enclosing region any branch proposes

Simple's loop-tree walk (`_bltWalk`) attaches an inner loop to an outer tree at every branch whose
arms reach two different loop trees, writing the parent each time; the branch post-visited last
decides, and in Simple's language that is the loop's own exit test. Our lowering puts a loop's exit
decision below the JSL dispatch diamonds of its condition and below exception checks, so several
branches inside a loop pair it with different enclosing regions — the enclosing loop at the real
exit, the function root at an exception arm — and the arbitrary last one parented an inner loop to
the root, which then absorbed the outer loop's head and left the outer loop's blocks out of the
layout (`enc-layout-order-blocks!: loop tree omitted block`; the test262 campaign's
`decodeURI` tests). Every region a branch proposes contains the inner loop, so the correct parent
is the innermost of them: `looptree-attach-parent!` keeps the proposal whose head has the larger
preorder number. Recorded as a divergence in `looptree.coil`'s header.

## 2026-09-09 — `new.target` is an argument slot

Every JavaScript frame receives `new.target` as its second argument, after `this`: the shared ABI
is `[ret this new.target slot…]`. A call passes `undefined`; `new F(…)` passes `F` (lower-new);
`%CallFunction` from a JSL body passes `undefined`; the entry wrapper passes `undefined` to each
Script root. `new.target` in a source function reads that Parm (`lower-new-target`).

**Why a slot rather than the receiver.** The intrinsic constructors had told a call from a
construct by comparing `this` with the global object — true only for a sloppy-mode plain call.
In strict code a plain call's `this` is `undefined`, so `String(1)`, `Error('x')` and every other
intrinsic called as a function in strict code took the construct path (a wrapper object, or an
own property defined on `undefined`); `f.call(obj)` would have taken it too. The specification
distinguishes the two by NewTarget, and engines pass it in a register (V8's `new.target` register;
SpiderMonkey's `newTarget` argument). Passing it is one more word per call; the intrinsic
constructors' bodies are `(this new.target callee args…)` and `JsCalledAsFunction` is
`(%IsUndefined newtarget)`. The slot also makes `new.target` in source functions the language
feature it is, instead of a refusal (arrows still wait for closures, as `this` does).

## 2026-09-09 — JSL calls JavaScript through `%CallFunction`

A JSL body may call a JavaScript function value: `(%CallFunction callee this arg...)`, up to four
arguments. The checker requires the callee proven a function (a `%IsFunction` test narrows it), the
operands to be values, and types the result as a completion — the callee's value or the exception
sentinel — so the definition is `:throws` and tests the result with `%IsException` before using it;
the form is transitioning. It lowers to exactly the frontend's value call (`lower-value-call-with-
receiver`): the code word loaded from the function object is the Call's target, the Call carries
`this` and the program's argument slots (missing ones `undefined`; an argument past the slot count
is unobservable without `arguments` and is not passed), and the CallEnd's projections continue the
body. The frontend settles the value-call ABI — the slot count and the function-pointer set every
code word may hold — before any body is lowered (`jsl-set-value-call-abi!`, then
`jsl-define-pending!`), which is another reason bodies are lowered after the program.

This is what `Array.prototype.forEach/map/filter/some/every/find/findIndex/reduce` are built
from, in JSL, with the specification's order of HasProperty, Get and Call per index. It is a
primitive because a call into JavaScript is a machine capability the graph cannot express
otherwise — the same test that admits `%StringConcat` and refuses `Array.prototype.map`.

**Two backend consequences surfaced by the first campaign over it.** First, a folded `if` can
let a `Box` of a Start-pinned constant be shared, and GCM's break-up of shared globals (Simple's
`breakUpGlobalConstantSingle`) recursively splits such a dependent and then assumes it owned; when
the dependent stays at Start (one of its users is a Start-level instruction), moving the constant
into its one function put that user outside its dominance. A dependent that remains at Start now
keeps the constant at Start — a divergence from Simple's code, recorded in `gcm.coil`. Second, the
syntactic may-throw filter compared `instanceof` by its source spelling where the syntax records
the operator by its JSL entry point, so a function whose only throw was an `instanceof` was
cleared and the soundness check fired on it; the filter now names `JsInstanceof`.

## 2026-09-09 — Arrays are exotic objects under their own tag, with an elements store and a length word

An array is a heap object under its own NaN-box prefix (`DYNAMIC-PREFIX-ARRAY`, `TAG-ARRAY` on the
dynamic tag axis; `TAG-ANY` and the completion universe grew by it), so `typeof`, `Array.isArray`,
truthiness and identity tests are one prefix test, and every operation that admits "object-like"
values (`%IsObjectLike`, `%UnboxObjectLike`) takes object, function and array as one three-prefix
range. The payload is `[prototype, properties, elements, length]`: `prototype` and `properties` are
the ordinary object words, so named properties on an array (`a.foo = 1`) and the prototype chain
walk are the object machinery unchanged; `elements` is a boxed reference to a separate store object
(`SHAPE-ELEMENTS`, scanned by the collector as a run of boxed words; capacity in its header) and
`length` is a raw word. A missing element is the **hole word** (`DYNAMIC-PREFIX-HOLE`, a prefix no
JavaScript value has, never boxed into a source value): `HasProperty` on an index is a compare
against it, and a read through a hole falls to the prototype chain with the index's canonical string
as the key, as the specification's `[[Get]]` does. The store grows by doubling from a minimum
capacity of four, in the runtime (`aot_rt_array_store`, `aot_rt_array_set_length`), which owns every
transition an index write or a `length` write can cause; `length` writes truncate to holes or
extend with holes and throw `RangeError` for a non-array-length value.

**Why a tag rather than an object with an exotic shape.** The carried library (`jsl/`) was written
against a value universe in which arrays are their own tag, and the dispatch in every operation
(`ToString`, `ToPrimitive`, property access, `typeof`) is a tag test. Giving arrays a shape bit
inside the object family would make every object operation read the header before it can decide,
and would put the elements store behind the same transition machinery as named properties; the
tag keeps the fast paths for plain objects untouched and makes an array's own fast path one test.
The price is one more prefix in the negative quiet-NaN family, which the double test now covers as
a range (`FUNCTION..HOLE`, four prefixes, one subtract-and-compare).

**Indexes.** A property key that is a canonical array index (an integral number in `[0, 2^32-2]`,
or the string spelling of one — `aot_rt_array_index_of_string`) takes the element path in
`GetKeyed`/`SetKeyed`; every other key is a named property on the array object. The syntax `a[i]`
does not know its key's kind, so the JSL dispatches at run time on the key's tag and value;
`a.length` is recognised at the site (the key is a constant) and reads the length word directly.

**Methods are intrinsics in the image.** `Array` and its methods (`push`, `pop`, `at`, `indexOf`,
`includes`, `join`, `toString`, `reverse`, `shift`, `unshift`, `slice`, `concat`, `isArray`) are
hoisted JSL functions placed on `Array.prototype` (or the constructor) as image objects by
`realm-image-build!` — the same way the Error constructors and prototypes are — when a program
names `Array` or uses an array literal (`syntax-uses-array-literal?`). `Array.prototype` chains to
`Object.prototype` when `Object` is materialized. The library's iteration is recursion over an
index (JSL has no loop form yet); a method that receives a non-array `this` throws a `TypeError`
(the generic-object forms of these methods are not written), variadic arguments are taken up to
the four-slot ABI, `Array(undefined)` builds an empty array and `push(undefined)` pushes nothing,
because the ABI cannot yet distinguish an omitted argument from `undefined` — each of these is in
docs/GAPS.md as the deviation it is.

**Compile-time cost.** Every generic dispatch grew an arm, and the whole array library was being
lowered for every compile; both are addressed by the next entry, and the harness realm compiles
with fewer nodes than before arrays existed.

## 2026-09-09 — JSL definitions are built on demand, and a constant condition lowers one arm

Loading the JSL index declares every definition (its name, its stable function index) and builds
none. A definition's Fun and Parms are built the first time something asks for its graph
(`jsl-graph-of` — the frontend installing a semantic call, or a body calling it), and its body is
lowered afterwards, in a queue drained when the program's lowering is complete
(`jsl-define-pending!`, at the end of `parse-program-sources`) and again by `jsl-close-world!`,
which then drops the unknown-caller hooks and closes the table: a demand after that is an error.
A definition nothing reached has no graph at all. Function indices are still the index's order,
reserved at declaration, so relocations and the `fidx` tests are unchanged.

**Why.** Before this every compile lowered, peepholed and swept the whole library — 2.9k parse
nodes for the harness realm before arrays, 4.8k after — and most of it was dead by the end of the
first peephole pass. The library will keep growing with every builtin; its cost must be paid by
the programs that use it. On the harness realm the parse arena fell from 7,901 to 6,335 nodes
(HEAD before arrays → now, with the array library present), 19 of 64 definitions are built, and
the pessimistic pass fell from 14 to 12 ms; the budget harness is 4,935 → 4,811 machine nodes and
1,087 → 1,060 blocks (90 → 80 ms).

**A constant condition lowers one arm.** A JSL `if` whose lowered condition is already a constant
(an integer constant or a Box of one, decided as `if-compute` decides truthiness) lowers only the
arm it selects: no If, no dead arm, no Region. This is the macro expander's constant folding, and
it is what makes site-specialised macros cheap — `JsGetNamed` compares its constant key against
`"length"`, and `JsDefineOwnNamed` likewise; only the `length` sites pay for the array arm. No
narrowing Cast is lost, because a tag test folds only when the tested value's type already implies
the answer. (Simple's parser peepholes every node at creation and so folds `if (true)` the same
way; JSL's `if` had been building both arms first for the branch-local Casts.)

**Tests keep the eager form.** `jsl-lower-unit!` builds and lowers every definition of one unit;
`jsl-graph-defined` demands one and drains the queue, for a test or tool that inspects a body.

## 2026-09-09 — A Region's dominator ignores a path whose chain ended in a dead subtree

`region-idom` is Simple's `RegionNode.idom`: the LCA over the live inputs, skipping high ones. Our
`XCtrl` has no input where Simple's hangs off Start, so when a branch's control is replaced by
XCtrl the dominator chains under it end at that XCtrl until the subtree is retyped and removed.
Simple's fold restarts the LCA at the next input when two chains fail to meet; over a Region that
merges both arms of an If plus such a stale path, that computed the dominator inside one arm, and
the dominating-test hunt (`if-idealize`) then folded the other arm's repeated test to the wrong
constant — a one-armed If reached the backend (`arm64-cfg-target: selected CFG target is missing`,
tests/pipeline-test.coil under seed 41 once the array work changed node order). `region-lca-path`
keeps the side whose chain reached Start and drops the side that ended elsewhere, in either order
(tests/control-test.coil, `a_region_dominator_ignores_a_path_whose_chain_ended_in_a_dead_subtree`).
The cache keyed on the control-edit version is unchanged; a chain that heals does so through an
edit. `AOT_SEED=N` on the CLI compiles under a test's seed, so a seed-dependent failure reproduces
from the shell.

## 2026-09-09 — Exceptions are a sentinel completion, and the type is the may-throw analysis

A function that throws returns the **exception sentinel**: a word under its own NaN-box prefix
(`DYNAMIC-PREFIX-EXCEPTION`, `TAG-EXCEPTION` on the dynamic tag axis) that no JavaScript value
ever is, with the thrown value left in the runtime's pending word. Every function's return type is
a *completion*, `dyn` widened by the exception tag (`TAG-COMPLETION`, the axis's full universe;
`TAG-ANY` remains "every JavaScript value" and is what a parameter admits). A caller tests the
result with one `TypeTest` for the tag (`lower-exception-check!`): the exceptional arm takes the
pending value to the enclosing try (the catch, or the finally as a throw completion), or completes
with the sentinel itself; the normal arm continues with the result narrowed by a Cast to a value.
The pending word's flag is gone — the sentinel is the flag — and the entry wrapper tests each
Script root's completion (and a function-entry program's `main`) before running the next, reporting
an uncaught exception through the runtime.

**Why a lattice tag rather than a magic constant.** SCCP does the may-throw analysis. A callee whose
Return type excludes the tag folds every check at its callers; a callee that may throw keeps them.
Nothing is loaded from memory, so the check sits on no memory edge and blocks no load or store
folding. And a value that may carry the tag is visibly not a JavaScript value: the parser narrows
every checked result, the type of the return Phi is declared a completion, and the JSL checker
enforces the discipline the pending word never demanded — a definition whose body may complete with
the sentinel must declare `:throws true` (inferred and refused like `:transitioning`), a `:throws`
definition's result may only be looked at by `%IsException` before use, and `(if (%IsException x)
x …)` narrows it in the else branch as every tag predicate does. `%SetPendingException` stores the
value and yields the sentinel; `JsThrowTypeError` returns it; `JsGetNamed`, `JsDefineOwnNamed`,
`JsGetKeyed`, `JsSetKeyed`, `JsInstanceof`, `JsOrdinaryCreateFromConstructor` and the Error and
Object intrinsics are `:throws`, and each use of one of their results in the library tests it.

**The syntactic filter stays as an optimization, guarded.** Building the test at every direct
call and letting SCCP fold it cost a third more optimizer time on the harness (the folds happen
late, after the callee's return type descends). The closed-world syntactic fixpoint over throwing
constructs (`syntax-compute-may-throw!`) therefore still decides which direct calls get a test
built; a call the filter clears has its result narrowed by a Cast instead. The filter is an
under-approximation only if it misses a throwing construct, and that is now a hard error: a body
whose lowering emits a propagation path while the filter cleared it panics naming the function
(`parser-note-propagation!`). The old filter had missed `instanceof` and the strict write to a
restricted global, which let a pending flag survive silently; both are in the walk now.

**Precedent.** HotSpot's Catch projection and V8's IfException give a throwing call two control
successors and unwind by tables; SpiderMonkey's VM calls return a sentinel the caller tests; Swift
tests an error register after every throwing call. This is the sentinel form of the same graph
shape; it can become table-driven unwinding later without changing the IR, because stack maps are
already keyed by return address. Supersedes "Exceptions are a pending word and ordinary control
flow" (2026-09-08) and the per-call check of "The language's TypeErrors are TypeError objects";
`finally`'s completion record and the Scope-merging jump to a catch target stand.

## 2026-09-08 — The realm's initial heap is data: the static heap image

A realm begins with objects no statement made: the global object with one property per var-like
global, a function object and its `prototype` object per hoisted declaration, the intrinsics the
program names with the properties CreateIntrinsics gives their prototypes, and every string
literal. Until now the compiler lowered their creation as code — a `New` and its Stores per object,
the JSL property-definition path per property, the intrinsic setup as a JSL builtin call — and then
optimized, scheduled and allocated that code on every compile, although its result was the same
bytes every time: about 600 nodes in the smallest realm and about 100 per function declaration
(docs/COMPILE-TIME.md §10).

**Decision.** Objects that are allocated exactly once per program run, before the first statement,
with initial contents that are constants or other such objects, are laid out by the compiler as
data. `aot.heap` is that layout: a table of entries in the runtime's own object format (three
header words, then the payload), emitted as the `__aot_heap` / `.aot_heap` section, each entry a
local symbol. `StaticRef` (aot.node.dynamic) is the address of an entry as a raw pointer of its
representation — the generalization of `StrConst`, which it replaces; a string literal is an
image entry of shape `SHAPE-STRING`. The parser lays the realm out in `realm-image-build!` after
the header pass: the global object's properties in table order (its hidden class is checked to be
the table's), every hoisted function's object and prototype (MakeConstructor), the intrinsics into
their slots, an Error prototype's `name`, `message` and chain (ECMA-262 §20.5.3, §20.5.6.3), then
the first Script's function declarations in order. A later Script's function step remains a store
at that Script's start, because the first Script runs before it and must see `undefined`.

**Why this is not a semantic shortcut.** Nothing a program can observe distinguishes an object the
entry code allocated and initialized from the same object in a data section: identity, mutability,
shape and prototype chain are the same, and every later access — the shaped global paths, the
generic runtime property operations, `new`, `instanceof` — runs the same code over the same words.
Property definition on an image object is `shape-transition` on the compiler's own table, so a
fast path proved against a shape id and a runtime lookup over the shape blob name the same word of
an image object as of a heap one. The intrinsic setup moved from a JSL builtin to the layout
because CreateIntrinsics is a table of initial state in the specification, not a computation; it
is the table the layout consumes, and `jsl/intrinsics.jsl` is where that table will come from when
its reader lands.

**The runtime contract.** The image is a permanent, immovable root region. The process entry boots
the heap before any generated code runs; `rt-statics-adopt!` validates the header, adds the
section's load address to every reference word the header lists (a NaN-boxed reference carries a
tag in its high half, which linkers do not relocate; a function object's raw code word is a plain
pointer and is relocated by the linker, `ARM64_RELOC_UNSIGNED` / `R_AARCH64_ABS64`), and publishes
the global object root from the header. Every collection, minor or major, forwards every reference
word of every scanned entry (`rt-scan-static-roots!`); the post-write barrier records value kinds
stored into image objects as it does for heap objects but dirties no card, since the whole image is
rescanned; `rt-forward` leaves an image payload where it is; `AOT_RT_GC_VERIFY` checks the image's
words. This is what V8 does with its startup snapshot (built once, deserialized and relocated at
boot) and what JavaScriptCore does with statically laid out intrinsics; Simple has no heap to
initialize, and its analogue is that a constant is a constant, never code that computes it.

**Consequences.** The global object is a constant address in every function, so `%GlobalObject`
and the shaped global accesses no longer load the runtime root (a function-entry program without a
realm still does, and reads zero). `lower-create-global-object!`, `lower-intrinsic-instantiation!`
and the JSL `JsSetupErrorPrototype` are gone; `code-string-table-bytes` and the `__aot_strings`
section are gone, subsumed by the image. A selected Fun takes its closed-world index from the
registry (`arena-function-fidx`), which the image fills as a FunPtr would; a code word of a function
the optimizer proved unreachable relocates against the runtime's invariant trap, the FunPtr rule.
Supersedes the string-literal half of the entry below.

**Found on the way: a memo that could lie.** `fun-self-recursive?` cached its answer per inlining
epoch. Value calls are linked lazily (`opto-link-cg!`), so a callee could gain a body-local self
call after a cached "not recursive" and still be cloned and folded: the clone kept the self call as
its input 1, the trivial fold bypassed *that* edge instead of the entering call, and the Fun was
left with a control node as a caller and a leaf frame whose safepoint had no saved return PC. The
same program compiled or crashed depending on the worklist seed (the previous commit failed seed 2).
Rule, from Simple: a decision that can flip in either direction is recomputed at every candidate
check; only a quantity whose staleness is safe in one direction (a body size, stale upward) may be
memoized. The trivial fold now also refuses, by name, a callee whose only caller is not the folding
call.

## 2026-09-08 — The compile-time architecture: frames, exceptions, inlining evidence, and budgets

Compiling the test262 harness realm (212 lines) produced 11,200 machine nodes, 3,246 blocks, eight
allocation rounds and 1.3 s, after a session of pass-level fixes. docs/COMPILE-TIME.md holds the
measurements, the precedent survey and the road; the four decisions are recorded here as law. Each
supersedes an earlier entry where noted; until its milestone lands, the code it describes is a
known divergence listed in docs/GAPS.md, not a silent one.

1. **JavaScript frames preserve no registers.** Every Call, New, JSOP and Safepoint kills every
   allocatable register for every live-range kind; a value live across one reaches a stack slot
   through Simple's ordinary empty-mask splitting, and stack maps record slots only. CalleeSave
   nodes exist in the process-entry wrapper alone. This is the HotSpot, V8, SpiderMonkey, Go and
   OCaml model; Simple keeps AAPCS callee-saves only because it has no collector. Supersedes
   "Managed-root split boundaries apply only to ranges a safepoint restricted" (2026-09-07),
   "Boxed non-references get spill homes but are not roots" (2026-09-02, the kind distinction
   survives only for what the map records) and "Moving-root stack boundaries extend the allocator
   convergence budget" (2026-09-02): the budget returns to Simple's seven rounds.
2. **A throwing call has an exceptional control projection.** The callee stores the thrown value
   in the pending word and returns the exception sentinel, a reserved boxed word; the caller tests
   the returned word's tag and takes the exceptional arm; a function without a handler returns the
   sentinel. No load per call site. The graph shape is HotSpot's Catch projection and V8's
   IfException; the mechanism is SpiderMonkey's VM-call sentinel and can become table unwinding
   without changing the graph. Landed 2026-09-09 as "Exceptions are a sentinel completion": the
   sentinel is a lattice tag, so SCCP is the may-throw analysis.
3. **A JSL definition inlines only on evidence.** The candidate inlines when some argument type
   is strictly sharper than its formal or the body is tiny; otherwise it defers with dependencies
   on its arguments and, if nothing sharpens, stays a call to the shared out-of-line builtin the
   runtime object carries. Source functions keep Simple's size rule. JSL is Torque-shaped and
   Torque builtins are out of line; the engines inline only what feedback selects, and our
   feedback is the SCCP type. Refines the inlining paragraph of docs/FRONTEND.md: Simple's rule
   is complete for a language with no generic operations, and JSL bodies are generic by
   construction.
4. **Budgets are gates.** Machine nodes per source token, blocks per statement, Cast machine
   nodes, CalleeSave count and allocation rounds are asserted by tests on the harness realm and
   the fixture corpus; wall time has a coarse ceiling. Deterministic metrics gate and noisy ones
   alert, as V8, LLVM and Rust track compile time.

Three backend items are recorded with them because they are Simple's algorithm done Simple's way,
not policy: a Cast is Simple's zero-byte `GuardMach` for scheduling and is erased once the block
order is fixed (its two-address form multiplied splits in our guard-dense graphs), a split copy is inserted into
its block's order rather than re-running the list scheduler over the program after every round,
and the stack-map liveness is one word-level gen/kill fixpoint.

## 2026-09-08 — String literals are static data, and the compiler's own hot paths are measured, not guessed

A string literal was a `New` plus one `Store` per two code units, made at every evaluation of the
literal: on the test262 harness realm that was 2,142 Store nodes, a fifth of the graph, and the
allocator, scheduler and stack maps all paid for them. A literal's units never change, so it is a
constant address: `StrConst` (aot.node.dynamic) is a node with no inputs and no memory effect,
GVN'd by content, typed as the raw string payload pointer, selected exactly like `FunPtr` (ADRP and
ADD against a local symbol) and laid out by `code-string-table-bytes` in a `__aot_strings` /
`.aot_strings` data section with the runtime's three header words (payload bytes, metadata 0,
`SHAPE-STRING`) before each payload. The runtime accepts such a payload as a valid reference that
is never moved or scanned (`rt-static-string?`); `Load` folds a literal's length to its unit count.
Simple's analogue is a constant, not an allocation, and that is what this is.

Three defects were found and fixed by measuring where compile time went (`AOT_TIME=1`, which now
also reports startup and the export phase, and a symbolized build sampled with `sample`):

- The object writer resolved every relocation by scanning all definitions, all string names (each
  freshly spelled) and all earlier fixups; export was quadratic in the relocation count and cost
  more than the whole optimizer. `obj-symbols-build!` now resolves every fixup once through hash
  lookups, in the fixed symbol order (definitions, string literals, then undefined targets in first
  appearance order), and both writers read the answers.
- A Region's immediate dominator was recomputed on every request, and every request from
  IfNode's dominating-test hunt asked for every Region on the chain, each of which re-walked its
  inputs' chains: quadratic in chain depth, most of opto's time. Simple recomputes it too, but
  Simple's chains are short. A Region now caches its idom under `cfg-edit-version`, bumped by every
  edge edit or kill of a control node through a hook the control module installs at boot; data-node
  edits leave it alone. The depth cache's own version is bumped where Simple bumps it, at inlining
  (both paths) and once per phase boundary, no longer at every control constructor and path edit,
  which had emptied it many times per peephole round: depths are lazily computed and stay
  consistent along every chain through ordinary construction and folding.
- The register class masks and the split mask were rebuilt as fresh bitsets on every allocator
  query. Masks are immutable, so each is now one shared instance.

Two bugs surfaced with the new allocation shape. The dependency pair-set was not cleared by
`arena-reset!`, so a second compile in one process silently skipped dependencies and tripped
monotonicity; every arena-owned table is reset there now. And the double `TypeTest` encoding wrote
its result register mid-sequence and then re-read its source: when a dying input shared the result
register, a function value classified as a double. Rule, recorded in the encoder: a multi-
instruction form reads its source registers before it writes its destination, always, because the
allocator may legally give a dying input and the result the same register. The encode test pins the
shared-register case.

## 2026-09-08 — Campaigns are sharded and sampled; `this.x` at Script level is a global

The test262 runner forks `AOT_T262_JOBS` workers over the file list (round-robin by eligible file
index, so shards are deterministic and artifacts `case-<file>-<variant>` never collide) and merges
their shard files; `AOT_T262_SAMPLE=N` takes every N-th file for a quick campaign. Nine minutes for
a twentieth of the suite on eight workers is the feedback loop; a full campaign is for records. A
compile deadline is per case (`AOT_T262_COMPILE_SECONDS`, 30 s): a timeout verdict means the
compiler is slow on that input, and that is a compiler bug to profile, not a runner setting.

`this.name = v` in a Script's own statements creates a property of the global object, which in this
realm is the binding `name`: the collector declares it with the Script's vars, so the global
object's fixed shape carries it. Before, the store transitioned the global object at run time and
every fixed-shape read of a global then hit the invariant trap.

## 2026-09-08 — Compile time is measured, and the inline decision is memoized

Compiling one harness-backed test262 case took 5.65 s while a trivial script took 0.06 s, and a
campaign of 90,000 cases at that rate is days: what looked like a hung campaign was a compiler
that is superlinear in program size. `AOT_TIME=1` now prints every phase's wall time and the
arena size at its end, from `code-enter-phase!`, so a slow compile names its phase before anyone
guesses. The first two answers: the inline candidate check asked `fun-self-recursive?` per
candidate per round, and that walked control ownership over the whole arena with a fresh
arena-sized map each time; the body-size walk was asked the same way. Both are memoized per Fun
per inlining epoch (an epoch is one inline that fired; a stale answer can only delay an inline to
the next epoch, never admit one wrongly), and every arena-sized mark map in the inliner and the
body copier is process-wide scratch grown once and cleared through the ids it set. The harness
case is 3.45 s now; register allocation (eleven full interference-graph rounds), mask allocation
churn, dependency dedup scans and the stack-map liveness fixpoint share the rest and are the next
targets. Campaigns must not be run against an edited tree, and their per-case time is the number to
watch, not their completion.

## 2026-09-08 — `finally` is a completion record and a jump

Simple has no exceptions; a `finally` block here is ordinary structured control flow. A try with a
finally defines two synthetic Scope variables, the completion's kind (normal, return, throw) and
its value, and pushes a JUMP-FINALLY target. A `return` inside the try records kind and value and
takes the Scope-merging jump a `break` takes; a throw the statement does not catch (no handler, or
a throw inside the handler) arrives at a catch-like target that continues into the block as a
throw completion; the normal path arrives with kind 0. The block runs once over that merge, then
two Scope diamonds resume the completion: kind 1 returns the value (into an outer finally first if
there is one), kind 2 throws it (to the nearest catch, or pending and out). A return inside the
block itself simply records a return first, so it replaces the pending completion as JavaScript
says. A break or continue that would cross a finally refuses for now. Unlabeled break and continue
never match a catch or finally target; they matched any non-block target before, which would have
sent a `break` inside a `try` inside a loop to the catch clause. A jump that carries a value binds
the synthetic exception variable AFTER unwinding to the target's Scope depth: a nested try's own
level holds another binding of that name, and binding first filled the wrong one (a throw from an
inner finally reached the outer catch as `undefined`).

## 2026-09-08 — The language's TypeErrors are TypeError objects

*The pending check described here became the sentinel test of "Exceptions are a sentinel completion" (2026-09-09); the TypeError objects and their sites stand.*

A JSL builtin throws by `%SetPendingException`: the pending word of the runtime heap record takes
the value and the flag, exactly as a source `throw` outside a `try` does, and the builtin yields a
stand-in value on the (dead) fall-through. `JsThrowTypeError` builds the object on
%TypeError.prototype% — every realm materializes `TypeError` — with its message. Who unwinds: the
enclosing source function's next pending check. The parser places one after a property read,
write or call whose base may be undefined or null (the base's dynamic type decides; a base the
compiler can type costs nothing), after every value call (the non-callable arm now throws the
object instead of trapping, and the check follows the merge so both arms share it), and after a
strict write to a non-writable global. The may-throw analysis counts member accesses as throw
sites, so callers check after calling such a function. A TypeError raised inside an operator
(`ToString(Symbol)`, `Symbol - 1`) is delivered at the next check rather than immediately: the
operator itself is not followed by one (docs/GAPS.md).

## 2026-09-08 — Strict code runs

The baseline campaign refused 22,921 files at "strict-mode runtime semantics" — every strict
variant test262 runs. What strict mode changes at run time is small and already here: a strict
function's `this` is its receiver unmapped (`lower-this`), a Script's top-level `this` is the
global object either way, and an assignment to an undeclared name is a refusal in both modes. The
one sloppy-only silence — a write to `undefined`, `NaN` or `Infinity` is ignored — becomes the
TypeError the strict code requires (the runtime's TypeError trap until exception objects exist).
Early errors, `arguments`, `eval` and `with` are unchanged: parse-time or refused by name.

## 2026-09-08 — Standard globals are intrinsics: hoisted functions over JSL bodies

A standard global (`Object`, `String`, `Number`, `Boolean`, `Error` and the NativeErrors) is a
hoisted function record whose body is one syntax node, `SxIntrinsic`, naming a JSL builtin and
its operands: the receiver, the constructor's own function object, then the arguments (the table
is `intrinsic-table` in the parser). Everything else is what every source function already gets:
a Fun over the shared ABI, a function object with a `prototype` object, direct and value calls,
inlining, `new`, `instanceof`, `p.constructor`. The realm materializes only the intrinsics a
program names (plus their parents — a NativeError needs `Error.prototype`): the world is closed,
so the rest do not exist in it, and a Script's own declaration of the name shadows the intrinsic
exactly as any later declaration shadows an earlier one. Instantiation stores their function
objects into the global object before the first Script's own declarations and runs each entry's
setup builtin (`Error.prototype.name`/`message`, the chain to the parent's prototype).

Why not a JavaScript prelude: the second rule — JavaScript is input, never implementation. Why not
adapters: the function record IS the adapter, and it costs nothing new. The builtin can tell a
plain call from a construct because a sloppy plain call arrives with the global object as
receiver (`JsCalledAsFunction`); `NewTarget` proper waits for the closures/classes slice. Known
consequence of the slot ABI: a zero-argument call is indistinguishable from an `undefined`
argument (`String()` is "undefined", `Number()` is NaN).

Computed access `o[k]` is ToPropertyKey then the named access: a string key is interned at run
time against the same key table the shape blob carries (`aot_rt_intern_key`, a new name minting a
runtime id past the static ones), every other primitive goes through ToString first. The runtime
shape tree already transitions on any key id, so `o[k] = v` with a never-seen name is just a
runtime transition. Symbols and objects as keys refuse by name.

A Load or Store that reads its slice through a MemMerge depends on that slot node directly
(`n-add-dep!`): the merge's own type does not move when one slot's does, and SCCP once left a
store at the optimistic TOP it computed while the slot was still TOP, to fall from it in the
pessimistic pass afterwards. `AOT_TRACE_TOP=1` narrates memory nodes rising to TOP.

ToString (`JsToString`) is total over primitives; `Number::toString` is the runtime capability
`aot_rt_number_to_string`: shortest round-trip digits by `snprintf`/`strtod` at increasing
precision, then the section's layout rules. `+` concatenates through it. An object operand still
refuses by name (ToPrimitive); the non-returning arms yield the empty string so a caller's
`%UnboxString` stays proven.

## 2026-09-08 — Generic property access is a runtime operation over the shape tree

The compiler's hidden-class tree (`aot.shape`) is the first part of the runtime's (`aot.rt.shapes`).
It is emitted into the object file as the `__aot_shapes` blob beside the stack maps, the runtime
boots its tree from it, and a store the compiler could not resolve continues the same tree at run
time: `shapes-transition` memoises `(parent, key)` exactly as the compiler does and hands out ids
past every static one, so no fast path can mistake a runtime layout for one it proved. Offsets
follow the compiler's rule (fixed by the introducing edge, inherited by descendants), so a static
Load and a runtime lookup on a static shape name the same word.

An own-property access whose owner's backing store is not statically visible when optimization
ends is therefore ONE runtime operation — `JsOp` `JS-PROP-GET-OWN`, `JS-PROP-HAS-OWN` or the
transitioning `JS-PROP-SET-OWN` (`aot_rt_prop_get_own`/`has_own`/`set_own`) — whose memory result
is public BOT: the object escaped to the runtime and any slice may have changed. `[[Get]]` stays
the JSL definition (own step, then the prototype chain); only its own-property step is the runtime
call. Static paths are unchanged: a visible backing store folds to a Load, a constant or the static
transition, and the realm's global object keeps its fixed-shape path with trap arms.

This replaces a closed-world dispatch that enumerated every compile-time shape holding the key at
each unresolved site. It was unsound — the shape universe is not closed at expansion: a store
expanded later creates a transition no earlier dispatch tests for, so a load read `undefined` from
an object that had the property (`P.prototype.constructor`, `p.k` through a chain) — and it was
the bloat class the budgets exist for: k runtime keys over n shapes reach n·k! layouts.
`property-expand-all!` now panics if the shape count changes during expansion.

A transitioning `JsOp` continues its argument registers with an optional allocation shape (string
capabilities only), the safepoint id and a snapshot of SP; the runtime store roots its raw object
and boxed value (`rt-alloc-rooted`, a boxed-root variant of the collector entry) across the
allocation of a child backing store and re-reads both afterwards.

Two backend defects surfaced by the first raw object pointer live across a mid-block safepoint:

- Stack maps compute their own liveness over the FINAL graph (`gc-compute-liveness!`), one backward
  dataflow over live-range ids with phi arms as edge uses. The allocator's live-out table names
  definition nodes as they stood when the interference graph was built; a phi arm it recorded may
  since have been coalesced away, which left a phi's range "live" through a predecessor it was
  never in and asked for a stack home it does not have.
- A before-use split is anchored immediately before its use (final Simple's `insertBefore`),
  never left to the list scheduler, which floated it above a safepoint between it and the use,
  where a register copy cannot legally live; every round re-made the same copy in the same place
  until the budget ran out. The copies anchored to one use move as a group in scheduled order, so
  a copy of a copy stays after its input. A range allowed exactly one register that fails while a
  neighbour BORN in that register (an allocation or call result in X0) still holds it is resolved
  the neighbour's way — split after its definition — because copies of the failing range cannot
  free the register and each round would re-make one. A new before-use copy bypasses an older
  copy only when that copy was made for the same use (final Simple's `insertBefore`); an
  after-definition copy moving a fixed-register value (the link-register Parm) out of its register
  is a value in its own right and stays in the chain — bypassing it undid it every round. A copy
  anchored to a use that is itself an anchored copy travels with it: groups close over anchors.
  `AOT_RA_TRACE=1` narrates failed rounds: the failing range, its members and uses, its
  neighbours, the block schedule, the policy taken.

With these the upstream test262 assertion harness (`assert.js`, `sta.js`) compiles, links and
runs as a realm in about a second; a passing test exits 0, `assert.throws` catches its
`Test262Error`, and a failing assertion reaches `String(value)` in the harness's formatter — the
first standard global — which is the next slice. The parser's old closed-world "write-key shape
closure" (every written key applied to every shape) is gone with the enumerated dispatch it fed;
on `assert.js` it never terminated.

Also decided here: `new F(args)` creates an ordinary object whose [[Prototype]] is F's
`prototype` property, calls F with it as receiver and yields F's result if that is an object;
every function object owns a `prototype` object with `constructor` (MakeConstructor).
`instanceof` is OrdinaryHasInstance over the represented chain (`JsInstanceof`,
`JsInstanceofWalk`). A name nothing in the realm declares is unresolvable: `typeof` of it is
"undefined"; a read or write of it compiles and refuses at run time (`aot_rt_unimplemented_
unresolved_global`) — except a standard global (`JSON`, `Object`, …, `syntax-standard-global?`),
which the realm does not provide yet and which is a runtime refusal under `typeof` too, never
"undefined". `o[k]` compiles as `JsGetKeyed`/`JsSetKeyed` and refuses at run time until keys
intern at run time and arrays exist.

## 2026-09-08 — Receivers, function objects and total coercions

`this` is the receiver slot (slot 0 of the shared ABI). A non-strict function binds it through
`JsSloppyThis` (undefined or null becomes the global object, per OrdinaryCallBindThis); strict
code takes the slot as it is; a Script's top level is the global object; an arrow's `this` is a
capture and waits for closures. `o.m(args)` evaluates the owner once and passes it as the receiver.
Function objects are objects: the function payload begins with the object's two words, so the
object-like guard (`%IsObjectLike` on the two heap prefixes, `%UnboxObjectLike` to the object
payload) admits functions to the same property machinery, and `Unbox(Box(x))` cancels across the
two prefixes. A value-taken function inlines like any other — every call through its object is a
linked site in the closed world — and a Fun left without callers names the runtime invariant trap
from its code word. Duplicate hoisted declarations keep distinct linker symbols; the last one,
the binding JavaScript observes, keeps the plain name.

Arithmetic and comparison are total over the dynamic axis. `JsPrimitiveNumber` and `JsAdd` route
every tag either to a conversion or to a named runtime refusal (ToPrimitive on objects, ToString
of a non-string in concatenation, StringToNumber, a TypeError for Symbol). The refusals are
no-operand runtime primitives whose nominal result lets the arm stand in for the value, so the
final `%UnboxNumber` is proven on numbers alone and a program whose operands the compiler cannot
type still compiles; only the missing conversion refuses, and only when actually reached.

## 2026-09-08 — Exceptions are a pending word and ordinary control flow

*Superseded by "Exceptions are a sentinel completion" (2026-09-09): the flag and the per-call load-and-branch are gone; a throwing function returns the exception sentinel and the caller tests its type. The pending word (value only), the jump-to-catch and the finally completion record stand.*

Simple has no exceptions. Ours are a value in the runtime heap record — `RtHeap.pending-exception`,
a boxed word the collector forwards, reached through `HeapState` on its own alias — plus control
flow the optimizer already understands. A `throw` inside a `try` is a jump to the catch target,
exactly the Scope-merging jump `break` makes to a labeled block, carrying the value in a synthetic
Scope variable the catch clause binds. A `throw` outside any `try` stores the value into the pending
word and returns `undefined`. After every source call, the caller loads the pending word and, if it
is set, jumps to its enclosing catch (clearing the word) or propagates by returning. There are no
unwind tables and no non-local control transfer; the cost is a load and a branch per call site,
which GVN and the branch encoder already handle. `finally` runs on normal completions first; an
abrupt completion through a `finally` refuses by name until the finally region is lowered as a
shared continuation. The entry wrapper reports a pending exception after the last Script through
a runtime entry with a nonzero status.

## 2026-09-08 — A property access is a node that folds through memory SSA, never an eager dispatch

Simple has no property dispatch: a field access is a `Load` whose alias and offset come from the
struct type, and `LoadNode.idealize` folds a load after a store to the same address, bypassing
stores to provably unrelated objects. JavaScript's hidden classes force a dispatch when the shape
is unknown, but the *site* must not pay for it. An own-property access is therefore `PropAccess`, a
call-like node (control, memory, value) carrying its constant key and kind (load, has, store). Its
idealize is Simple's fold reached through the owner's properties word: when memory SSA shows that
word to be a Store of a boxed fresh allocation, the access becomes one Load, one constant, or the
static store transition, and its projections forward. Inlining is what exposes that pattern at
sites opaque at parse time, which is why this is a node and not an expansion; whatever is still
unresolved when optimization ends expands exactly once, before type checking, into the guarded
closed-world dispatch. `JsGetNamed` peels the own-property step off the prototype walk so a
receiver the compiler can see folds to a single Load at the site and only the chain remains a call.
Measured on `let o = {a: 1}; return o.a + o.a`: 178 nodes after optimization became 37, the sum a
constant. `tests/bloat-test.coil` holds the ceilings.

Two neighbours were fixed with it. Global names never entered the shape universe's write-key
closure: a lexically resolved global is a field access over the realm's one hidden class, and
adding the names had multiplied the universe by every permutation of the globals (47,000 nodes
for a ten-line realm, a 105-second fixpoint); the closure itself is gone since generic property
access became a runtime operation (the entry above). And a memory slice now carries Simple's `_one`:
an allocation's private memory and the stores continuing it for that same object are private and
track just the stored value; a store to any other object may not use a private slice as its
prior (BOT) and a load through any other object reads only its declared type from it. Without the
flag a fresh object's `null` properties word typed the shared slice every other object read, and a
shaped store folded to its impossible-arm trap. TOP memory is private TOP and the dual flips the
flag, so the memory lattice has a proper high end.

The realm root itself is ordinary memory: `HeapState` is the runtime heap record's address as a
value — a constant of the HOST pointer kind `TPtr`, never a managed `TMemPtr`, so it is neither a
collector root nor a barrier target and the allocator treats it as a scalar — and the global
object is published by one Store and read by Loads on the realm-root alias through it. GVN and
load uplift share one read per function; the register itself is the reserved heap-state register
the process entry installs. Simple's analogue is a static field's base address.

## 2026-09-07 — A realm is an ordered list of Scripts compiled together over one global object

Simple has no global environment: its top level is a function. JavaScript's is a Global
Environment Record shared by every Script a realm evaluates, and test262 runs its harness Scripts
before each test in exactly that shared record. A realm here is therefore an ordered list of
Script sources compiled into one binary. Each Script keeps its own directive prologue, its own
strictness and its own root function; the function table, the property-key universe and the
closed world are shared; the entry code runs the roots in order.

The global object is a real heap object created by the first Script's root before any of its
statements run, published once to the runtime root `RtHeap.global-object` (forwarded by every
collection, checked by `AOT_RT_GC_VERIFY`) and read back through `aot_rt_global_object` from any
other function. It is built with the ordinary object machinery — `JsNewObjectRaw` and one
`JsCreateDataPropertyNamed` per name, initialized to `undefined` — so its hidden class is the
same transition path any literal with those keys would take and the generic property path agrees
with it. Its property set is the closed world's var-like global names: every top-level `var` and
function declaration of every Script. A lexically resolved global reference is then an ordinary
`JsGetNamedObject`/`JsDefineOwnNamed` against that object; a direct field access over the
statically known layout is a later optimization, not a different semantics.

GlobalDeclarationInstantiation is static: every property exists from the start (holding
`undefined`), so a Script's var step is a no-op, and its function step stores each declared
function object at the Script's start in declaration order (later declarations win). A read of a
global declared only by a later Script would be a ReferenceError and refuses by name until
exceptions exist. Reading a function declaration as a value loads the same object every time, so
`f === f` holds. A call names the declared Fun directly only when nothing in the realm ever assigns
that name — a fact the closed world settles syntactically, conservatively counting any assignment
to an identifier of that name — and otherwise calls through the loaded value. Top-level `let`,
`const` and `class` remain Script-local Scope bindings that functions may not read yet; their
shared cells with TDZ arrive with exceptions. Undeclared names remain global-object property
accesses the compiler refuses by name.

## 2026-09-07 — `dyn{null}` is a constant type, and a non-constant `Con` never reaches selection silently

`undefined` and `null` are the two dynamic tags with exactly one value, so both are constant
types: `ty-constant?` admits them, SCCP replaces any node that proves either with a `Con`, and
selection materializes each as one immediate. Every other singleton tag (bool, int, string,
object…) covers many payloads and stays non-constant. A `Con` of a register type that is not
constant has no machine form and is a selection panic naming the node; only a `Con` that is not a
register value at all — memory, control, a tuple, or the dead placeholders TOP and BOT — selects
to the zero-size pseudo node with no register class. Hand-built test graphs therefore take an
opaque register value from a `Parm`, never from a non-constant `Con`. The allocator enforces the same fact from the
other side: a live range with a register use and no machine definition is a hard error in
`ra-build-lrg!`. Before these rules a `Con dyn{null}` selected to a placeholder with no register
class, and every use read an uninitialized stack slot.

## 2026-09-07 — A store meets its value with what the slice already holds

Final Simple types the memory after a `Store` as `val.meet(tfld)`: the stored value met with the
slice's current element type, because other objects share the alias. Only an allocation's private
memory tracks just the stored value. We follow that exactly: the slice after a store is
`join(declared, value)` met with the prior element type, except for a New's own private bulk slice
(alias 1 with a struct element) and a TOP remainder. The earlier rule replaced the slice type with
the value type, which typed a later load too narrowly and made a dispatch select the wrong case.

## 2026-09-07 — Call targets resolve through the function registry, never through the pointer node's edge

Final Simple's `CallNode` links a singleton function-pointer type through CodeGen's linker table by
function index. Following the pointer node's input 0 instead is correct only for a `FunPtr`
literal; a singleton-typed `Load` or `Phi` has a control input there, and following it links the
ENCLOSING function. `CallNode.idealize` and direct-call selection both use `arena-function` on the
type's function index. A `FunPtr` machine node likewise carries its symbol from the registry and
keeps no graph input, since GCM would otherwise be asked to place it below a block that does not
dominate its uses.

## 2026-09-07 — Managed-root split boundaries apply only to ranges a safepoint restricted

*Superseded in part by "The compile-time architecture" (2026-09-08): frames preserve no registers, so a safepoint kills every register and the managed-root splitters are removed.*

A boxed value live across a Call, New, JSOP or Safepoint is restricted to the collector's root
homes, and a later register-only consumer needs a reload boundary; splitting the definition side
would only reproduce the empty range. That rule was firing for every boxed range with a
register-defined member, including an ordinary boxed parameter with a fixed definition and a
conflicting fixed use, which then split after its definition every round and never converged. The
allocator now records `root-restricted` on a live range when the safepoint mask is applied (joined
on union) and consults the managed-root splitters only for those ranges; everything else takes
Simple's ordinary empty-mask and pressure splitters.

## 2026-09-07 — Function values are heap objects over a uniform boxed ABI with a finite target set

Simple's function literal is a `FunPtrNode` constant: a raw code address typed by its signature and
function index, callable through `Call` and linkable because the pointer's type names a finite set
of functions (chapter 18, `func()` and `TFPARM`). JavaScript functions are also objects with
properties and, later, captured environments, so a function value here is a heap object whose
payload begins exactly like an ordinary object (prototype word, properties word) followed by the raw
code word and a boxed environment word, boxed under the distinct FUNCTION NaN prefix. `%IsFunction`
is therefore one prefix test, property machinery can treat the first two words as it treats any
object, and the collector scans the payload as boxed words: a text address never carries a
reference prefix, so the code word is inert to tracing.

Every source function — declaration, expression, arrow, top-level `main` — shares one internal
signature: `this`, then the program-wide maximum formal count of dynamic slots, all boxed. An
indirect call cannot know its callee's arity, and Simple's linker requires one signature per
function-pointer set, so the closed world pays with padded `undefined` slots (register slots first,
then stack) rather than with a second entry point per function. The wrapper and direct calls pad
the same way; missing formals still read `undefined` and extra actuals are still evaluated and
dropped. A code word loaded from a function object is typed as the function-pointer set of every
function the program ever materializes as a value; Opto links a value call to exactly that finite
set, which keeps `f(x)` an ordinary `Call` that the ordinary inliner can specialize when the set is
a singleton. Materializing a function pointer as a value is `ADRP`/`ADD` against the function's
symbol with page relocations, as Simple's arm port does.

Calling a non-callable value is a TypeError; until exceptions exist the guard's false arm reaches
the runtime `aot_rt_throw_type_error` entry, which hard-errors. Captured variables are not admitted yet: a
nested function referring to an enclosing function's binding refuses by name, because capture is
by reference and needs the environment cells `node/closure.coil` describes.

## 2026-09-07 — Tokens have a spelling and a StringValue, and the grammar reads only the spelling

An IdentifierName written with `\u` escapes is one token whose `token-text` is its decoded
StringValue and whose `token-is` — the predicate every keyword, punctuator and contextual-word
check uses — compares the raw source spelling and is false for any escaped token. This is the
specification's split: `async`, `of`, `get`, `static`, `let` and the reserved words are syntax and
must be spelled literally, while early errors about `await`, `yield`, `eval`, `arguments` and
strict-mode reserved names are stated on StringValue and see through escapes. Decoding in the
lexer with two predicates keeps the parser's several hundred `token-is` checks correct by
construction; the alternative — decoding in the parser at each identifier position — would need
every contextual-keyword site to remember which comparison it is making. Escaped reserved words
stay `TOK-IDENT` (they are legal property names) and the parser rejects them where an Identifier is
required.

## 2026-09-07 — Regex patterns are validated at parse time by a flag-selected grammar

A regular-expression literal's pattern is checked by `src/parse/regex.coil` while the literal is
parsed, with verdicts (ok, error, unknown) returned to the parser rather than raised: the parser
owns SyntaxError reporting and the fail-closed path. The validator reads the body as code points
under `u`/`v` and as UTF-16 code units otherwise, because Annex B's grammar counts surrogate halves
separately, and it selects between the strict, web-compat and class-set grammars from the flags
instead of parsing once and post-filtering. The Unicode property tables are Coil constants
holding the exact spellings ECMA-262 admits for Unicode 17.0.0 (the version test262 revision
419d3e0a generates from); they are data the compiler needs, so they live in source, not in a
side-car file. A classification the tables cannot make — a non-ASCII group-name code point whose
ID_Start/ID_Continue status decides validity — is an `unknown` verdict and a compiler error, never a
guess in either direction. The alternative, validating at RegExp construction, would turn early
errors of the program into runtime failures of a particular execution and would not serve the
syntax-only test262 verdicts at all.

## 2026-09-07 — Patterns are a separate table built by parse or by cover reinterpretation

Destructuring patterns are their own sum-typed records (`PatternNode`: name, Reference leaf,
object, array) in a `patterns` table beside the expression table, never a flag on object or array
literal nodes. Where the grammar knows it is reading a BindingPattern (declarations, parameters,
catch) the parser builds the pattern directly and can reject `[`/`{` in an identifier position as
a proven error. Where JavaScript's cover grammar applies — `=` targets, arrow parameter lists and
for-in/of heads — the literal is parsed as an expression and converted afterwards; the literal
stays in the expression table but is marked consumed so the shorthand-initializer check skips it.
A parenthesized name inside an assignment pattern is kept as a Reference leaf, not a name, so the
same pattern reused as arrow parameters (`({a: (b)} = c) => 0`) still fails. The alternative — a
`pattern` flag on literals with leaves validated at lowering — would let a syntax fact escape the
syntax pass, and every pass that enumerates bound names (declaration conflicts, strict bindings,
`yield`/`await` in parameters) would have to understand literal shapes instead of one walker.

## 2026-09-07 — Private names resolve when their class closes

A `.#name` reference may precede the field or method that declares it, and may sit inside nested
functions or classes. The parser records every private reference with its class nesting depth;
when a class body closes, references at its depth either match one of its declarations or are
handed to the enclosing class one level up, and a reference that reaches the outermost class
unresolved is a proven SyntaxError. This keeps AllPrivateIdentifiersValid a syntax fact without a
second scope structure: the class table only knows names, never bindings.

## 2026-09-07 — Function records are reserved before their bodies and only top-level ones are Funs

Final Simple parses a function by pushing its scope and body inline; a nested function is a
`FunNode` created as its body parses. JavaScript needs the enclosing function known before the
body (contexts for `yield`/`await`/`super`/`new.target`, strictness inheritance, and declaration
scoping), so a `SyntaxFun` record is reserved when the `function` keyword, method key or arrow
head is seen and filled when the body closes. Parents therefore precede children in the table and
strictness settles in one forward pass after parsing.

The closed-world Fun table lowers only declarations the program loop met at the top level (marked
`hoisted`), plus the Script root, which has its own non-function context so `return` and
`new.target` stay Script errors while block-level function declarations get a parent. Everything
else is a function value; until closures and function objects exist those refuse by name at
lowering, and the syntax passes still prove their early errors.

## 2026-09-07 — Regex and template tokens are parser-driven; unvalidated regex fails closed

Final Simple's lexer has no context-dependent tokens. JavaScript's `/` is division or a regex
literal depending on parse state, and a template resumes after each `}` that closes a substitution.
Both are therefore rescanned by the parser: it meets a `/`, `/=` or `` ` `` punctuator in primary
position (or a `}` after a substitution) and asks the lexer to rescan from that token's start as
a regex body or template part. Peeking never changes the consumed-end boundary, so spans stay exact.

The regex pattern grammar is not implemented yet. A regex literal is tokenized and its flags are
checked, but once the whole program has been parsed a syntax-only run that saw any regex literal
fails closed as a compiler refusal. Other early errors in the same program are still reported first,
so `/re/ = 1` proves its target error while `/(?/` is neither accepted nor falsely rejected.

## 2026-09-07 — Loops, continue and labels follow Simple's jumpTo with dead-start exits

Final Simple's `parseLooping` builds the Loop, duplicates the head Scope with lazy Phis, parses the
predicate, creates the break Scope on the false projection, parses the body, merges the loop bottom
into the continue Scope (`_continueScope = jumpTo(_continueScope)`), then parses the deferred `for`
update and closes the loop atomically. `jumpTo` duplicates the current Scope, kills control, pops
lexical levels to the target depth, and either becomes the continue Scope (first continue) or
merges into the target. We keep that order exactly; the syntax tree lets the update be lowered in
place instead of re-scanned.

JavaScript adds `do-while`, labelled targets and labelled blocks. A `do-while` exit and a labelled
block exit have no predicate edge to be born on, so they start with XCtrl control and receive
breaks (and the do-while false edge) by ordinary Scope merges, the same construction the switch
exit already uses; Region peepholes drop the dead path. Jump targets form one stack: an unlabelled
`break` takes the nearest loop or switch, an unlabelled `continue` the nearest loop, a labelled jump
the target carrying that label, and labels accumulate onto the loop or switch they name.

## 2026-09-07 — Syntax records are sum types and operators are admitted ahead of semantics

`SyntaxExpr` and `SyntaxStmt` carry a `defsum` node (`SyntaxNode`, `SyntaxStmtNode`) plus a source
span. Every walk over the tree — lowering, strict early errors, declaration collection, break
validation, the hidden-class prepass — is an exhaustive `match`, so a new production is a compile
error at each site that has not decided what to do with it. The previous integer `kind` tags with
generic `left/right/third/args` slots let a forgotten arm reach the runtime `unknown syntax`
panic and let a variant reinterpret the shared fields by convention. Child ids remain 1-based
indices into parser-owned side arrays; optional children are `Option`, never a sentinel id. This
keeps `docs/FRONTEND.md`'s thin-tree rule: no per-construct structs, no visitor, no typed AST.

Operator variants name their JSL entry point (`JsGt`, `JsMod`, `JsBitAnd`, …). The complete
ECMAScript operator precedence is parsed before every operator has production JSL. Lowering asks
`jsl-defined?` and refuses an absent definition by that name, so admitting syntax never invents a
local semantic substitute. Exhaustive early errors this makes provable: AssignmentTargetType for
every admitted expression kind, `++`/`--` targets, a unary operator before `**`, `??` mixed with
`&&`/`||`, strict `delete identifier`, strict `eval`/`arguments` update and logical-assignment
targets, and a token that can never begin an expression.

A CallExpression assignment target is a SyntaxError only in strict code. Sloppy web-compatible
code defers to a runtime ReferenceError, which test262 encodes by marking those tests `onlyStrict`;
lowering refuses the sloppy case by name until exceptions exist. Grammar that exists in JavaScript
but is not yet admitted (arrow `=>`, computed members, optional chains, templates, spread, `async`,
labels, `for`/`do`/`try`/`throw`/`class`/`function` statements, `this`/`new`/`super`/`import`
primaries, regex) must fail as a compiler refusal, never as a proven SyntaxError; the fail-closed
token sets live beside the primary and statement-end parsers.

## 2026-09-07 — AArch64 floating comparisons use unordered-false condition codes

FCMP on a NaN operand sets N=0 Z=0 C=1 V=1. The signed integer codes LT (N≠V) and LE (Z=1 or
N≠V) are therefore true for NaN, so `NaN < 0` compiled to true whenever the comparison survived to
runtime rather than folding. Floating `<` now selects MI and `<=` selects LS; their `^1`
negations PL and HI are true for NaN, which is exactly the false-arm behavior JavaScript requires.
The condition code is chosen from the FLAGS producer's register class in both the CSET form and the
conditional branch (`arm64-condition-code`). EQ/NE and unsigned ULT are unaffected.

## 2026-09-06 — Assignment expressions retain References across RHS evaluation

Final Simple recursively parses assignment RHSs, retains old operands for compound updates,
and retains field bases/offsets until storing through the post-RHS memory state. We follow that
order in the syntax-to-JSL walk. `=`, `+=`, `-=`, `*=` and `/=` now have one expression path;
expression statements discard its result. Assignments associate to the right and return the
assigned value, including ignored non-strict writes to non-writable global primitive bindings.

Following [ECMA-262 assignment evaluation](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-assignment-operators-runtime-semantics-evaluation),
we retain the property base once, read the old value before a compound RHS, and pass the result
through existing JSL arithmetic and property operations. RHS expressions can replace the active
Scope, so assignment stores, argument completion and while predicates reacquire that Scope.
Binary lowering keeps its left value across RHS updates. Simple obtains that graph ownership by
attaching the left operand to an incomplete operator node before parsing the right operand.

This change does not discharge generic property-load arithmetic or implement full `[[Set]]`.
The representation checker still refuses unproven numeric/string unboxes; descriptor/accessor
semantics and nullish-base exceptions remain missing from the property runtime.

## 2026-09-06 — Source string escapes preserve UTF-16 and raw directive spelling

Final Simple copies ordinary string characters and decodes backslashes before constructing a
value. We extend that lexical step with the
[ECMA-262 StringLiteral grammar](https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-string-literals).
The syntax record owns a UTF-16 buffer, including unpaired surrogates, and retains the original
quote-stripped spelling for directive recognition. Hexadecimal and braced Unicode escapes,
legacy octal and decimal escapes, identity escapes and line continuations share this decoder.
Scope validation rejects legacy escapes in strict code after discovering the directive prologue.
An escaped spelling of `use strict` does not enable strictness.

The frontend passes decoded units to the existing JSL string allocation/memory lowering. JSL
text literals retain their UTF-8 entry point and use the same graph construction. Raw UTF-8 runs
append into the destination buffer without temporary per-run buffers. Parser reset frees source
literal buffers; the JSL text wrapper frees its temporary units after graph construction.

## 2026-09-06 — Strict early errors follow syntax scope

[ECMA-262 strict-mode restrictions](https://tc39.es/ecma262/multipage/strict-mode-of-ecmascript.html)
apply to the relevant Script or function code. We derive strictness from each directive prologue
and inherit Script strictness into its source functions. A sibling function's directive changes
neither the Script nor another function. Blocks and grouped strings do not introduce strictness.

Checks walk syntax before lowering so unreachable code still receives early errors. Binding and
assignment checks distinguish identifier targets from property names; object keys remain keys,
not identifier references. Numeric checks inspect original spellings to distinguish legacy forms
from equal-valued modern literals. The syntax-only API can report normal strict parsing within
the admitted grammar. Ordinary compilation still refuses strict runtime execution until its
binding, receiver and arguments semantics are implemented.

## 2026-09-06 — Numeric literals use maximal munch and one rounding step

Final Simple scans digit strings, selects long or double syntax, and rejects leading-zero
integers. We follow its cursor organization but use the
[ECMA-262 numeric grammar](https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-literals-numeric-literals).
The scanner consumes the decimal point even with no following fractional digits, validates each
separator between digits, and checks the next character after radix and BigInt suffix handling.
Legacy octal tokens remain distinct from Annex-B leading-zero decimal tokens.

Decimal conversion strips validated separators into an owned buffer and uses the existing
binary64 conversion primitive. Radix conversion retains 53 significand bits, a guard bit and a
sticky remainder, then rounds once with ties to even. This avoids accumulating a large integer
through repeatedly rounded floating arithmetic. Literal lowering chooses the compact integer
representation only after proving an exact round trip within its payload range. Operators on
these literal values continue through the production JSL lowering path.

## 2026-09-06 — Parse results precede runtime initialization

[ECMA-262 ParseScript](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-parse-script)
checks source syntax and early errors before ScriptEvaluation and GlobalDeclarationInstantiation.
The syntax-only driver shares production syntax collection and declaration checks but performs
neither graph lowering nor execution. It reports proven SyntaxErrors through a versioned parse
protocol. The Test262 worker validates the entire record and matching process status.

Unknown grammar, compiler panics and missing capabilities remain outside this channel. Strict
early-error validation now covers the admitted syntax as described above; runtime strict
semantics remain unsupported. Global restricted-property checks belong to
initialization, so syntax-only validation excludes them. The compiler's ordinary compilation
diagnostics and runtime abrupt-completion host still need typed reporting beyond this parse API.

## 2026-09-06 — Literal function-pointer copies preserve identity; body clones rename it

Simple retains the FunPtr constant payload during shallow copy, then assigns a fresh function
index in Fun.copyBody and constructs the entering call pointer in CallEnd.doInline. We store
the tuple signature and function index separately. A generic copy therefore preserves a literal
FunPtr's owner edge even if its owner also appears in the selected set. Remapping that edge alone
would leave its index naming one function and its signature updates following another.

The body-cloning operation assigns a fresh index and replaces selected recursive callee literals
with pointers to the private Fun. The entering call uses that same index. This keeps literal-copy
semantics separate from private-body identity changes and keeps the owner registry consistent.

## 2026-09-06 — Finite call targets use a compilation-local owner registry

Final Simple keeps a function-index-to-Fun table in CodeGen. During SCCP it checks call arity,
defers complemented target sets, and links each missing finite target. It uses a read-only lookup
because unlinking unknown callers can leave a function temporarily unreachable before a new call
revives it. Target evidence may come from a Phi, Parm or call result as well as a FunPtr literal.

We keep the owner table beside the function-index allocator in NodeArena, avoiding an import cycle
from graph constructors into CodeGen. FunPtr construction registers its owner; conflicting owners
for one index hard-error. The table contains node IDs, adds no liveness edges, and resets with the
compilation arena. Lookup does not delete an owner based on its current control type.

An absent finite owner hard-errors as unresolved cross-unit support. Simple can classify that case
through its external-function machinery; we cannot infer an external ABI from absence. This change
covers graph linkage. JavaScript callable objects, closure environments, member-call receivers and
escaping-pointer support remain separate requirements before admitting those source expressions.

This file records deliberate architecture choices that differ from Simple or settle behavior not
fixed by the reference implementation. Code contradicting a decision here is a bug unless this
file is amended at the same time.

## 2026-09-06 — Operand bounds and delayed representation settlement

Final Simple constructs the operand Phis in `drop_same_op` from operand types. Our constructor
stores a declared bound before filling the inputs, so we meet the corresponding operand types
before construction. Reusing the result bound is invalid for comparisons, whose Boolean result
has a different type family from floating operands.

Box follows Simple's one-shot mode discipline for initially unknown raw producers: once the
input lattice type determines a representation, Box unlocks its GVN identity and records that
representation. Explicit tags remain unchanged. JSL keeps borrowed control across eager unary
folds because removing a temporary Box must not kill the enclosing expression's control.

The pre-dominator recursion check walks caller control only. It visits Region predecessors,
but traverses CallEnd through its Call, excluding the callee Return edge. This preserves final
Simple's caller-ownership test while call-graph discovery is still constructing dominators.

## 2026-09-06 — Tagged identity and empty-mask split progress

JSL `%SameBits` accepts two dynamic words and lowers to integer-mode EQ. Simple's `BoolNode`
mode 1 permits non-integer lattice operands and returns BOOL until identity or range evidence
proves an answer. We reuse that machine-word comparison without assigning JavaScript semantics
to the node. JSL strict equality first handles Number and String, then uses tagged identity for
the remaining represented tags. Numeric `%Eq`/`%Ne` accept numeric operands only.

Final Simple's `RegAlloc.splitEmptyMaskSimple` returns true even if its insertion guards skip
both endpoints. Our generic equality regression reaches that case with a cloneable, fixed-XZR
zero constant shared across nonconstant Phi results. We require an actual edit before treating
the cheap split as progress; otherwise allocation uses the existing loop-boundary splitter.
The convergence cap and register constraints remain unchanged.

## 2026-09-02 — Boxed non-references get spill homes but are not roots

*Superseded in part by "The compile-time architecture" (2026-09-08): every kind takes a slot across a safepoint; the kind distinction remains only for what the stack map records.*

NaN-boxing makes null, undefined, booleans and compact integers machine words with the same storage
width as boxed object references. Values live across collecting calls need addressable spill homes
for allocator convergence, but a word whose lattice tag excludes string, symbol, object and
function cannot require relocation.

Register allocation therefore carries a distinct boxed-scalar live-range kind. Call boundaries may
place it in the stack namespace, while stack-map construction omits it. Reference-bearing dynamic
unions retain the conservative boxed-root kind. This distinction is derived from the shared dynamic
tag lattice rather than from individual opcode names.

## 2026-09-02 — Moving-root stack boundaries extend the allocator convergence budget

*Superseded in part by "The compile-time architecture" (2026-09-08): the budget returns to Simple's seven rounds.*

Final Simple caps iterative graph-coloring allocation at eight rounds for its scalar language.
This compiler's moving-GC divergence gives every live root two additional fixed stack boundaries:
the Safepoint input and the post-safepoint relocation projection. The linked forced-collection
regression converges deterministically in fourteen rounds while preserving those R2 boundaries.

The allocator therefore retains Simple's hard failure policy with a sixteen-round cap. This is not
permission to retry without bound: reaching round sixteen is still a splitting bug and hard-errors.

## 2026-08-31 — AArch64 stack-to-stack splits use a proved IP0 scratch

Final Simple models a split as accepting any physical register or stack slot at either endpoint,
but its AArch64 encoder throws `TODO` when both endpoints are stack slots. We keep the complete
split mask and implement that missing case as `LDR X16, [SP, source]` followed by
`STR X16, [SP, destination]`.

X16/IP0 is not silently clobbered. `Arm64SplitNode` excludes X16 from its own input and output
masks and exposes X16 through `m-killmap`. The interference graph therefore proves that no other
value is live in X16 across a split, while X16 remains allocatable in regions without splits. The
selected size is four bytes for every ordinary split and eight bytes for stack-to-stack expansion,
so layout and emission continue to agree exactly.

## 2026-08-31, amended 2026-09-02 — Generational collection uses a non-collecting post-write barrier

Simple has no garbage collector and therefore fixes no write-barrier policy. Our executable moving
collector is stop-the-world and generational: allocation enters one of two copying nursery spaces,
a first survivor ages in the other nursery space, a second survivor promotes into the active old
generation, and major collection compacts reachable
young and old objects into the other old-generation semispace. A Store whose value is a raw managed reference or a
boxed word that may contain one is followed by a pinned Barrier. The Barrier consumes the Store's
new alias-memory state plus `(object, value)` and returns that same memory type, placing remembered-
set maintenance after the heap write in the memory SSA chain.

Arm64 lowers the Barrier inline with arbitrary allocated object/value GPRs and fixed X15–X17 scratch
kills. There is no call, caller-save clobber, safepoint, or relocation. The object's header embeds
its owning card-byte address; zero identifies a nursery owner. An old-to-young write dirties the
owner's 512-byte old-space card with the compiler-proven raw or boxed value kind. Each old semispace owns a byte card table and an
object-start table, so minor collection begins at the first object intersecting each dirty card,
scans the affected objects with the recorded raw/boxed card kinds, and clears the card before
completing the promotion closure. Repeated writes coalesce by OR-ing card-kind bits. A future concurrent or SATB collector
would require amending this decision and changing
placement semantics; it must not silently reuse this post-write boundary as though the policies
were equivalent.

## 2026-09-01 — Hoisted functions measure inlining cost over their own body window

Final Simple parses one function at a time, so its `Return`-minus-`Fun` node-id estimate covers that
function's construction. This frontend must hoist every function header before lowering any body.
The same raw node-id span would therefore charge one body for unrelated Fun and Parm headers and
could push a small source or JSL function over Simple's 100-node inlining threshold.

After constructing a body, source and JSL lowering replace the initial span estimate with the
number of nodes allocated in that body's lowering window. The independent live-node cap is still
checked at the decision point. This preserves Simple's heuristic while adapting its construction-
order assumption to JavaScript declaration hoisting.

## 2026-09-06 — Lexical binding creation precedes initializer evaluation

Final Simple defines a variable by checking the current lexical level, appending its Var metadata
and adding its value edge. JavaScript requires a separate creation step before the statement list
runs. The frontend predeclares direct let/const bindings on entry to the function, Script or block
scope, then initializes each slot at its declaration. An initializer-free let obtains undefined
from JSL. ScopeNode remains the sole binding environment.

An uninitialized binding occupies a TOP-valued graph slot with Var.uninit set. TOP denotes the
absence of a value; source reads and writes refuse with a named unsupported ReferenceError before
resolving the slot. Branch duplication copies the marker, and loop duplication leaves these slots
without lazy sentinels. The admitted structured grammar cannot initialize a surviving outer binding
on one branch alone; a merge that encounters inconsistent markers refuses instead of losing TDZ
state. Runtime TDZ checks and exception completions remain required for closures and wider syntax.

Blocks pop the active Scope after lowering their bodies. A loop replaces that Scope with its exit
environment, so popping the pre-loop handle would leave the inner bindings visible after the block.

## 2026-09-01 — The process entry is a wrapper around boxed source `main`

Amendment, 2026-09-06: this entry convention applies to `compile`/`run` function-entry mode.
`compile-script`/`run-script` select JavaScript Script grammar. Their platform wrapper calls the
private zero-argument Script execution root and returns zero on normal completion, independent
of expression completion values. Source `main` remains an ordinary declaration. The compiler
parses the original source, rejects top-level Return, and preserves source spans; it does not
wrap source text in a function. The private Fun supplies AOT execution storage, not function-scope
language semantics. Global lexical captures and strict-mode directives currently hard-error
until their semantics exist. This amendment does not claim a complete global environment.

Source `main` is an ordinary JavaScript function with the internal dynamic-value ABI and the
private symbol `$aot$.source_main`. The dot is outside the admitted source identifier grammar, so a
user declaration cannot collide with this compiler-owned name. A distinct compiler-owned function
owns the platform `main` symbol, calls the source function, and alone converts the boxed result to
the host integer status. The wrapper is never inlined, so ordinary source calls to `main` continue
to observe a boxed Number.

Host `argc` and `argv` are not JavaScript actual arguments. The wrapper supplies canonical boxed
`undefined` for every declared source parameter, including stack-passed parameters, exactly as an
ordinary omitted actual does. Extra ordinary actuals are evaluated left-to-right for effects but
are absent from the fixed formal ABI until the language admits an `arguments` object.

## 2026-08-31 — Dynamic words use high-prefix NaN boxing with signed 48-bit integers

Simple has no JavaScript value representation. Our dynamic word reserves positive quiet-NaN
prefixes in the high 16 bits. The exact assignments are `0x7ff8` canonical double NaN, `0x7ff9`
integer, `0x7ffa` undefined, `0x7ffb` null, `0x7ffc` Boolean, `0x7ffd` string, `0x7ffe` symbol, and
`0x7fff` object. Function must remain distinguishable from object for `%IsFunction`, so it uses
the negative quiet-NaN prefix `0xfff9`. A tagged value's low 48 bits are its payload.

Non-NaN doubles retain their exact IEEE-754 bits. Boxing any NaN canonicalizes it to positive
`0x7ff8000000000000`; preserving arbitrary NaN payloads would let a Number impersonate one of the
reserved tags. `%IsFlt` is therefore the complement of the reserved positive prefix range plus the
function singleton, while every other checker-admitted singleton predicate compares one exact
prefix. The object-layout kind in a heap payload refines an object or function after this top-level
classification; it does not replace the dynamic-word tag.

The integer payload is signed two's complement. Boxing therefore replaces the high 16 bits with
`0x7ff9`; unboxing sign-extends bit 47. This gives the promised signed 48-bit immediate range and
also preserves a small program result in the low exit-status bits. Encoding this explicitly is
mandatory: treating Box as an identity would make negative integers and runtime tag tests wrong.

An admitted decimal integer spelling is first rounded to binary64, as ECMAScript requires. Only an
exact value within the positive signed-48 payload range uses the compact integer representation;
larger spellings retain their binary64 bits. A dynamic Number consumer tests the integer prefix and
converts either representation to f64. Cast remains a control-pinned identity move so the proof
cannot float above its guarding edge.

## 2026-08-31 — Return GVN identity includes function ownership

Final Simple rejects Return equality when either owning Fun is dead, while its distinct RPC edges
normally keep live Returns in different functions structurally unequal. Our currently supported
frontend has not yet materialized RPC nodes, so two live Returns can otherwise become identical
during the short clone-inlining window. That merged node carries only one `fun-nid`, corrupting the
other function's ABI masks, symbol, and frame ownership.

Function ownership therefore participates directly in Return equality and hashing here. This
makes explicit a fact Simple normally obtains from the RPC edge and remains valid after concrete
RPC construction: a Return is a function exit, not a freely shareable tuple expression.

## 2026-09-03 — Nursery allocation uses a reserved heap register and an outlined slow path

Simple does not supply a garbage-collected allocation ABI. Generated AArch64 reserves callee-saved
X28 for the `RtHeap` address and removes it from every ordinary, split, and save register mask. The
compiler-owned process entry preserves the platform caller's X28, calls the Coil runtime once to
boot and obtain the heap state, installs it for the closed-world program, and restores it on exit.

Constant-size `New` operations compare and advance `RtHeap.used` against nursery capacity, write
the runtime-owned header, and zero payload words inline. Exhaustion branches to the existing
`aot_rt_alloc` safepoint with its stack-map identity and caller SP. GC stress and statistics modes
set `fast-disabled`, forcing the same slow path so collection-on-every-allocation and exact counters
remain authoritative. Allocation policy, root discovery, and collection remain entirely in Coil;
the inline sequence is only the non-collecting realization of a successful nursery reservation.

## 2026-08-31 — Atomic loop finalization keeps the entry Scope alive

Final Simple's `_endLoop` closes control and then every lazy Phi backedge while the Java ScopeNode
object remains locally reachable. Coil reclaims graph nodes eagerly when their last use disappears.
Resolving the back Scope's memory sentinel can therefore remove the entry Scope's last graph use
before later variable slots have been finalized.

`scope-end-loop!` explicitly keeps the entry Scope for the complete atomic operation and releases it
after the back Scope is killed. This is a lifetime adaptation only: edge order, lazy-Phi rules, and
the final useless-Phi cleanup continue to follow Simple.

## 2026-08-31 — Phi results at one block head interfere pairwise

Phi definitions execute in parallel at their Region or Loop head. Distinct surviving value Phis at
one head are simultaneously defined and cannot occupy the same register. Simple's backwards
liveness walk derives this constraint from the live Phi ranges. Our durable schedule and unified
LRGs did not reliably materialize that edge, allowing two loop induction values to share X0 and
turn a terminating loop into an infinite loop.

The IFG builder now records pairwise interference between overlapping, register-producing Phi masks
at a block head before its ordinary backwards walk. This states the SSA parallel-definition rule
directly and remains conservative when a Phi later needs spilling.
