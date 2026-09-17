# Decisions

## 2026-09-17 — A dynamic integer carries its range, and relational tests narrow it

The dynamic axis was a tag set and nothing else, so no fact about a JavaScript number survived a
boundary: `Box(2)` was `dyn{int}`, as general as any integer. Three things followed. A literal
operand was never inlining evidence (decision 3 of the compile-time architecture compares types, and
the literal's type was the Parm's). A comparison had nowhere to record what it proved. And integer
arithmetic could not prove it does not overflow the signed-48 payload, so `fib(value - 1)` had to
admit a double. Adding special cases for each of these — literal evidence by node shape, dominator
walks over raw comparisons, overflow folding by pattern — was tried and abandoned
(`archive/int-fast-path-attempt`): each exposed the next, and it slowed `fib` down.

The design instead gives the lattice the missing fact, in three parts, landed in this order:

1. **`TDyn` carries an integer component.** It is an ordinary `TInt`, widen stage included, that
   describes the payload of the `int` member. Where `int` is not a member it is canonically the int
   top (low set) or bottom (high set), so it never distinguishes two denotations that are equal; a
   range covering or leaving the signed-48 payload canonicalizes to "any integer". It duals and
   meets with the existing integer lattice, and the tag set keeps its complemented-set rules. `Box`
   of a raw integer carries the integer's range; `Unbox_int` of a proven integer reads it back. Loop
   Phis and recursive Parms widen the component exactly as they widen raw integers.
2. **An integer fast path for `+`, `-` and the relations** (JSL), with signed-48 overflow boxed as
   binary64, dispatch bodies kept under the inline size cap, `Unbox(Box(x))` folding only when `x`
   fits the payload, and pessimistic widening only of falling ranges (all found by the abandoned
   attempt).
3. **Relational guards.** Simple's `ScopeNode.addGuards` narrows a tested value on each arm of an
   `if`; `scope-add-guards!` ports it and is not yet called. For `x < k` (and `<=`, `>`, `>=`) with
   `x` a binding and `k` an integer literal, each arm rebinds `x` to a Cast narrowing only its
   integer component. It is sound for every value: the Cast constrains the `int` member alone.

With these, `fib`'s recursive arm sees `value` as `int[2..]`, both subtractions fit the payload, the
overflow arm is dead, and no double reaches the parameter. Specialization (int and generic clones)
is not needed for that; it remains the tool for callers of mixed types.

### As landed (parts 2 and 3, 2026-09-17)

The guards landed before the fast path, since the fast path alone was measured slower. What the
implementation had to add, each found by measurement or by a failing test:

- **The fast path lives in the operators.** `JsAddOperator`, `JsSubOperator` and the four relational
  operators test `%IsNumber` on both operands, then `%IsInt`: two integers compute as integers
  through `JsBoxInt48`, two other Numbers as binary64 inline, and every other pair calls the
  operator's generic definition (`jsl/compiler/int-arith.jsl`), which is `:noinline`. Measured with
  `AOT_INLINE_TRACE`: `JsLtOperator` built at 106 nodes (over Simple's cap of 100) never inlined, and a
  generic definition allowed to inline grew the shared operator body past the cap again (`fib(30)`
  22 ms). `JsSub`, `JsAdd` and `JsRelationalOrder` are unchanged.
- **`%IsNumber`** is a tag predicate over int and double. On arm64 it is the double classifier with
  the reserved positive range starting one above the integer prefix.
- **An unboxed integer is at worst the signed-48 payload range**, at the last widen stage, and
  `Unbox(Box(x))` folds only when `x` fits it.
- **The pessimistic pass does not walk a rising range.** A loop Phi, recursive Parm or call result
  keeps its range instead of narrowing to a non-constant one; the optimistic pass, which widens,
  finds the precise range. Without this, `value >= 2` feeding `value - 1` back into `value` narrowed
  the range by one per recomputation.
- **A call's result widens like a Parm.** `return 1 + down(n - 1)` grows the result range by one per
  optimistic iteration through the CallEnd, which is neither a loop Phi nor a Parm, and compiling it
  did not finish.
- The harness-realm budget grew 6,120 → 6,631 machine nodes and 1,215 → 1,315 blocks, rounds
  unchanged at 4: the Number arms at every operator site.

`benchmarks/fib-steady.js`: `fib(30)` 8.1 → 5.2 ms per iteration, with `fib`'s parameter
`dyn{int[0..30]}`.

## 2026-09-16 — A call through a function value names only functions that can be there

The rest of the whole-program call resolution the previous entry began. A code-word `Load` whose
pointer is not an image `StaticRef` — a function read from a property, an argument, an array
element — was typed as every value-taken function. `console.log(s)` reaches the generic
`OrdinaryToPrimitive` and `Call` getter paths, so `fib` became a possible `valueOf`, and the
optimistic fixpoint merged those sites' `undefined` and `string` arguments into its parameter.

The closed-world image scan (aot.node.imagefacts, "Call targets") already knows which image entries
each value can be, and which escape. It now publishes, per code-word `Load`, the functions its
pointer can call (`facts-code-targets`, aot.facts):

- a pointer the analysis names is those entries, so its code is their code words;
- a pointer it cannot name (TOP) is an escaped entry or an object the image never held, and the only
  function objects the image never held are the ones the program allocates — each written by a
  code-word `Store` in the graph — so its code is an escaped entry's code word or one of those
  Stores' values.

`load-compute-of` joins the declared type with that set. Nothing is published when outside code may
mutate the realm, when some allocation's code word is not a finite known set, or when a named
pointer names no function. An inlined clone of a `Load` inherits its original's entry
(`facts-inherit-code-targets!`, from `copy--shell`): the clone keeps the narrowed type it was copied
with, and the fact about the body holds in each context the scan joined into it. Without that the
clone's next compute widens back to the declaration, which the monotone `n-set-ty!` rejects.

Simple has no counterpart: its function pointers come only from `FunPtr` constants and flow through
the ordinary type lattice. Our image function objects have no `FunPtr` in the graph, so their flow
is recovered by the image scan instead.

Measured on `benchmarks/fib-steady.js` compiled as a Script: `fib`'s parameter narrows from every
JavaScript type to `dyn{int,double}`, and `fib(30)` drops from 18.1–21.3 ms to 8.4 ms, the speed of
the same `fib` through `aot compile`'s function entry. The comparisons in `fib` still call the shared
`JsLtOperator`/`JsSubOperator` bodies: every caller's argument types now equal those bodies' Parm
types, so the inline gate sees no new evidence. That is the specialization question, not this one.

Narrowing those sets exposed a hole in Simple's optimistic pass. `Opto.sccp` asserts no type falls
below its pessimistic type, but loop widening is order-dependent: `JsArrayUnshift`'s argument-count
Phi saw `[0..3]` and then `[0..4]` at its last widen stage and jumped to the declared `int`, where the
pessimistic pass had met `[0..4]` first. During the optimistic pass (`optimistic-pass?`, set only
around the SCCP worklist, when the graph is frozen) a falling loop Phi or recursive Parm whose widen
stages are spent now lands on its pessimistic integer range when the new range lies inside it
(`phi-widen-bound`, aot.node.phi), and on the declaration otherwise. The landing point is still
fixed, so termination is unchanged, and it is sound because the pass started from it on the same
graph.

## 2026-09-16 — Calls through image function objects link their one callee

A call through a built-in — `console.log(x)`, `Function.prototype.call` — loads the code word of a
function object in the static image and calls through it. That word was typed as its declaration
says: every value-taken function in the program. The call was therefore linked to all of them, and
the optimistic fixpoint merged that site's arguments into every one of their parameters.

A code-word `Load` from a `StaticRef` function object is now typed as the single function the image
stores there (`load-image-code-fidx`, aot.node.memory). Code words are written only when a fresh
function object is allocated, never through an image object, so the image's word holds for the
whole run. Call idealize already links a call whose pointer type is a singleton.

Simple never peeks constant object data: `LoadNode.compute` types a field by its declaration joined
with memory, and leaves "if offset is known, can peek the constant" as a TODO. The divergence is the
one the image prototype-word fold in `load-idealize` already made, for the same reason — image
objects have no Store in the graph to fold through.

This is the first and smallest piece of whole-program call resolution. It does not yet reach the
calls that most widen a function's types: a call through a function read from an object's property
(`valueOf`, `toString`, an accessor's `get`) is still linked to every value-taken function, because
that set is not keyed by the property the function was stored under.

## 2026-09-16 — A well-known Symbol is one identity in an assembled realm

A realm assembled from separately compiled units — the test262 runner's cached harness bundle and
each test, or any retained Scripts — binds each unit's intrinsic objects to the first unit's by
name, then unions their initial properties. Well-known Symbols were not named identities, so every
unit that materialized `%Symbol%` brought its own `Symbol.iterator`, and the union found one
property with two values that are not SameValue. That single conflict was **6,958 of the 9,252
compiler errors** in the full test262 campaign (docs/TEST262.md).

A unit now publishes each well-known Symbol it allocated as an `IMAGE-REALM-SYMBOL` identity,
named by its description, from a registry of its own (`heap-set-well-known-symbol!`). It is kept
apart from the intrinsic registry because that list is also what the image analysis treats as a
prototype a fresh object may carry, and a Symbol is not one. The assembler binds later copies to the
first like any intrinsic, but **a Symbol never enters the property merge**: it has no properties,
and its 16-byte payload is the same size as an ordinary object's, so the merge would otherwise read
its description as a prototype and refuse it.

Fixing identity exposed the next layer, which was already wrong and hidden behind the panic: **a
Symbol's payload holds the key it is, as the compiling unit's own key id.** Assembly remaps the
shape word in every image header but no payload word, while each unit's code reaches keys through
its own key map, so `o[Symbol.iterator] = f` and a `for-of` over `o` read different keys in an
assembled realm. The published Symbol identities say exactly which payloads carry a key, and
assembly now remaps those (`image-remap-symbol-keys!`). A single program never saw either problem:
its local ids are the program's.

## 2026-09-16 — Date, and what non-tail recursion costs

A Date is **one number** — milliseconds since the epoch, in an internal slot — and the whole
calendar is arithmetic over it, exactly as §21.4.1 defines it. The host is asked for two things and
nothing else: the clock (`%DateNow`) and the local zone's offset (`%LocalTimeZoneOffset`).

**The offset is asked per instant, not once.** A zone with daylight saving has two offsets a year,
and which one applies depends on the instant being converted, so `localtime_r` is called with the
second being converted rather than with "now". Local time is `t + offset(t)`, and every local
accessor is the UTC one over that shifted number. The inverse is approximate where an offset
changes — a local time inside a spring-forward gap has no instant and one inside the autumn overlap
has two — which is what every engine does.

Every division floors rather than truncating, because an instant before 1970 is negative and
truncation toward zero puts it in the wrong day, hour and year. `new Date("1969-07-20T20:17:00")`
is the test that catches it.

**Non-tail recursion in a JSL definition is a compile-time catastrophe.** `JsDaysBeforeMonth`
accumulated on the way *back out* of its recursion — the only definition in the file that was not
tail recursive — and compiling a program that could merely reach it took **over ten minutes of CPU**
instead of under a second. Rewritten with an accumulator, the same program compiles in 0.85 s. The
tail-recursive walks beside it (`JsDateDigitsFrom`, `JsYearCorrect`, the month walks) were never a
problem. Two related shapes cost time the same way and are worth recognizing: a recursive helper
that calls another helper **twice per level** doubles at every level, and a field accessor that
recomputes the year search in each of its arms pays for it once per arm.

## 2026-09-16 — Map and Set

A Map's entries are two arrays under internal slots — the keys and the values at matching indices —
and a Set's are one. That representation gives three things for free: **insertion order**, which is
what the specification's iteration order is; `size` as the array's length; and a `delete` that
removes rather than tombstones, so nothing has to remember holes.

What it does not give is a hash: a lookup is a **scan under SameValueZero**, so a large Map costs
what a scan costs (docs/GAPS.md — collections). A hash would need a stable hash for an object, which
is its address — and a moving collector is free to change that, so it is a design of its own.

`size` is an accessor, which is only possible because the realm image can hold one
(docs/DECISIONS.md — image accessors); a method would be observably wrong.

The iterators are array iterators over a **copy** of the entries. The specification's Map iterator
follows insertions made while it is being walked, which needs a live cursor into the entry list;
that is recorded as a gap rather than pretended.

## 2026-09-16 — Image accessors

The realm image held no accessor property, and `heap-define-own-key-attrs!` panicked on one,
because two compiler types assume it: `prop-attrs-ty` narrows an attribute word to [-2..7] and
`prop-get-ty` to a plain value, so a site's accessor arm — `attrs < 8`, and the exception sentinel
test — folds away entirely while the program can define no accessor. That invariant made every
specification getter unreachable: `Symbol.prototype.description`, `Map.prototype.size`,
`RegExp.prototype.flags`. A getter is observably not a method: `s.description` reads without a
call, and its descriptor has `get`, not `value`.

An intrinsic declaration now has a third row kind beside `method` and `data`:

    (accessor "description" :target prototype :get JsSymbolDescriptionMethod :configurable true)

The row's getter becomes an ordinary image function, and the property's value is the **pair object a
descriptor holds** — `get` and `set`, in that order — with the accessor attribute set, exactly what
a getter defined at run time produces. An accessor property has no writable bit, so only enumerable
and configurable survive from what the row declared.

**Defining one marks descriptors for that realm.** The accessor arms stop folding, which is the
honest price: the image really can answer an accessor now. It is paid narrowly because intrinsics
materialize on demand — a program that never reaches such a property never builds the row, and
keeps the narrow types.

Doing this exposed a second bug, older than the feature: **GetV on a primitive receiver resolved on
the prototype and then called an accessor with the prototype as its receiver.** A string, boolean,
Symbol or number receiver now goes through `JsGetFromHolder`, which carries the original value, so
`s.description` sees the Symbol rather than `%Symbol.prototype%`.

## 2026-09-16 — JSON

`jsl/compiler/json.jsl` is `jsl/json/stringify.jsl` and `jsl/json/parse.jsl` brought into the
compiler's JSL. The structure and the decisions are theirs and are kept: the serializer's **omission
sentinel** (a serialized value is a tagged string, or tagged undefined for a value the surrounding
object must omit, which an array turns into the token `null`), **cycle detection by a stack** of the
objects on the path from the root, and a parser in which **every arm returns the value it read
together with the cursor it stopped at**, as a two-element array, so mutually recursive arms keep one
shape. What changed is the vocabulary: a loop is recursion into a named definition, a completion
travels as the exception sentinel rather than a `%Throw`, and property access goes through the
`JsGetKeyed`/`JsSetKeyed` entries the rest of the compiler's JSL uses.

The parser implements JSON's grammar, not JavaScript's: `{a:1}`, `[1,]`, `01`, `'x'`, an
unterminated string, trailing junk after a complete value, and a truncated keyword are each a
SyntaxError. A number is validated here and converted by StringToNumber over its exact substring.

`stringify` reads **keyed** and filters by enumerability, for the reason CopyDataProperties does.
The `replacer` (function or key-selecting array), the `reviver` and `space` all apply. A reviver
walks an array over its indices rather than its own property names, because `length` is an own
property and reviving it would resize the array.

**The serializer carries its state as ordinary parameters** — the cycle stack, the replacer, the
property list, the indent unit and the current indent — rather than bundling them into one object.
That is not a style choice: a value that has been through an array slot is any dynamic value again
and carries no representation proof, so the typed `arr` and `str` parameters are what let the body
concatenate and index without a guard at every use. Bundling them cost six proofs and three
compiler refusals before this was clear.

Two rules of the JSL checker shaped the rest: a **completion cannot be passed as an argument**, so
`toJSON`'s result is tested before the replacer sees it — which is also the order the specification
applies them in; and **a receiver's family does not cross a call boundary**, so the holder is
tested to be an object where a call passes it as `this`.

## 2026-09-16 — The built-ins a program reaches for first

`Array.prototype.sort` is a **merge sort**, because the specification requires a stable one: the
merge takes the left element whenever the comparison is not positive, and that is the whole of
stability. A comparator is user code, so every comparison can throw, and a completion stops the
sort where it happened rather than writing back a partial order. Holes and undefined both move to
the end, in that order, and they get there by construction: only present elements are collected,
SortCompare sorts undefined after every value, and the write-back leaves the positions past the
collected elements as holes.

`keys`, `values` and `entries` are one array iterator with an iteration kind in a third internal
slot, as CreateArrayIterator has. An iterator is also its own iterable — %IteratorPrototype%'s
`@@iterator` returns `this` — which is what makes `for (const k of a.keys())` and
`[...a.entries()]` work at all; without it a `for-of` over an iterator raises "not iterable".

`Array.from`, `Object.entries`, `Object.values` and `Object.assign` all read **keyed**, for the
reason CopyDataProperties does: an array's elements and a string's code units are own properties a
named read cannot reach. `Object.assign` sets rather than defines, so a setter on the target runs;
a spread defines, so it does not. `Array.from` prefers the iterator and falls back to `length`,
and a mapper that throws closes the iterator, as IteratorClose requires.

`Array.of` is variadic, so — like `console.log` — its code is the callable ABI itself. An intrinsic
method whose parameters are all `dyn` cannot see how many arguments arrived, which is the
difference between `Array.of()` and `Array.of(undefined)`.

## 2026-09-16 — CopyDataProperties: object spread and object rest

`{...o}` in a literal and `{a, ...rest}` in a pattern are the same abstract operation
(CopyDataProperties, §7.3.25) and share one implementation in `jsl/compiler/object-rest.jsl`. It
**copies**, it does not alias: an accessor on the source is read once and the target holds the
value it returned, as a writable, enumerable, configurable data property.

**The read is keyed, not named.** An array's elements and a string's code units are own properties
that `JsGetNamed` does not reach — it answers only `length` and named properties — so the copy
reads each own key with `JsGetKeyed`. `{...[7, 8]}` gives `{0: 7, 1: 8}`, and `{..."hi"}` gives
`{0: "h", 1: "i"}`, both without the array's or string's `length`, which is not enumerable.

**What is excluded is a key identity, not a spelling.** A pattern builds its exclusion list as it
reads, pushing the key id each property was read under, so `{[k]: v, ...rest}` converts `k` exactly
once and `rest` omits whatever that conversion named. Symbol keys are copied by neither path yet,
because nothing enumerates them (docs/GAPS.md — property enumeration).

A spread in a literal ends the literal's fixed layout, the way a computed key does, and copies onto
the raw object under construction — which is why it has its own entry (`JsCopyLiteralProperties`)
that boxes that object, as the literal's accessor and computed-key definitions do. Later properties
of the same literal are defined after the copy and overwrite what it brought in, which is what
source order says. A rest property in a pattern instead creates a fresh ordinary object; unlike a
spread, it raises a TypeError on undefined or null, because a pattern requires something to copy.

## 2026-09-16 — Optional chains

`a?.b.c(d)` evaluates `a` once, and if it is null or undefined the value of the **whole chain** is
undefined: the `.c` read does not happen, the call does not happen, and `d` is never evaluated. The
short-circuit spans the rest of the chain, not one link, which is what decides the lowering.

A chain is therefore lowered as a **list of links**, not by recursing on the syntax tree. The base
is the operand of the first `?.` and is lowered by the ordinary expression walk, so a direct call,
a `super` base or an intrinsic keeps the lowering it would have had. Each link is then applied to
the value the chain holds; a `?.` link first opens a Scope diamond on `JsNullish`, whose nullish arm
is an *arrival* that leaves the chain with the Scope it left in. Every arrival merges into one
Scope, which meets the live path at a single merge past the last link, where a Phi selects the
chain's value or undefined. That is `break` arriving at a loop's exit, spelled for an expression.

A call link's receiver is the base of the member access it follows, so `a?.b(c)` calls `b` with `a`
as `this`, and `(a?.b)(c)` — where the group ends the chain — calls it with undefined. The group
boundary is already what `syntax-optional-chain?` respects, so a parenthesized chain is a complete
chain whose result feeds an ordinary access.

`delete a?.b` still refuses by name: the chain produces a value, and `delete` needs the Reference
the last link would have produced.

## 2026-09-16 — Destructuring

A pattern is a *binder driven by a value*, and the same walk lowers every form the grammar admits:
`let`/`const`/`var` declarations, formal and rest parameters, `=` assignment targets, `for (… of …)`
heads and catch clauses. `lower-pattern-bind!` takes the pattern, the node holding the value it
destructures, and a mode — `PATTERN-LET`, `PATTERN-VAR`, `PATTERN-ASSIGN`, `PATTERN-PARAM` — which
decides only what a *leaf* does: initialize a lexical binding, write a `var`, PutValue a Reference,
or define a parameter slot. Nothing else in the walk varies, so a nested leaf behaves the same
however deep it sits, and a new pattern position costs one call.

**An object pattern reads properties; an array pattern drives the iteration protocol.** That is the
specification's distinction and it is observable: `let [a] = o` calls `o[Symbol.iterator]`, and a
pattern with a hole still steps the iterator over the hole. The array walk is `JsDestructureState`
plus `JsDestructureStep`/`JsDestructureRest`/`JsDestructureClose` in `jsl/compiler/iterator.jsl`, so
the iterator is closed when the pattern is shorter than the iterable, exactly once.

A default is applied where the specification applies it — to `undefined` only, after the read or the
step, and per leaf — which is why a parameter's own default is applied to the slot value *before*
the pattern walk rather than by the name-update path a plain parameter uses.

Every pattern position throws: a property read, a `next` call, a ReferenceError from a leaf. The
syntactic may-throw filter therefore counts a destructuring declaration, a destructuring assignment,
a function with pattern parameters, and a destructured catch parameter — the last because the
binding runs in the handler, which its own `try` does not protect.

Object rest (`{...rest}`, CopyDataProperties) is not lowered yet and refuses by name.

## 2026-09-16 — A Script's lexical bindings belong to the realm

`let`, `const` and `class` at a Script's top level were Scope values of the Script's own initializer
in a closed program, so a function of that Script could not see them: `class C {} function f() { new
C(); }` refused by name. That is most of what a real program looks like.

**Both unit kinds now do what the reusable one already did**: the Script root creates a realm lexical
binding for each of them, its declaration initializes that binding, and every read and write names it
— by slot where the initializer knows it, and by key from a function, which is a runtime lookup that
raises the dead zone's ReferenceError and a `const` write's TypeError where the specification says.
The Scope keeps only an initialized `const`'s value, as a cache that its own initialization
dominates.

The syntactic may-throw filter counts a Script-lexical read, because the dead zone is a real
completion rather than a compile-time refusal.

## 2026-09-16 — Iteration

`for-of` refused, and with it spread and array destructuring, because the protocol did not exist.

**Nothing is privileged.** GetIterator reads @@iterator, calls it, and requires an object; `next` is
read once, as §7.4.2 does, so a later assignment to it is not seen; each step calls `next` and reads
`done` and `value` with ordinary property access. A user object with those two methods drives the
loop exactly as an array does — the built-in array iterator is one implementation of the protocol,
not a fast path beside it (`jsl/compiler/iterator.jsl`).

**The loop closes the iterator exactly when it leaves early.** A compiler-only binding is true on
every path through the body and false on the path the exhausted iterator takes, so at the loop's
exit it is the Phi that says whether control left early — and `break` reaches the exit carrying
true. An iterator that answered `done` is already finished and must not be returned to (§7.4.9).

**An internal slot is a key nothing can name.** The array iterator's array and index live in
properties under keys the compiler mints for the purpose (`%InternalKey`), which are Symbol-flagged
keys with no Symbol value: no name reaches them, `getOwnPropertySymbols` cannot produce them because
there is no Symbol to produce, and enumeration passes over them. The brand check `next` performs is
the presence of the first of them, which is what RequireInternalSlot is.

**A key is an identity, and the tables now agree on that.** Shape transitions, the image's property
definitions and the property-store folds all take a key id rather than a name; rebuilding a
transition path from names would have given a Symbol's key a string key of the same label, which is
exactly what it did until the iterator's slots appeared as ordinary property names.

**Spread is the same walk.** `[0, ...xs, 1]` appends every value the iterable yields, so the literal
stops using its syntactic index once a spread has run and every later element lands at the array's
own length. `f(...xs)` builds that array and calls with it (`JsCallWithArray`), which is the path a
bound function's call already took — a spread makes the argument count a runtime question, and the
fixed slots cannot carry one.

**%ArrayIteratorPrototype% is a declared object with no global binding** (`:anonymous`), registered
under the name JSL asks for, and `Array.prototype[@@iterator]` is a method row whose key is a
well-known Symbol (`:symbol`). `Array.prototype.values` is not declared yet: it must be the same
function object as the @@iterator method, which needs an alias row, and two distinct objects would
be a wrong identity rather than a missing one.

## 2026-09-16 — The console

A compiled program could not say anything: it had an exit code and an uncaught error, and no output.

**`%HostWrite` is the whole host surface**: a string's code units and a stream. What a value looks
like is decided in JSL, where ToString is — a string prints itself, a Symbol its description (ToString
of one throws, and printing is not the place to raise it), and everything else converts, so an array
joins and a plain object is "[object Object]". A richer rendering is an inspector, which is its own
feature.

**`console.log` is variadic because its code is the callable ABI** (`jsl-definition-abi?`): it sees
the call's own argument count, so `log()` writes an empty line, which a fixed slot count could not
distinguish from `log(undefined)`.

`globalThis` is the global object itself, defined in the image as a property of its own carrier and
resolved by name the way `undefined`, `Infinity` and `NaN` already were.

## 2026-09-16 — What the well-known symbols decide

Three of them now decide what the specification says they decide, which is what makes them values
rather than declarations: **@@toPrimitive** is looked up before OrdinaryToPrimitive, called with the
hint as a string, and a result that is still an object is a TypeError; **@@hasInstance** lets a right
operand of `instanceof` answer the question itself, with OrdinaryHasInstance's prototype-chain walk
reached only when the operand has none — and a non-object right operand is now the TypeError §13.10.2
gives it, before any callability question; **@@toStringTag**, when it is a string, is the tag
`Object.prototype.toString` reports, and every other value falls through to the builtin tag.

## 2026-09-16 — Well-known symbols

**Each is one image allocation.** `Symbol.iterator` and its twelve siblings are declared as data rows
whose value form is `(symbol "description")`: the realm image builder makes one Symbol entry per
declaration, so the value has the identity the specification requires for the program's life, and
the row's attributes are the specification's — neither writable, enumerable nor configurable.

**Their property key is the compiler's.** A property defined under `@@iterator` has to be image data
— `Array.prototype[@@iterator]` is — so the key cannot wait for the program to start: the compiler
mints one per well-known Symbol (`shape-key-intern-symbol!`) and the Symbol's image payload carries
it. A Symbol created at run time still mints its key on first use, because nothing in the image
refers to it.

**One flag bit carries it through every table.** A key record is an offset and a length, in the
compiler's table, in the shapes blob and in a compilation unit's own table; the high bit of the
length marks a Symbol's key, which no name length can reach. The readers mask it off before reading
the name, name interning skips flagged keys so no source name can collide with a label, and the
compilation-unit importer carries the flag across the link — without which two units interning the
same label would merge a Symbol's key with a property name.

## 2026-09-16 — Symbol keys

**A Symbol's property key is minted with the Symbol.** The shape tree transitions on key ids, and a
Symbol needs one that no name can collide with, so a Symbol takes a fresh id from the runtime key
table when it is created and carries it in its payload's second word — a raw integer beside the
description, so the word the collector scans is never a reference it would have to forward. The id
is stable for the Symbol's life, which is what makes `o[s]` the same property every time, and two
Symbols with the same description take different ids, which is what makes them different keys.

**Enumeration is the whole observable difference.** A Symbol-keyed property is an ordinary own
property — defined, read, written and deleted through the same shape machinery as any other — but
the key table marks its id as a Symbol's, and the own-keys walk passes over those before it asks for
a name. `Object.keys`, `Object.getOwnPropertyNames` and `for-in` therefore do not see it, and
nothing a program can write as a name reaches it. `Object.getOwnPropertySymbols` needs the reverse
mapping, from key back to Symbol, which the table does not hold yet, so it is still absent.

**Static keys are still names only.** The compiler's key table, which the shapes blob carries, has
no Symbol ids: the well-known symbols will need them, and that is a blob format change rather than
something to approximate here.

## 2026-09-16 — Symbol values

`Symbol` was an undeclared global, and the whole family — the iteration protocol, well-known
symbols, symbol-keyed properties — rests on the value existing first, so this is the value alone.

**A Symbol's identity is a traced allocation.** The NaN-box family was already reserved
(`DYNAMIC-PREFIX-SYMBOL`); a Symbol is a payload under it holding the description it was created
with, and nothing else. Two Symbols are the same value exactly when they are the same allocation, so
strict equality is the tagged-word identity every non-number, non-string value already uses, and the
collector forwards the word like any other reference. `%NewSymbol` allocates one and `%Box` tags it
from the payload type, as it does for strings, functions and arrays.

**Its methods are found the way a string's are.** A Symbol is a primitive with no wrapper object
here, so a property access on one resolves on %Symbol.prototype% directly (GetV without the wrapper
ToObject would make), which is exactly how a primitive string, boolean and number already reach
theirs.

**Converting one is a TypeError, and that belongs to the operators.** ToString and ToNumber of a
Symbol throw (§7.1.17, §7.1.4), but `JsToString` is total — it returns a string and never a
completion — so the refusal lives where a completion can carry it: `JsToStringValue`,
`JsToNumberValue`, and a conversion step the binary operators now share
(`JsEitherNeedsConversion`/`JsBinaryConversion`), which is the same place an object operand leaves
the numeric cores. `+` names the string conversion in its message and every other operator the
numeric one, as engines do.

Symbol-keyed properties, well-known symbols, `Symbol.for`/`keyFor`, `description` and a Symbol
wrapper object are the next stages; a Symbol used as a property key still refuses by name.

## 2026-09-16 — Computed property keys

`{[k]: v}` and `class C { [k]() {} }` refused by name. A computed key is an expression evaluated
where it is written, and its conversion to a property key is the only part that can fail — an object
key goes through ToPrimitive with the string hint — so that conversion is one definition
(`JsComputedKeyPrimitive`), and the interning at each definition site cannot throw. The syntactic
may-throw filter counts a literal with a computed key, as it already counted a class.

**A class evaluates every element's key in element order** (§15.7.14 step 25), which is why the keys
are computed in one pass that also defines the methods, and kept for the static fields and blocks
that run afterwards. An instance field's computed key still refuses: it is evaluated once, where the
class is, and a construction would have to read it back from the class.

**A computed key stops the literal's fixed layout**, as an accessor already did: the shape plan
covers the keys the compiler knows, and every definition after an unknown one is ordinary. A
computed `__proto__` is a data property, never the literal's prototype, which follows from the same
split.

## 2026-09-16 — Closures: environment records

A nested function that mentioned a binding of the function around it refused by name. Simple has no
closures, so this is designed here.

**A captured binding stops being an SSA value.** Two functions share it and either may write it, so
it moves into the activation's *environment record*: an array whose element 0 is the enclosing
environment and whose other elements are that activation's captured bindings, in the order the
capture pass assigned (`jsl/compiler/environment.jsl`). The binding is still an ordinary Scope
binding in the parser — it just carries the slot it lives in (`Var.env-slot`), so every read and
write of it goes to the slot and shadowing, blocks and merges keep working unchanged.

**The function object carries the environment, and the callee slot carries it back.** A closure is
allocated with the creating activation's environment in its environment word — the same word a bound
function's record and a method's home object use — and a body that mentions a captured binding reads
it back through the function object its entry was passed in the hidden callee slot, which is exactly
the mechanism `super` already used. A record that only encloses a capture forwards the environment
it was called with rather than allocating one, so the chain has one link per activation that owns
bindings and a read walks a fixed number of links (`JsEnvAncestor`).

**Capture is decided before lowering, by one sweep.** Every record's own references — its nested
records excluded, since they ask for themselves — are resolved against the records enclosing it
(`syntax-compute-captures!`). A parameter, a `var`, a body function declaration, a body-level `let`,
`const` or `class`, and an arrow's `this` are all activation bindings, so each gets a slot. A binding
of an enclosing *block* is not: a block inside a loop has one per iteration, which one slot cannot
model, and capturing it still refuses by name.

**An environment is compiler state, not a JavaScript value.** Nothing in a program can name one, so
a word that is not an environment record is a failed invariant, not a completion: the accessors trap
(`%TrapInvariant`) instead of throwing, and reading a captured binding is an ordinary value. The one
exception is the temporal dead zone — a captured `let`, `const` or `class` has an *empty* slot until
its initialization, and reading it there is a real ReferenceError (`JsEnvSlotInitialized`), which
the syntactic may-throw filter accounts for.

**A lattice repair fell out of it.** Meeting a high dynamic set with a low one produced the right
set of tags represented as a *high* type, which left the meet above one of its own arguments;
`ty-isa?`, which asks whether the meet is that argument, then answered no, and SCCP's pessimistic
bound check turned a legal optimistic state into a panic wherever a call's target set widened during
the optimistic pass — reachable before this work through a derived constructor or an arguments
object. A meet with anything below the centreline lands below it, so the mixed meet is now the low
set of the union of both denotations (tests/type-test.coil).

## 2026-09-16 — Class fields

**A field initializer is a function, and it is called.** An initializer sees `this` and the names
around the class, but not the constructor's parameters or body bindings, so it cannot be inlined
into the constructor: each initializer keeps the record the parse gave it, and the constructor calls
that record's entry directly with the field's object as the receiver and no arguments
(`lower-receiver-entry-call`). A field with no initializer defines undefined without calling
anything. The value is then CreateDataPropertyOrThrow'd — writable, enumerable, configurable —
on the object (`JsDefineField`).

**The constructor knows its class.** A constructor record carries its class's index
(`class-index`), which is what makes InitializeInstanceElements compilable: the field list is
static, so the constructor defines exactly its own class's instance fields, in declaration order.
A base constructor does it at entry, before its body (§10.2.2 step 8); a derived constructor does it
where `super()` binds `this` (§13.3.7.1 step 8), at each `super()` in the body and in the
synthesized default derived constructor — never both, because only one `super()` can run.

**Static fields and static blocks run at class definition, after every method.**
ClassDefinitionEvaluation defines all the methods first and only then evaluates the static elements
in declaration order — a field's initializer and a static block alike, each called with the
constructor as its `this`, a block's value dropped — so a static element sees the finished prototype
and constructor and the static elements before it.

`super` in a field initializer or a static block (each needs its own home object), computed field
keys and private elements refuse by name.

## 2026-09-16 — Home objects: super property access in methods

**A method's home object is its function object's environment word.** MakeMethod (§10.2.7) gives a
method a [[HomeObject]], and `super.x` reads from the object *above* it. The word a bound function
uses for its bound record (docs/DECISIONS.md, builtin closures) carries it: `lower-method-object`
allocates the function object with the home object as its environment, and `JsSuperBase` reads it
back with `%ClosureEnv` and answers its [[Prototype]]. Nothing else in a function object changes,
and a function value with no home object keeps the null environment it had.

**The running method reaches its own function object through the callee slot.** A body naming
`super` marks its record `needs-home`, which implies `needs-callee`: its entry passes the function
object in the hidden slot after the formals, exactly as a derived constructor's `super()` already
did. The mark is made where `super` is parsed, on the nearest non-arrow context's record
(`parser-ctx-needs-home!`), so it is fixed before any entry is lowered.

**A super reference is an ordinary reference with two objects.** `SyntaxRef` gains the base and the
receiver: the base is the object above the home object, the receiver is the method's own `this`, and
every form follows from that pair — `super.x` is [[Get]] on the base with that receiver
(`JsSuperGet`), `super.x = v` is [[Set]] on the base with that receiver, so an inherited setter runs
on `this` and a plain assignment creates the property on `this` and never on the base
(`JsSuperSetViaHolder`, OrdinarySet's walk with a receiver that is not the object it starts from and
need not be an object at all), and `super.m()` is that [[Get]] called with `this` — never with the
base — as its receiver. The order is the specification's: `this` (a derived constructor's must be
initialized), then a computed key, then the base.

**The class's prototype object now precedes its constructor**, as §15.7.14 has it, because the
constructor's own home object is that prototype: `JsNewClassPrototype` makes it, the constructor is
allocated with it, and `JsLinkClassPrototype` (`JsLinkDerivedClass` with a heritage) then links the
two. A class constructor therefore skips MakeConstructor's fresh `prototype` — the class's prototype
object is the one it gets, and the throwaway allocation is gone.

`super` outside a class method — an object literal's methods, and an arrow's inherited `super` —
refuses by name, as do fields, static blocks, computed keys and private names.

## 2026-09-15 — Derived classes: extends and super()

**A body that needs the call itself gets hidden slots.** The slot after a record's formals, which an
arguments object and a rest parameter already used, is now a list: the call's actuals (or its
arguments object) and then the function object being called (`JsCallCallee`). A derived constructor
needs the latter, because `super()` constructs the *running constructor's* [[Prototype]] — the class
it extends — which is reachable only from the constructor itself (`syntax-fun-hidden-count`,
`syntax-fun-callee-slot`). A call of such a function goes through its entry, which is the only place
those operands exist.

**A derived constructor's `this` is a binding.** It has [[Construct]] without the base bit, so the
receiver `new` creates is undefined and the binding starts uninitialized; `super()` constructs the
parent with the call's arguments and the running `new.target` (`JsSuperConstruct`) and binds the
result, and a second `super()` in the same constructor is a ReferenceError, as is reading `this`
before one (`JsRequireThisInitialized`). A constructor's result is an object it returned, else its
`this` for a base constructor and, for a derived one, its bound `this` — a returned primitive being
a TypeError (`JsConstructorResult`). The class with no `constructor` element gets the synthesized
`constructor(...args) { super(...args); }`, whose body is lowered from those slots directly.

**The heritage links both chains.** `extends` evaluates to a constructor or null: its `prototype`
heads the class's prototype object, and it heads the constructor itself, so static members are
inherited (`JsClassHeritagePrototype`, `JsMakeDerivedClassPrototype`). `extends null` gives a
prototype object with no prototype and leaves the constructor on %Function.prototype%.

`super.x` in a method (its home object), fields, static blocks, computed keys and private names
still refuse by name.

## 2026-09-15 — Base classes

`class` refused as "class definitions", which was the largest implementable blocker of the campaign.

**A class is its constructor function object.** ClassDefinitionEvaluation (§15.7.14) for a class with
no heritage: the constructor is the `constructor` element's record, or an empty one the parse
synthesizes so that every class has exactly one (`syntax-class-constructor-record!`, the record
carrying `class-ctor`). It is an ordinary function value with [[Construct]] and a base constructor's
own `this`; what makes it a class is that its body begins by throwing a TypeError when `new.target`
is undefined (`lower-class-constructor-entry!`), which is a class constructor's [[Call]], so the
check holds through every call path — a direct call, a value call, `Function.prototype.call`. The
syntactic may-throw filter therefore counts every class constructor as throwing.

**The members are definitions, not stores.** `JsMakeClassPrototype` (jsl/compiler/class.jsl) makes
the prototype object on %Object.prototype%, links `constructor` (writable, configurable) and
`prototype` (neither writable, enumerable nor configurable), and each method, getter and setter is
defined non-enumerable on that prototype, or on the constructor when it is static — an accessor
keeping the other half of one already defined, as an object literal's does. A class declaration
binds its name as a Script lexical like `let`, which the shared-realm image now carries
(CU-SCRIPT-CLASS); a class expression's value is the constructor itself.

`extends` and `super`, fields, static blocks, computed keys and private names refuse by name, each
naming what it is. The class's inner binding of its own name is the outer one, which is observable
only by reassigning it (docs/GAPS.md).

## 2026-09-15 — Default and rest parameters

A parameter list that was not simple refused whole ("default, rest, generator and async functions").

**A default is a branch in the prologue.** Each parameter binds its actual, in order, and a
parameter with an initializer then binds the merge of its actual and the initializer's value,
evaluated only where the actual is undefined (`lower-parameter-default`) and in the Scope where the
parameters before it are already bound — so `function f(a, b = a)` sees `a`, and an explicit
`undefined` takes the default, as the specification says. Because that merge replaces the live
Scope, every later parameter binds into the Scope the merge produced, not the one the body started
with. A default is an expression of its function, so the syntactic may-throw filter walks it.

**A rest parameter takes the call's actuals from the hidden slot.** The slot after the formals —
the one an arguments object already used — is filled by the entry with the call's actuals as an
array (`JsCallArgumentsArray`), and the body binds the rest name to the elements from the formal
count on (`JsRestFrom`). A direct call cannot fill that slot, so a call of such a function goes
through its entry, exactly as a call of a function with an arguments object does
(`syntax-fun-hidden-builtin`).

Destructuring parameters, generators and async functions still refuse by name, and a non-simple
list still has no arguments object (its unmapped `callee` needs %ThrowTypeError%).

## 2026-09-15 — Object literal methods and accessors

`{ m() {} }`, `{ get x() {} }` and `{ set x(v) {} }` refused as "object methods and accessors".

**A method is a function value without [[Construct]].** Method, getter and setter records are
admitted as function values like expressions and arrows (`syntax-fun-value-admitted?`): the same
Fun, adapter and function object, with no flags word bit and so no `prototype`. `super` inside one
still refuses where it is written, since a home object is the class slice's concern; class elements
stay unlowered until classes exist.

**Definitions keep source order.** A method is a data definition of its function object, like
`key: value`. An accessor is `JsDefineLiteralAccessor` (`jsl/compiler/literal.jsl`): an enumerable,
configurable accessor over `JsAccessorPair`, which keeps the other half of an accessor the key
already holds, applied by the define path `Object.defineProperty` uses. A data definition of a key an
earlier accessor defined replaces it through a full data define (`JsDefineLiteralData`). The fixed
literal layout (`lower-object-literal-layout`) plans data slots only up to the first accessor, so
every later key is added after it at run time and insertion order is the definitions' order.

## 2026-09-15 — Remainder, exponent, bitwise and loose equality operators; template substitutions

`%`, `**`, `&`, `|`, `^`, `~`, `<<`, `>>`, `>>>`, `==` and `!=` were admitted syntax that refused by JSL
entry name, and a template with a substitution refused as "template substitutions (ToString)".

**The Number operations are the runtime's.** Number::remainder, Number::exponentiate and the
bitwise and shift operators over ToInt32 and ToUint32 are `aot.rt.number` operations reached through
the existing `%MathBinary` and `%MathUnary` tables (MATH-OP-REMAINDER, BITAND … USHR, BITNOT):
remainder is C `fmod` after the specification's NaN, infinity and zero cases, since `fmod` is the
truncating remainder whose sign is the dividend's; ToInt32 truncates and reduces modulo 2^32. This
deliberately does not reuse the compiler's internal i64 bit and shift nodes, whose semantics differ
(docs/GAPS.md); an int32-typed inline lowering is a later optimization, not a semantic change.
The JSL entries (`JsMod` … `JsUshr`, `JsBitNot`) convert object operands through ToPrimitive first,
as the other source operators do.

**IsLooselyEqual is JSL** (`JsLooselyEqual`): two objects by identity; undefined and null equal each
other and nothing else; an object against a primitive through ToPrimitive with the default hint; a
Boolean as its Number; a Number against a String as Numbers; a Symbol only itself.

**A template's substitutions are ToString'd in order** (`lower-template`, `JsTemplateAppend`): the
first cooked string, then each substitution's value converted at once — through ToPrimitive with the
string hint for an object — and the next cooked string. The may-throw filter counts a substitution.

## 2026-09-15 — ToPrimitive, and the operators that can call user code

Every conversion of an object to a primitive was a runtime refusal (`%TrapToPrimitive`), so `"x" +
String(o)`, `o + 1`, `Math.abs(o)` and `[o].join()` stopped the program. The upstream harness
builds its messages that way (`"… " + String(desc)`), so every `verifyProperty` failed before its
first check.

**ToPrimitive is JSL** (`jsl/compiler/toprimitive.jsl`): OrdinaryToPrimitive over `%CallFunction`,
`valueOf` then `toString` for the number and default hints and the other way round for the string
hint, the first callable one whose result is not an object, else a TypeError. @@toPrimitive waits
for symbols. `JsToStringValue` and `JsToNumberValue` are ToString and ToNumber of any value, as
completions.

**The source operators are their own definitions over the numeric cores.** `JsAdd`, `JsSub`,
`JsMul`, `JsDiv`, `JsLt` and the rest stay what they were — total conversions over primitives, the
smallest production JSL the lowering machinery is tested against. The frontend lowers `+`, `-`,
`*`, `/`, the four relational comparisons and unary `-` and `+` (and the ToNumeric of `++` and `--`)
to operator entries instead (`lower-operator-entry`): `JsAddOperator` and its siblings test for an
object operand and, only then, ToPrimitive both operands in order and apply the core to the
primitives (`JsBinaryOnPrimitives`, `JsUnaryOnPrimitive`); otherwise they are the core. They are
`:throws` and `:transitioning`, the frontend tests the completion of every operator whose entry
throws (`lower-js-binary`, `lower-js-unary`), and where the operands' types exclude objects — every
integer loop, every literal — the object arm folds away and the test with it. The syntactic
may-throw filter asks the same question of each operator's entry (`syntax-operator-may-throw?`),
loading the library first when a function-entry program has not.

The string methods and `concat`/`fromCharCode` convert an object argument the same way: the receiver
checked, each argument ToPrimitive'd with the hint of the conversion the method applies to it, and
the method run again over primitives — spec-equivalent, since ToString(o) is
ToString(ToPrimitive(o, string)) and ToNumber likewise (`JsStringOnPrimitives`,
`JsVariadicOnPrimitives`). The Math functions, `isNaN`, `isFinite`, `parseInt`, `parseFloat`,
`Number()`, `String()`, the Error constructors' message and `Array.prototype.join` convert with the
completion forms directly. A computed member `o[k]` with an object key takes ToObject of the base
first, then ToPropertyKey's ToPrimitive (`JsKeyedOnPrimitiveKey`).

Found on the way: the relational operators compared two strings as Numbers; the operator entries
compare two primitive strings by code units (IsLessThan step 3, `JsRelationalOrder`). And `new Error(m)` defined `message` enumerable; CreateNonEnumerableDataPropertyOrThrow
makes it writable and configurable only.

## 2026-09-15 — Built-in closures, Function.prototype.bind and the arguments object

`propertyHelper.js` binds `Function.prototype.call` at load and reads `arguments.length` in
`verifyProperty`; neither existed, so every test including it failed before its first assertion.
Both need what a formal-slot built-in cannot have: its own function object, the exact number of
actuals, and every actual.

**ABI builtins.** A JSL builtin whose parameters are the callable ABI itself — `(callee this
new.target count vector a0 a1 a2)`, the count and vector by their ABI kinds (`jsl-definition-abi?`)
— is a function object's code directly. Its record has no local body: `callabi-forwarding-adapter!`
builds the public entry, forwarding every operand to the builtin, and that entry is the record's
one function identity (`syntax-fun-forwarding?`, `fidx` = `adapter-fidx`, no local Fun). A method
row may name such a builtin (`bind`). A body computes with the operands through three primitives
that are graph nodes, not runtime calls: `%ArgumentCountInt`, `%ArgumentAt` (a load from the managed
vector, below a count the body tested) and `%ArrayArgumentCount`; and one runtime capability,
`%ArgumentTail`, copies an array's elements from index 3 into a fresh overflow vector, so
`(%CallFunctionPacked f this nt (%ArrayArgumentCount a) (%ArgumentTail a) a[0] a[1] a[2])` calls with
an argument list of any length (`JsCallWithArray`).

**Closures made by the JSL.** `(intrinsic %Name% :entry Builtin)` declares an *entry*: an ABI
builtin with no global binding and no object. `(%MakeClosure "Name" prototype env flags)` allocates a
function object whose code is that entry, on the given [[Prototype]], with `env` in the environment
word Simple's function layout already reserves (docs/DECISIONS.md, function values are heap
objects) and read back by `%ClosureEnv`. The frontend owns the record, its identity and the
value-call pointer type, so the JSL lowering asks it to build the allocation
(`jsl-set-closure-maker!`), and it shares `lower-allocate-function` with source function values; a
closed program materializes the entry at the first `%MakeClosure` naming it, before the value-call
type settles, so the entry is in every code word's finite target set.

**bind.** `JsFunctionBind` is BoundFunctionCreate: a closure over `%BoundFunction%` whose environment
is an internal array `[target, boundThis, boundArgs…]` no program can reach, on the target's own
[[Prototype]], with [[Construct]] exactly when the target has it, then `length` and `name`.
`JsBoundFunctionInvoke` calls the target with the bound `this` and the bound arguments before the
call's own; under `new` it constructs the target with new.target replaced by the target when it was
the bound function. Source functions still have no own `length` or `name` (docs/GAPS.md), so binding
one gives `length` 0 and `name` "bound ".

**The arguments object rides in a hidden slot.** A function whose own code names `arguments` (not
an arrow, not one with a parameter of that name) has one: the local signature gains a slot after the
formals, its adapter fills the slot by calling `JsCreateArgumentsObject` with the call's own
operands, and the body binds it to a compiler-only Scope name that `arguments` resolves to after any
real binding. A direct call to such a function goes through its entry, which is where the call's
operands exist. A sloppy function with simple parameters must get a *mapped* object whose indices
alias the formals; that aliasing is observable only through a write, so this compiler builds the
object once, unaliased, exactly when no write can see the difference: no formal is assigned
anywhere in the function and every mention of `arguments` is the owner of a property read
(`syntax-analyze-arguments!`). A formal assigned, the object passed on, called as a receiver,
written, deleted or rebound refuses by name, as do strict and non-simple parameter lists, whose
unmapped object's `callee` is the %ThrowTypeError% accessor the realm does not declare yet, and an
arrow's `arguments`, a capture.

## 2026-09-15 — delete and for-in

`delete` and `for-in` refused by name, and between them gated about 4,400 test262 files: the
upstream `propertyHelper.js` harness, which `verifyProperty` needs, deletes a property to test
configurability and enumerates with `for-in` to test enumerability.

**[[Delete]] leaves a hole row.** An object's layout is a path in the shape tree, and every field
has the offset its introducing edge fixed (docs/DECISIONS.md, property attributes live in the shape
tree). The image-object folds of `aot.node.property` read and write those offsets without a shape
check under the closed-world facts, so a delete that compacted the store would move fields that
compiled code still addresses. So OrdinaryDelete (`rt-prop-delete`, `%PropDelete`) replays the
object's path with the deleted field's row replaced by a *hole* — a runtime-only row with key zero
and a real offset, memoised per parent like any edge (`shapes-add-hole`, `shapes-delete`) — clears
the word, and moves the store to the new shape id. Every other field keeps its word. Holes that no
field follows are dropped, so deleting the newest property returns to its parent's layout and an
add/delete loop on one key does not grow the object; a marker row (preventExtensions) survives the
replay. The compiler never makes a hole, so the `__aot_shapes` blob is unchanged. V8 answers the
same question with dictionary mode; we do not have one, and an object whose middle properties are
repeatedly deleted and re-added grows its layout (docs/GAPS.md).

Arrays answer their own kinds: an element is configurable and becomes a hole (`%ArrayDeleteIndex`,
`rt-array-delete`), `length` refuses. A primitive base is ToObject without the wrapper: undefined
and null throw, a string refuses its `length` and in-range indices, every other key and every other
primitive answers true. The operator is JSL (`jsl/compiler/delete.jsl`): `JsDeleteNamed` and
`JsDeleteKeyed` (ToObject before ToPropertyKey) pass the site's strictness, and a refusal is a
TypeError only in strict code. A name is DeleteBinding: a function's, block's, enclosing function's
or Script lexical binding, and `undefined`/`NaN`/`Infinity`, answer false without evaluating
anything; a retained unit resolves the Reference first (`JsGlobalReferenceDelete`: declarative
false, object record [[Delete]] on the global object, unresolvable true); a closed program deletes
from its global object, where a declared var or function refuses by being non-configurable. The
one refusal is a closed program deleting an intrinsic's global binding, whose reads this
compilation folds to the intrinsic itself.

The previous `JsArrayDeleteSlot` made a hole by truncating the length to the index and restoring
it, which emptied every later element too; `reverse` and `shift` over holes lost elements. It is
now the element delete.

**A delete is a store to the image analysis.** It marks the pair it touches (a runtime key: the
owner's every key) and sets `facts-deletes?`. With it set, a written key's shape-derived answers —
presence (`HAS`, a holder on the chain), its fixed offset, its attributes — stop folding, exactly as
`facts-descriptors?` already stopped the attribute answers (`facts-layout-unknown?`). A
never-written key still folds: no delete touched it, and hole rows keep its offset. The external
mutation boundary of a retained unit sets the flag with the others.

**for-in lists its keys when the loop starts.** `JsForInKeys` is EnumerateObjectProperties over
the chain: each object's own string keys in OrdinaryOwnPropertyKeys order (an array's present
indices, `length`, its named keys; a string's indices and `length`), each name once — a name met
on a nearer object shadows it further up, enumerable or not — listing only the enumerable ones.
Undefined and null enumerate nothing. The own keys come from one new runtime capability,
`%ObjectOwnNames` (every string key of the shape, non-enumerable included), which also answers
`Object.getOwnPropertyNames`; `%ObjectKeys` and it now order array-index keys ascending before the
insertion-ordered rest, as §10.1.11.1 requires (before, an ordinary object's integer keys came
out in insertion order). The parser lowers the statement as Simple's loop: loop head, predicate,
body on true, continues closed, backedge. The object, the key list and a cursor are compiler-only
Scope names (a dot keeps them out of the source namespace), so their loop Phis come from Scope as
any variable's do. Each iteration asks `JsForInNext` for the first key at or after the cursor the
object still has ([[HasProperty]]), so a key deleted before it is reached is skipped; the cursor
moves past the key before the body runs, so every continue carries it. A `let` or `const` head is
a fresh binding in an iteration level popped before the continues rejoin; a `var` or expression
head is PutValue through a Reference evaluated each iteration. The head's lexical names are in
their dead zone while the object expression evaluates.

The may-throw filter learned both constructs: a delete throws on a nullish base and on a strict
refusal, and a for-in head's per-iteration PutValue can throw in a retained unit.

## 2026-09-15 — The realm is materialized by demand

Which declared intrinsics a closed program's realm holds was a name scan of the source: a member
spelled `push` materialized every `push`, `toString` materialized `Object`, `Number` and `Boolean`,
and a method reached only through a computed key, reflection or an implicit prototype did not exist
at all. It is now a demand fixpoint over the program's own graphs, in three parts:

- **Identifiers.** A root an identifier names is declared during syntax collection, with its
  parent. Any root, a hoisted function in the image, or an external boundary also brings `Object`
  and `Function`, where every declared [[Prototype]] chain ends.
- **Implicit references.** A literal's `%Object.prototype%`, a function object's
  `%Function.prototype%`, and `%IntrinsicPrototype` in a JSL body demand their constructor where
  they are lowered (`parser-demand-intrinsic-prototype!`, the JSL hook `jsl-set-intrinsic-demand!`).
  The record, header, adapter and image objects are built at once; the body waits in
  `pending-bodies`, because a demand arrives in the middle of lowering another body.
- **Observations.** `imagefacts-surface-demands!` runs the image facts transfer before the world
  closes, without publishing facts, and reports every (owner, key) an object-model read or store
  can observe. [[Get]], [[Set]] and holder questions include the owner's image prototype chain; a
  runtime key or a reflection means every key; a TOP owner means every escaped entry.
  `parser-apply-surface-demands!` maps observations to declared rows (a root on the global object,
  a method on a materialized carrier), materializes them, drains the lowering queues, and scans
  again until nothing new is observed (`parser-settle-realm!`).

Two refinements make the scan precise enough to be worth running. It analyses callers as the
closed world will have them: only the process entry and adapters `parser-adapter-open?` keeps open
have unknown callers. Otherwise every Return escapes before closing, and pair forwarding refuses
every generic body. And a key crossing a generic body as a parameter is the finite set of constant
keys its callers pass (`keys--compute`), not a runtime key. Without these, `f.a = 1` materialized
the entire declared surface; with them it materializes nothing late.

Materializing late has three consequences:

- The ABI slot count covers every declared body.
- `.funs`, `.exprs` and `.globals` are reserved up front (`parser-reserve-late-materialization!`),
  because lowering holds pointers into them across a demand. The first version crashed on a freed
  `syntax-fun-ptr`, found with Guard Malloc.
- Value-call code-word Loads and Stores are redeclared to the final function set once the fixpoint
  settles (`mem-redeclare-code-word!`), before any optimization pass computed from them.

An intrinsic record is found by `syntax-find-intrinsic-fun`, never by the name a Script
declaration can shadow. `function Error` shadows the global binding but not %Error%, which
`TypeError`'s chain and the language's own errors still use. Before, a shadowing declaration
silently became %Error%.

## 2026-09-15 — The provider carries the declared surface; clients carry no methods

Separately compiled Script units share one realm, so no unit's view of its own syntax can decide
which built-in methods the realm needs. The shared runtime-library provider
(`pipeline-shared-jsl-image`, `JSL-LINK-PROVIDER`) now materializes every declared root and every
declared method as the realm's canonical identities. Every retained Script unit
(`pipeline-encode-script-unit!`) is its client (`JSL-LINK-IMPORT`): there is no standalone
retained unit, and the source cache always acquires the provider. A client materializes the
foundational chain objects and the roots its identifiers bind, never a method; its method reads,
named or computed, reach the canonical objects through the runtime (external-mutation facts keep an
absent key unfolded), and fresh-realm assembly never unions per-unit method sets. Tests that
assemble retained units by hand bind them to the provider (`tests/library-support.coil`). A
standalone unit carrying the whole surface cost about 3.5 times the machine nodes (17,823 against
the 5,000-node retained-read budget), which is why no unit carries it but the provider.

The full surface costs about 1.4 s to compile, and a test262 worker is replaced after every fatal
refusal, which discards its native cache. So the supervisor primes the source cache with the
compiled provider before forking (`memory-prime-library!`), and every worker inherits a pristine
provider it never has to rebuild. The supervisor never installs or runs it. On a 40-file sample
this took per-request compile time from about 96 ms to 35-50 ms, because the old runner rebuilt its
smaller provider after every replacement.

## 2026-09-15 — A function or an array may be a [[Prototype]]; the JSL answers exotic holders

The prototype word is typed null or object-like (object, function, array) in the checker, the JSL
lowering and the JsOp result types. Before, a function or array prototype left the object unlinked.
Functions need nothing more: their own properties are ordinary shape properties. An Array's
`length` and elements are own properties that no shape records (§10.4.2). So the runtime's
ordinary chain walks (`rt-prop-chain-holder`, `rt-prop-get`, `rt-prop-set`) stop at an Array exotic
prototype whatever the key, as a holder or as the slow-path sentinel. The JSL answers it:
`JsGetFromHolder` reads `length` or a present element and otherwise continues the walk from the
array's prototype; `JsSetViaHolder` completes OrdinarySet from the first holder (an inherited
writable data property, exotic or not, is shadowed by CreateDataProperty on the receiver); and
`JsHasNamedOnChain` answers `in`. `%KeyArrayIndex` (runtime `aot_rt_key_array_index`) says whether a
key's name is an array index. It is not folded, because only these out-of-line paths ask it, and
only after an Array test on the holder.

## 2026-09-15 — [[Construct]] is a flag word on function objects, and `new` is JSL

A function object's payload gains a raw flags word after its environment (`OFFSET-FUNCTION-FLAGS`,
40-byte payload, alias `ALIAS-FUNCTION-FLAGS`). `FUNCTION-FLAG-CONSTRUCTOR` is [[Construct]];
`FUNCTION-FLAG-BASE-CONSTRUCTOR` marks an ECMAScript function whose caller creates `this`
(§10.2.2), which a built-in constructor lacks because it creates its result from NewTarget
(§10.3.2). MakeConstructor sets both for a non-generator, non-async function declaration or
expression; arrows, methods and accessors get neither; a built-in has [[Construct]] exactly when its
JSL declaration is `:constructor`. Only functions with [[Construct]] get a `prototype` object, so
built-in methods and global functions no longer carry one, and the image's per-method
`IMAGE-REALM-OWNED-PROTOTYPE` records are gone. The word is a small integer with no reference
prefix, so the collector's boxed-word test leaves it alone, and it needs no relocation.

`new` was Coil in `lower-new`, which read `F.prototype` before evaluating the arguments and never
checked IsConstructor. It now evaluates F and every argument, then calls `JsConstructReceiver`
(JSL): a value without [[Construct]] is the TypeError; a base constructor's receiver is
`JsOrdinaryCreateFromConstructor(F, %Object.prototype%)`, whose GetPrototypeFromConstructor falls
back when `prototype` is not an object; a built-in's receiver is undefined. `JsIntrinsicError`
creates its object from NewTarget with its own `prototype` as the default. JSL reads the flags
through `%FunctionFlags`, a field load on a proven function.

## 2026-09-15 — The intrinsic surface is JSL `(intrinsic ...)` declarations

The realm's standard globals were a Coil table in the parser (`intrinsic-table`), with Error
prototype fields and Math constants as Coil setup routines and every property's attributes
written inline. That was a hand-built replacement for the declaration format `jsl/intrinsics.jsl`
already used. It now lives in `jsl/compiler/intrinsics.jsl` as `(intrinsic %Name% ...)` forms,
read by `src/jsl/decls.coil` and proved by the checker. Each form gives a `:constructor`,
`:function` or `:namespace` root, an optional `:parent`, and `method`/`data` rows. Every row
states its target, value and `:writable`/`:enumerable`/`:configurable` attributes; an absent
attribute is false. The parser only flattens the declarations and lays them out.

A function's argument-slot count is not declared: it is the builtin's parameter count after the
receiver prefix (three for a constructor or global function, one for a method), so declaration
and body cannot disagree. The checker refuses by name an undefined or macro body, a non-`dyn`
parameter, a missing receiver prefix, a duplicate root or property, and a parent not declared
earlier as a constructor. Number values are decimal strings read by StringToNumber, because JSL
has no float literal.

Syntax collection needs the declarations before any graph exists, so reading them loads the
JSL library, and the compile then lowers that loaded library without reading it again.

The move itself preserved the realm exactly (an identical test262 results.tsv). Declarations then
gave every built-in function its `length` (a required `:length`, distinct from the slot count:
`Array.prototype.push` has length 1 and four slots) and `name`, defined in that order and
configurable only (CreateBuiltinFunction), and a built-in constructor's `prototype` lost its
writable bit. Still open: source functions have no `name` or `length`. (Non-constructor built-ins
lost their `prototype` with the [[Construct]] flag, and which intrinsics exist is now decided by
demand, above.)

## 2026-09-15 — Non-constant float arithmetic is typed F64, not the operands' meet

Simple's `ArithNode.compute` types two non-constant float operands as `t1.meet(t2)`. Our F32 means
every value round-trips through binary32, and that says nothing about a binary64 sum, difference,
product or quotient. The meet was also non-monotone against constant folding. `Phi(561, 1e9)` is
F32 and the Mul over it was typed F32; once the Phis folded, the product 5.61e11 fell outside F32
and `n-set-ty!` panicked. A full test262 campaign hit exactly this, and RoundF32 over such a Mul
would have been removed. Add, Sub, Mul and Div now fold two constants and otherwise produce F64
(`src/node/arith.coil` header; `tests/peephole-test.coil`).

## 2026-09-12 — Input-slot scheduling facts, memory wait groups, and stack-required splits

Local scheduling computes register-mask intersections and remote-use/definition flags in a
pass-scoped scan of machine input slots. Final Simple's `XSched.computeSingleRDef` follows
reverse outputs and searches the user's inputs. Duplicate edges in a wide Phi repeat that
search quadratically. The input-slot scan computes the same intersections once per operand;
idempotence removes the need to revisit duplicate matches. Block-local two-address propagation,
pressure scores, dependency multiplicity, and deterministic ready ordering stay unchanged.
The facts expire before Cast erasure and allocator operand edits. A 4,096-arm regression checks
the exact slot-visit count, fixed-register intersections, and remote flags.

GCM groups selected Loads by their memory definition for the duration of late scheduling.
Each group counts unfinished clobber edges and wakes its Loads when the count reaches zero.
Final Simple's `breadth` searches each completed node's definitions' outputs for waiting Loads;
on high-fanout control and constants that repeats searches with no memory dependency to find.
The group index visits each participating memory definition's outputs once. Duplicate MemPhi
arms contribute separate edges and separate decrements. Ordinary def-use wakeups, pinned-node
placement, loop-Phi handling, and alias-sensitive anti-dependence placement keep their existing
rules. Late placement preserves memory inputs; added anti-edges consume loaded values. Tests
cover duplicate clobber edges, one wake per waiting Load, and zero memory searches without Loads.

IFG records positive evidence that a range requires a stack home: a live movable root at a GC
site, or a live range at a clobber of the target's complete allocatable-register set. We retain
this evidence even after another constraint empties the mask, propagate it through LRG union,
and discard it at the next round. The target exposes allocatable registers as a separate ABI
fact. Its never-save mask cannot supply that fact: AArch64's dedicated X28 context register is
unavailable to ordinary values but still needs preservation at the host boundary.

After self-conflict and callee-save handling, an empty stack-required range splits its register
definitions and uses together. Simple's `splitEmptyMaskSimple` first isolates fixed endpoints;
its generic `splitByLoop` chooses a loop boundary. With our root-home and all-volatile JS-call
constraints, that sequence can leave ordinary register uses in the failed range and require
another whole IFG build to discover the same need. The existing boundary splitter now uses
the retained evidence to isolate both sides in one invocation. It keeps rematerialization,
Phi-edge placement, and loop-backedge protections. Partial clobbers still allow scalar values
in preserved registers. The masks and stack-map checks, not this split policy, enforce safety.

The allocator also reuses each computed intersection for trace reporting; disabled tracing
previously evaluated and discarded a second identical mask operation.

## 2026-09-12 — Amortize control queries over shared dominator paths

We compute a wide Region's dominator as one N-way intersection. Final Simple's
`RegionNode.idom` folds `CFGNode._idom` over live predecessors with a parallel chain walk.
On a Script with many throwing operations, that fold walks the same normal-continuation
prefix for successive exceptional exits. The existing idom cache avoids repeating a whole
query, but cannot reduce the quadratic work inside its first computation.

After each connected pair meets, we record the traversed nodes as descendants of the running
LCA. A later input that reaches this covered subtree has that LCA as its answer. The running
LCA can move toward the root without invalidating coverage. Two-input Regions keep the
ordinary pairwise walk. A disconnected transient path uses the existing dead-root rule and
clears coverage; high inputs still do not constrain dominance. Coverage belongs to one query,
so graph edits cannot leave stale coverage behind. The final answer retains the existing
control-edit-version cache.

Instruction selection now uses `cfg-owner-fun`, the versioned path-compressed owner query.
Its former private implementation followed Simple's `CFGNode.fun` walk from each Call and
CallEnd to Fun, repeating the same prefix. Selection still derives ownership from control
and preserves the caller's incoming stack-argument area in outgoing ABI locations.

The identical-graph `tools/control-study.coil` experiment measures the original pairwise
walk against the covered traversal with warmed depth caches. At 1,001, 2,001 and 4,001 exit
paths, the pairwise walk took 37, 144 and 560 ms. The covered traversal took at most 1 ms
and 2,998, 5,998 and 11,998 chain steps. Tests compare answers across permuted and duplicate
predecessors, retain dead-subtree cases, and impose linear-work bounds. Ownership tests
also change an upstream control edge and check the new function answer.

We kept graph construction, JSL policy, register allocation and machine block layout unchanged.
The investigation pad records rejected constant-materialization, operand-copy, stack-home
and call-block-fusion experiments. This change addresses a measured scaling defect; it does
not establish that graph expansion or allocation needs no further work.

## 2026-09-10 — Precise memory updates, lexical identities and guarded graph inlining

Property writes follow final Simple Parser.storeMem/mergeAlias: a fresh MemMerge keeps the
whole prior memory as its default and overrides only the written alias. The MemMerge peephole
removes redundant overrides, returns the default if possible, then flattens nested defaults with
outer overrides winning. No field enumeration is needed merely to preserve unrelated memory.

Script instantiation checks remain before all binding creation. Their generic throwing logic is
a shared JSL builtin. Creation returns a stable positive lexical slot stored under a compiler-only
Scope name. Own-Script initialization and reads can reuse that identity; reads still observe
mutable contents, TDZ and const rules. Functions and unresolved/imported references do not capture
another Script's initializer SSA value or cache an absent/object-record binding identity.

JSL `:inline-when [predicates...]` uses the same proof vocabulary as `:specialize`, but authorizes
the ordinary graph-copy inliner rather than checked-source re-expansion. These options are mutually
exclusive. Unknown arguments retain a shared helper even when unrelated operands are constant.
Proven local calls remain subject to normal size and recursion guards. Imported providers have no
local graph to copy and remain ABI calls. This is not a cross-unit effects-summary system.

Late source re-expansion of the callable adapter was rejected: fresh internal calls after type
refinement broke existing return/control relationships. No type assertion suppression or
old-result cast workaround is part of the solution.

## 2026-09-10 — Backend live sets and physical layout ownership

Final Simple IFG removes a definition from its temporary live map before scanning live ranges.
Our dense live map now has sparse-set membership with swap removal, so killed and reactivated
ranges do not accumulate dead or duplicate iteration keys. Liveness propagation, moving-GC root
constraints, singleton exclusions and failed-range splitting retain their existing semantics.

Final Simple Encoding splices UJmp into CFG/RPO. Our encoder already keeps a separate physical
layout without rewiring target predecessors, so both jump endpoints are layout metadata. A jump
is allocated directly, without a dummy ideal XCTRL constructor. Neither operation changes logical
dominance. Selected If data inputs likewise do not change dominance; the target distinguishes
merges from branches despite their shared machine opcode. Real predecessor edits still invalidate
the caches. Diagnostic phase labels separate owner-cache population, offsets, relaxation, veneers,
stack maps and byte emission without adding clocks to the production encoder.

## 2026-09-10 — Fixed-key literals allocate their final backing once

The frontend plans the final ordered shape of an object literal containing fixed data keys.
Duplicate keys retain their first slot; their expressions and writes still occur every time.
The special prototype entry is excluded from that data layout. Unsupported computed keys,
methods/accessors and spreads still refuse rather than entering this path approximately.

`JsNewObjectLiteralRaw` uses the checked `%NewObjectWithShape` allocation primitive. Its layout
operand must be a valid compile-time object-property shape, consumed during lowering. Runtime
shape identities remain the responsibility of New and image remapping, never an embedded local
integer. The ordinary object and its one final backing are fresh; every slot is initialized to
boxed undefined before any source property expression can call, allocate or throw.

Pre-created keys are unobservable because the literal object has not escaped. Property values,
prototype changes, and definitions retain their existing left-to-right JSL sequence. If a call
loses the static backing proof, generic stores remain correct and see the already-final layout.
Dynamic property additions outside this construction path retain ordinary shape growth.

Final Simple's `Parser.makeAllocator` likewise knows the complete struct, allocates it once and
initializes through private memory before publication. JavaScript requires the additional
unpublished-literal restriction and GC-safe initialization across arbitrary RHS effects.

Tests count backing allocations before optimization, so manufacturing a large graph and deleting
it later cannot satisfy the regression. Executable tests cover duplicate-key ordering, prototype
behavior, fresh identity, abrupt completion and forced moving GC across property values.

## 2026-09-10 — Runtime clobbers, GC homes, constant tails, and late CFG caches

Runtime allocation and JsOp calls use AAPCS64 caller-save masks. Explicit Safepoint nodes
emit no instruction and clobber no scalar registers. JavaScript calls retain their existing
all-volatile ABI; this change does not introduce per-JavaScript-function callee saves.
The allocator constrains live raw references and reference-capable boxed ranges to writable
stack homes at GC boundaries, independent of the hardware clobber mask. Simple subtracts
call clobbers from live ranges; moving GC requires this additional constraint here.

Optional Split coalescing requires equal GC kinds. A merge of a scalar range into a root
range after interference construction would create root requirements at earlier scalar
safepoints without establishing stack homes there. We retain that copy. Mandatory Phi
and two-address unions still establish their joined kind before interference construction.
Post-color cleanup follows the same kind rule and cannot bypass a root's spill/reload across
a GC boundary just because the physical register survives. Calls impose root constraints at
the Call instruction, where the return-PC stack map belongs, even though CallEnd carries
their hardware clobber mask. Stack-map construction and allocation share one GC-site predicate.

The callable packer emits a static SHAPE-ELEMENTS payload when all overflow actuals have
exact boxed image encodings. It preserves existing static-reference identities and uses
ordinary heap-image relocation for their words. Dynamic tails retain allocation and stores.
The payload is compiler-owned, immutable, and inaccessible as a JavaScript object. It has
the managed ArgumentVector type, with no JavaScript boxing representation. Ordinary object
literal evaluation still creates fresh objects. Image encoding canonicalizes floating NaNs
and preserves negative zero. The ABI layout and actual count remain unchanged.

Phase entry retains dominator and owner caches on transitions to local scheduling, register
allocation, and encoding. These phases operate on the completed CFG and use the edge-edit
API for structural edits; that API invalidates cached answers. Earlier phase boundaries still
invalidate after bulk construction. Rebuilding dominance merely because the phase changed
had charged about 87 ms to Temporal's allocator setup without any CFG change.

## 2026-09-10 — Direct actuals, shared callable dispatch, and Script const reads

Callable ABI version 2 passes three boxed actuals after the five metadata arguments
(callee, receiver, new target, actual count, overflow vector). These eight words fit
the AArch64 integer argument registers. Callers pad missing direct slots with undefined
and preserve the actual count. Calls with at most three actuals allocate no argument
vector. Larger calls allocate only the tail, starting at actual index three. Callees
guard overflow loads with the actual count. Image ABI version 5 rejects older artifacts.
Direct boxed arguments and overflow vectors retain the collector's root and safepoint
rules; allocation stress tests exercise both paths across callable boundaries.

Simple maps Call arguments to Parm inputs without a per-call heap container. We use
that model for the direct slots while retaining JavaScript's variable arity and missing
argument semantics. The nullable managed vector type admits a typed nil singleton.
Its referent describes the family; the singleton still denotes only the zero pointer.

Unknown JavaScript calls use the shared, proof-gated JSL body JsInvokeCallable. JSL checks
callability and constructs TypeError. The caller evaluates lookup and arguments in source
order, then checks one completion. The checked %CallFunctionPacked primitive accepts
an argument-count and argument-vector plus three boxed actuals, and forwards this ABI
without allocating a second vector. Frontend-proven function values use ordinary Call
nodes, retaining interprocedural optimization. The later guarded graph-copy policy above permits
local inlining only with function proof. We do not enable late source specialization
for this helper: replacing a narrowed call with newly lowered indirect calls exposed a
type-monotonicity failure. The project pad records that unresolved invalidation problem.

After publishing a root Script const into its realm cell, the frontend also records its
initialized SSA value in the current Scope. Dominated reads in that Script reuse the value.
Other functions and later Scripts still read the realm cell. Reads before initialization
retain TDZ checks. Mutable bindings retain memory-dependent reads. A write to the SSA
mirror evaluates its RHS before throwing TypeError; it must not invoke Scope's compile-time
final-variable rejection. Holding an object in const does not make its fields immutable.

## 2026-09-10 — Property evidence, expansion ownership, and shared JSL providers

Named assignments now call `JsDefineOwnNamed`, alongside the retained `JsGetNamed` read
boundary. JSL owns both bodies. Their specialization predicates require an own data
descriptor, an own writable data descriptor, or a string/array length read. A broad receiver
tag no longer suffices for these operations. The predicates consult the same memory/shape
and image facts as PropAccess; they allocate no speculative graph and grant no assumptions.
The source lowerer still proves the resulting accesses. Unknown cases keep their calls.

The checker accepts property predicates over declared dynamic receiver and integer-key
parameters. Existing tag predicates remain available for operations where a tag proves useful
simplification. This policy does not introduce a shared specialized-body cache: callers share
the generic provider, and proven small residual operations are lowered at their own sites.

`source-cache-new-shared` owns a compiled provider for JSL definitions marked `:noinline` or
`:specialize`, plus their private dependencies. It compiles those exports with unknown callers,
external-mutation image facts, and the unit's canonical Start. It registers exported function
identities even without local FunPtr uses. Returns follow the existing temporary-keep and
post-optimization Stop-root protocol. Other JSL definitions retain ordinary graph optimization.

Clients import the explicit boundaries instead of rebuilding their generic graphs. Source
specialization can replace an imported call using checked JSL source and caller evidence;
the caller never imports a provider's graph nodes or inferred caller-specific facts. Imported
calls conservatively clobber public memory and use checked declared completion types. JSL
`dyn-object-like` expresses an internal boxed-object precondition; calls must establish it.
`never` declares no normal result, so `:throws true :ret never` returns only the exception
sentinel. Result lowering uses the checker's tag set rather than unioning the stored bits of
a complemented ideal type. This distinction matters for the empty normal-result type.

The provider materializes every admitted intrinsic constructor/namespace and its parent, even
though its initializer Script is empty. A generic body must not fold `%IntrinsicPrototype` to
null merely because this empty Script did not mention the constructor. Method fields requested
by later clients merge into those canonical identities at realm assembly. Tests exercise a
provider built before a later client introduces string, number, and boolean `valueOf` calls.

The process-local provider key contains the exact JSL snapshot and worklist seed. The running
executable fixes compiler, runtime, target, and ABI/layout versions. Source and provider snapshots
must match, including after compilation. Leased Script artifacts own their provider snapshot;
installed clients pin its installation. SourceProgram binds only the imports a client requests,
includes the provider in fresh-realm assembly, and uninstalls clients before the provider.
On a miss, the cache compiles and captures the client before acquiring its provider. An
unsupported client therefore does not trigger a wasted provider build after worker replacement.
The cache retains at most capacity+1 provider snapshots, with a spare slot for replacing a
Script victim. It evicts only snapshots with no artifact users or installations. It does not
persist addresses, heap state, or native artifacts across executable versions. Self-contained
image clients keep `source-cache-new`; the memory runner and test262 worker use the shared API.

Construction origins are diagnostic node metadata, excluded from GVN and semantic types.
They identify generic JSL bodies, macro expansion instances, source specializations, and inline
clones, with parent identities and source ranges. Frontend expressions have their own origins
so call/constructor scaffolding does not disappear into the unowned bucket. Nested origins own disjoint node sets.
Peepholes, property expansion, selection, and spill copies carry the origin forward. A GVN
survivor keeps its construction owner, so the counts describe ownership rather than all
semantic dependencies. `compile-study` reports allocated and connected nodes and surviving
branches per origin at each snapshot, including origin zero for unowned compiler work. It
counts in one arena pass and one connected-graph pass per snapshot, not one scan per expansion.

The provider tests exposed a separate graph-copy bug: both body-selection walks followed
input zero of any call target. Only FunPtr has a callee edge there; Extern has no inputs and
indirect targets may have unrelated inputs. Both walks now restrict that step to FunPtr.

Retaining writes also requires preserving receiver/key correlation in image facts. Merging
the two formal parameter sets independently would turn writes to `f.a` and `g.c` into writes
to `f.c` and `g.a` too. The pass indexes known linked and finite unlinked callers once, then
substitutes paired forwarded formals through the same call. Seen operand pairs terminate
recursive forwarding; cached terminal pairs read the evolving points-to sets during the
fixpoint. Unknown callers and non-forwarding dataflow keep the conservative transfer. This
analysis follows IR writes, not builtin names, and preserves the existing exact-pair tests.

Regressions cover retained write growth, rejected broad-tag specialization, precise exported
contracts, nested origin ownership, fresh realms with getters/setters and forced GC, provider
reuse across different sources, exact snapshot invalidation, and bounded provider eviction.

## 2026-09-10 — Retain named reads and specialize JSL source on proven tags

Named member reads, member-call lookup and constructor prototype lookup emit an ordinary
Call/CallEnd to `JsGetNamed`. Its checked JSL body owns receiver classification, property
lookup and abrupt completion. The caller retains the ordinary memory/result/control tuple
and sentinel completion check. Unknown receivers do not expand the generic body per site.

JSL builtins may declare `:specialize [(%IsObjectLike object) (%IsString object)]`.
Each entry is an alternative tag predicate over a declared `dyn` parameter. The annotation
permits expansion; it supplies no type assumption. An actual argument must have a non-high
inferred type contained in a listed tag set. Unknown arguments defer with dependencies.
Macros and `:noinline` declarations cannot use this option. Ordinary builtins keep their
existing inlining policy; annotated definitions use source specialization instead of cloning.

Final Simple's CallEnd worklist admits one inline before another cleanup. The same worklist
invokes a frontend callback for source specialization, including a non-mutating candidate
query for fixpoint checks. JSL lowers the original checked body with actual arguments, so
constant conditions discard branches before graph construction. It forwards the complete
state tuple and unlinks the old call through the existing paired-edge protocol. Cleanup
queues the newly constructed residual body, not the entire arena. Direct self-recursion
defers as in the ordinary inliner. No builtin-specific opcode or backend dispatch is added.

The generic body and its dependencies exist before specialization. Known types can specialize
in the initial pessimistic solve; later facts and caller inlining can expose more candidates.
This preserves literal-property folding without forcing a large generic clone. Remaining
calls share one emitted helper definition within the compilation unit. A process-wide,
independently compiled helper cache is not part of this change.

## 2026-09-10 — Propagate mandatory register locations across interference edges

Simple's IFG denies a fixed definition/use register to simultaneously live values. Aggregate
constraints can also force a multi-definition range into one location, such as a Phi feeding
an X0 Return. After constructing interference, propagate singleton range masks to neighbors.
A queue visits a range when it becomes singleton and subtracts its mandatory location from
adjacent masks. Empty masks enter the existing split protocol. This prevents a flexible
neighbor from taking a mandatory location during reverse coloring. It does not add registers,
relax interference, change the ABI or increase the allocation-round limit.

The named-read change exposed this case in the array execution regression. Tests cover
transitive propagation, fixed stack locations, repeat calls and incompatible singletons.

## 2026-09-10 — Sparse named-write facts and grouped loop layout

Named writes in image facts use key sets per object. They occupy space for observed
pairs, with linear object/key tables for the existing escape and unknown-owner rules.
The distinct-pair count replaces scanning the object/key matrix in the convergence
signature. Reset and rescan release the previous tables. Duplicate writes, runtime
keys, escaped owners and keys interned after analysis retain their prior meaning.
Simple has no prepopulated JavaScript image, so this representation is a local choice.

Final Simple's Encoding._rpo_cfg builds private loop RPO lists and splices them into
parents. Our layout retains its existing preferred-RPO projection but groups blocks
once by loop owner. A child reference occupies the position of its first descendant.
Each parent chain registers once; an iterative traversal expands child references.
This takes expected O(blocks + containers) work and storage, avoiding both per-loop
whole-program scans and repeated nested-list copying. Missing roots, orphan blocks
and cyclic parent chains remain hard errors.

Regressions cover a sparse 65,536-by-65,536 fact domain and 512 nested or sibling
containers, including deepest-first discovery, exact order and bounded visit counts.

## 2026-09-10 — Copy selected bodies and store sparse GC liveness words

Final Simple copies function bodies through a node map and repairs links by walking
the copied entries. Our body-clone path now consumes the selector's touched IDs and
uses a body-sized hash map. Shell creation, ordered-edge wiring, metadata repair,
function-pointer identity replacement and call relinking visit selected nodes.
The selector's backward-closure seed scan visits admitted candidates rather than
the arena. Reusable membership tables grow with the arena and clear touched slots;
they do not refill the arena for each clone. The bitmap copy API remains available
for callers that supply a dense selection. Existing identity and cycle rules remain.

Simple's interference builder stores actual live ranges in per-block maps. Our
separate moving-GC dataflow now stores nonzero 64-range words per block, removing
the blocks-by-program-ranges allocation for OUT, GEN and KILL. GEN/KILL construction
and predecessor-edge Phi uses retain their rules. Each transfer computes a sparse
IN snapshot before updating predecessors, including the block itself on a self-loop.
Clearing the final bit removes the word. Stack-map entries carry explicit locations
and kinds, so hash iteration order does not define their meaning.

Regressions exercise a one-node copy after 65,536 unrelated nodes and 512 sparse
liveness rows with widely separated range IDs, including removal of the final bit.
Native execution, cycles, link repair and moving-GC tests remain correctness gates.

## 2026-09-10 — Linear graph verification and indexed late-pass dominators

Whole-graph verification counts the input/output edge multiset in O(nodes + edges).
It buckets input edges by producer, counts consumers, subtracts output edges and
checks the remaining counts. Duplicate operands count as distinct edges; keep
markers do not. A valid graph proceeds through the existing property checks. On
edge corruption, the original per-node verifier preserves first-error precedence.
The isolated peephole verifier remains unchanged.

Final Simple computes use LCAs by walking dominator chains. Our late GCM pass builds
a binary-ancestor index from the ordinary immediate-dominator answers, including
ancestors outside the supplied CFG table. Exact tree depths support logarithmic
queries across a forest of independent function roots. The index does not compute
region dominators or alter Simple's placement and anti-dependence rules. Queries
outside the pass, outside the index, or after a CFG version change use the original
walk. Rebuilding releases the previous index storage.

Regression tests cover high fanout, duplicate-edge corruption, deep branching,
independent function roots, control-edit invalidation and index rebuilding. On the
361-line Temporal fixture, initial phase measurements dropped from 359 to 19 ms
for verification/typecheck and from 940 to 287 ms for GCM. These measurements do
not establish a Temporal conformance pass or the 100 ms compile-time target.

## 2026-09-10 — Shared JSL clones require facts absent from live parameters

For a shared JSL body, inline evidence compares actual argument types with the
live Parm types as well as the declared signature. A fact already present in the
callee cannot justify a clone. An eliminated Parm supplies no evidence. Dependencies
on surviving Parms and actual arguments allow reevaluation as their types change.
Single-caller evidence and the existing tiny-body policy retain their prior rules.
This restriction passes focused tests but did not reduce the Temporal graph size;
it is not a residual-body cost model.

## 2026-09-10 — Record stack maps from a sparse live set

The stack-map recorder scanned all program live ranges at each safepoint and cleared
that same dense table at each block. It now maintains an active-range vector, node-id
slots and reverse positions. Insertion, replacement and swap removal take constant
time; block reset and map recording visit active ranges. The existing live-out dataflow,
canonical-range checks, GC kinds and stack-home requirements remain unchanged.
Stack-map slot order carries no meaning because each entry stores its location and kind.

The regression exercises sparse high range IDs, replacement, repeated deletion,
swap removal and block reset. Existing map serialization and moving-GC tests remain gates.
On the 361-line retained Temporal fixture, encoding dropped from 1,566 ms to 401 ms
in the fresh measurements. Compiler phases total 3,996 ms; process wall time is 4.04 s.
The input still throws ReferenceError because Temporal is absent. This is a compile-cost
measurement, not a passing Temporal conformance test. The 100 ms target remains open.
Logs: `build/temporal-100ms-baseline.log` and
`build/sparse-live-final-temporal-20260910.log`.

## 2026-09-10 — Share encoder ownership-query prefixes

Simple's `CFGNode.fun` walks immediate dominators to the first Fun. Our encoder filled
its block-owner cache with one such full walk per block. On the large retained Temporal
fixture, the sampler attributed 755 of 766 samples during encoding to this lookup.

The encoder now uses `cfg-owner-fun`, which caches the answer along the traversed path
under the control-edit version. Its block-owner table also uses that edit version,
so rewiring control invalidates both layers. A 256-block regression bounds total visits
and checks that moving the chain to another function changes the answer after a warm query.

The Math fixture now takes 824 ms of compiler phases. The large Temporal fixture takes
4,813 ms, with encoding reduced from 2,337 to 1,505 ms. Further compile-cost work remains.
Logs: `build/encoder-owner-math-20260910.log` and
`build/encoder-owner-zoned-temporal-20260910.log`.

## 2026-09-10 — Distinct scheduling users and shared global lookup bodies

Final Simple's `Node.addUse` records an edge, including duplicates. GCM's `_doSchedLate`
iterates those edges and `use_block` scans every Phi arm for the definition. A value used
in many arms of one Phi therefore repeats the same full predecessor-LCA calculation for
each edge. Our generated exception merges expose this cost: the retained Math fixture
visited 255,147 Phi arms and spent 5.462 seconds scheduling.

GCM now processes each distinct user once per definition. Phi-use resolution still includes
every matching predecessor, not just the first. LCA idempotence makes repeated identical
user results redundant. An arena-owned scratch table records visited user identities and
clears them through the output list before returning. It stores no dominance answers and
cannot become stale across queries or graph edits. No control-flow optimization or
register constraint is skipped. The 256-branch regression fails the old arm-inspection
budget and passes the new traversal, preserving predecessor placement and repeat queries.

Scheduling the same Math input now takes 123 ms, with unchanged arena node counts.
The remaining graph-volume problem includes global lookup expanded at every identifier.
`JsGlobalBindingRead` and `JsGlobalTypeofOperand` are now builtins rather than macros:
their bodies are shared, and the existing evidence/size-gated inliner decides whether
to specialize them. No new inline threshold or forced noinline policy is introduced.
The frontend's unary JSL helper respects the declaration's macro/builtin distinction.
Mutable-realm lookup, TDZ, getter completions and unresolved-typeof semantics are unchanged.

After both changes the Math fixture takes 979 ms of compiler phases; a previously timed-out
Temporal fixture takes 1,792 ms and then raises ReferenceError because Temporal is absent.
These are standalone retained-unit measurements, not conformance passes or a new campaign.
A 64-reference retained lookup budget test compiles in 125 ms (3,751 machine nodes,
951 blocks); structural ceilings and a one-second coarse wall gate prevent regression.
The broader hundreds-of-milliseconds target remains open.

## 2026-09-10 — Enclosing captures precede global lexical resolution

Final Simple searches Scope variables from innermost to outermost before creating a lazy loop
Phi for the selected variable. Our separately lowered function bodies must preserve that name
precedence even before captured local environments have runtime storage.

Capture discovery walks the child's syntax ancestors and the containing block/loop/switch/catch
scopes in each ancestor. It excludes sibling blocks, switch discriminants and catch parameters
outside their catch body. An ordinary hoisted function still owns parameters and local variables;
only root Script declarations belong to the realm. Reads, writes and named calls check enclosing
captures before choosing a global binding or restricted singleton. Current-function Scope
bindings retain precedence over those captures.

This fixes the block-capture wrong-code reproduction below by explicitly refusing the unsupported
captured environment. It does not implement closures. Syntax tests distinguish positive and
negative scope membership; compilation tests cover reads, typeof, assignment/update, calls and
singleton shadows. A native two-Script test confirms that sibling scopes, a switch discriminant,
finally and a function's own parameter still use their correct supported bindings.

## 2026-09-10 — Retained Scripts share global let/const bindings

Retained Script initializers create root let/const cells in the executing realm. Local and
block bindings keep Simple's Scope graph inputs. A root lexical initializer writes its cell
after evaluating and checking its RHS; a later Script or callback reads the same cell. Name
lookup and typeof consult the declarative record before the global object record.

Assignment resolution produces a stable lexical slot (positive), an object binding (-1), or
an unresolvable reference (zero). The frontend retains that classification with the environment
and key before RHS evaluation. Compound and logical assignment reuse it, including after an
RHS changes the value or global property. JSL performs TDZ/const completion checks at GetValue
or PutValue; an abrupt RHS precedes PutValue.

Declaration instantiation checks existing lexical bindings and restricted global properties,
then checks var/function names against existing lexical bindings and their object-record
admissibility. It creates no bindings before the complete check pass. On success it creates
uninitialized lexical cells, then functions and vars. Cross-Script conflicts raise the realm's
intrinsic SyntaxError; restricted singleton names now reach this runtime check in retained mode.
Retained realm templates include undefined, Infinity and NaN as non-writable, non-enumerable,
non-configurable own properties. This follows
[GlobalDeclarationInstantiation](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-globaldeclarationinstantiation).

Shared image assembly admits let/const declarations. Native tests cover separate source images,
fresh GC-stressed reruns, callbacks, shadowing, TDZ/typeof, const writes and assignment order.
Declaration tests check the error identity and absence of new bindings after a conflict.
A three-image test permits a lexical declaration over an existing configurable property that
an intervening Script reused for var. Classes/destructuring remain unsupported. Captured
local/block environments remain unsupported. An audit found that a function created inside a
block could read a same-named global lexical instead of its captured block binding. Reproduction:
`build/shared-lexical-block-capture-audit.js`; evidence in the project pad, cell
`shared-lexical-block-capture-bug`. Capture discovery now refuses that case before global lookup;
see the enclosing-captures decision above. Closed-program lexical storage remains unchanged.
Retained compile-cost reduction and campaign verification remain open.

## 2026-09-10 — Global lexical access checks state before touching the value

`JsGlobalLexicalRead` and `JsGlobalLexicalWrite` accept a resolved positive slot in the executing
realm. Read checks initialization before loading the value. Write checks initialization first,
then writability; it stores only on the initialized mutable path. Uninitialized access raises
the intrinsic ReferenceError. An initialized const write raises the intrinsic TypeError even
in sloppy code, because const declarations create strict immutable bindings. Both operations
return the existing exception-sentinel completion protocol. The caller must check an RHS
completion before passing its value to the write helper.

These operations implement the state checks in ECMA-262
[Declarative Environment Records](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records).
They do not resolve absent names, create bindings or check declaration conflicts. A typeof
operand with a resolved lexical binding must use the same read operation, preserving TDZ.

Four native JSL regressions cover TDZ read, TDZ-before-const write, const value preservation
through allocating errors, and initialized undefined followed by mutable assignment. They
execute the production helpers and inspect the pending error prototype in a capability realm
with distinct intrinsic prototype objects, twice per retained image. Source-level declaration,
name/reference resolution and cross-Script conflict checks remain unfinished; shared source
assembly still rejects lexical units.

For that declaration integration, use the current
[GlobalDeclarationInstantiation algorithm](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-globaldeclarationinstantiation).
It checks lexical declarations and restricted global properties; it has no historical
`HasVarDeclaration` check or realm `[[VarDeclaredNames]]` set. Some pinned Test262 comments
still quote the older algorithm. Do not infer a need for that extra state from those comments:
the ordinary var/function globals in `script-decl-lex-var.js` are non-configurable properties.

## 2026-09-10 — Language-raised errors use intrinsic prototype identities

`JsThrowTypeError` and `JsThrowRangeError` allocate fresh objects using the executing realm's
intrinsic prototype identities. They define an own writable/configurable, non-enumerable
message data property before publishing the error through the pending-exception slot.
Neither operation reads the mutable global constructor or invokes an inherited message setter.
This follows the intrinsic error creation and message descriptor rules in
[ECMA-262 NativeError constructors](https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-nativeerror-constructors).
The existing ReferenceError helper already uses an intrinsic prototype and omits its message.

A native regression compiles two Scripts into separate cached images. The first replaces both
global constructors with throwing getters and installs inherited message setters; the second
triggers null property access and invalid array length errors. It checks prototype identity,
message descriptors and zero getter/setter effects across two fresh GC-stressed realms.
This change preserves the existing error-object representation; it does not establish complete
NativeError branding or constructor conformance. Shared lexical resolution and TDZ/const
completion integration remain unfinished.

## 2026-09-10 — JSL accesses global lexical cells through checked runtime primitives

Six JSL primitives lower through the ordinary pinned, memory-threaded JsOp and native-call
backend. They access public realm memory and return conservative value types. They do not
collect or call JavaScript; table growth uses malloc. Initialize/store inputs must be boxed
JavaScript values without an exception sentinel. Reads return unknown dynamic values, so
unboxing still requires a representation guard.

| Primitive | Inputs | Result |
|---|---|---|
| `%GlobalLexicalFind` | program key | slot, or zero if absent |
| `%GlobalLexicalCreate` | program key, writable integer flag 0/1 | new positive slot |
| `%GlobalLexicalState` | slot | bit 0 initialized, bit 1 writable |
| `%GlobalLexicalValue` | initialized slot | boxed value |
| `%GlobalLexicalInitialize` | uninitialized slot, boxed value | boxed value |
| `%GlobalLexicalStore` | initialized writable slot, boxed value | boxed value |

Keys use the existing KeyRef relocation into the executing program's namespace. The linked
runtime exports and in-memory symbol resolver use the same storage functions. The create
adapter validates its full-width integer flag before converting it to Coil Boolean.

Image-fact analysis treats stored objects as escaped and a lexical read's object identity as
unknown. A regression covers a property write through such a read, preventing stale image
property facts. Native tests compile JSL probes through optimization and encoding, install
their images in memory, and repeat execution in fresh GC-stressed realms. They cover mutable
and immutable cells, state transitions, lookup before/after creation, and a string held by
a lexical cell across allocation. Checker regressions reject wrong operand types and unchecked
completions. JSL error-completion helpers and Script parser/declaration integration remain open.

## 2026-09-10 — Global lexical storage belongs to the executing realm

Final Simple's ScopeNode tracks parser variables as graph inputs. It has no native global
declarative environment. Retained JavaScript Scripts need bindings that survive initializer
return and remain distinct from properties on the global object.

`RtHeap` owns a program-key-to-slot index and a growable array of global lexical cells. The
keys use the executing program's remapped string-key namespace. Slots are one-based; lookup
returns zero for absence. A slot remains stable through array growth and GC, but expires at
realm destruction. Cached artifacts must not retain slots or pointers from an earlier realm.
Creation adds an uninitialized cell. Initialization state is separate from the value bits,
so initialized undefined differs from TDZ. Global let/class cells are writable; const cells
are immutable. These global lexical bindings are non-deletable.

The Coil API provides checked storage operations. JSL must inspect state and construct TDZ
ReferenceError or const-write TypeError completions before value access. Duplicate creation,
reinitialization, invalid slots and unchecked invalid access hard-error as compiler/runtime
contract violations. These guards do not implement JavaScript exception semantics. Script
declaration instantiation must perform its conflict checks before creating cells.

The runtime allocates table storage with malloc, without a JavaScript safepoint. Minor and
major collectors forward initialized cell values as explicit realm roots, then trace their
children through the ordinary collector. A cell write therefore needs no remembered card.
GC verification checks the values, and realm teardown frees both table and index. Fresh
execution starts with no lexical bindings, independently of the retained native images.

The storage layer and JSL primitives are implemented. JSL completions, parser resolution and declaration
instantiation remain unfinished; shared source assembly continues to reject lexical units.
The semantic basis is ECMA-262 [Declarative Environment Records](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records).

## 2026-09-10 — Bound call-result predicate searches by SSA availability

Final Simple's `IfNode.idealize` searches the immediate-dominator chain to its root for
an identical predicate or the source of a nonzero Guard. It records dependencies so later
rewrites retry the search. Our retained Script compilation introduces many call-result
exception tests; searching their full prefixes accumulates quadratic dependency storage.

The search now follows one nonconstant data-input chain to a pinned definition. This
extends the initial direct CallEnd-result cutoff to composite predicates, primitive results
and Phis. Simple's GCM earliest-placement rule supplies the reasoning: a value cannot be
used before its inputs exist. Any one input boundary is sufficient; finding the deepest
would improve the bound but is not necessary for correctness. Phi traversal stops at its
Region, never its backedges. Cast traversal ignores the guard control and follows its
source, preserving the existing guarded-source matching rule. Every traversed value is
watched for rewrites. No availability result is cached across graph mutations.

We still search the interval between the current If and the definition, including both
arms of earlier tests, and register the visited boundary dependency before stopping.
This cutoff uses a value definition, with no depth budget or skipped optimization based
on graph size. A cyclic unpinned input chain is an invariant error, not a search bailout.

Regressions cover direct and composite 512-call chains without prefix dependencies,
repeated tests on both arms, cyclic Phi inputs, guarded-source folding, and projection
rewiring that requeues the watcher and changes its transitive definition boundary.

## 2026-09-10 — Test262 workers use retained source and host caches

Each persistent worker owns a source cache with capacity 32 for Script artifacts and 32 for
sequence hosts. It acquires the variant as one unit and the ordered harness sources as another,
preserving Script boundaries. The program API executes all harness initializers before the
variant and creates a fresh realm for each request. Parse negatives keep their separate parser
protocol and never compile the harness. Fatal compiler/runtime exits replace the worker and
discard its native cache; ordinary JavaScript throws preserve the worker and cache.

Compilation order is independent of evaluation order. The first 1,000-file cached campaign
compiled the harness first and took 425.343 seconds, with 169 passing files and two compile
timeouts. Unsupported test compilation often discarded a newly compiled harness when its worker
exited. The worker now compiles the variant first, then acquires the harness. This preserves
harness-first evaluation while avoiding harness compilation for variants that cannot compile.
The same sample with variant-first compilation took 238.563 seconds with the same 169 passing
files. It reported eight compile timeouts instead of two: six Temporal variants now reach
expensive test compilation before their unsupported harness. Pass/fail counts stayed 322/360;
unsupported fell from 1,215 to 1,199 and compiler errors rose from 28 to 38. Neither run had a
crash or harness error. This improves the first cached integration but remains slower than the
earlier 101.511-second closed-program measurement; retained compile cost remains open.

Phase packets report source/host cache hits and misses as cumulative counters within one worker.
Successful captures sample compiler-region reservation before scratch reset. The metrics retain
worker-start counts to identify replacement boundaries; fatal compilation may stop before its
reservation peak or completed cache work reaches the supervisor. A worker regression proves a
repeated request hits both source artifacts and the host, and changed harness bytes miss the
source cache while reusing the host.

## 2026-09-10 — Own cached Script programs and reuse sequence hosts

`source-program-new` accepts ordered `(handle, script ordinal)` selections from one source cache.
It checks live leases, retained initializer ordinals and equal JSL snapshots before installing
providers. It installs each distinct selected artifact once and retains one additional source
lease per provider. Repeated selections execute the same initializer again. The caller can
release its acquisitions and selection storage after construction. `source-program-run!` creates
a fresh realm on each call; `source-program-free!` drops host imports before provider installations
and source leases. The cache must outlive its programs. Program fields are owned implementation
state, not independent artifacts for callers to free or mutate.

The source cache also owns a separate bounded LRU of sequence host images, keyed by initializer
count and worklist seed. Hosts use canonical `script::N` imports with the generic Script ABI;
the cache validates those bindings on hits and misses. Host compilation does not read JSL or
source providers. Installation resolves each program's provider addresses and pins their code,
so programs can share one immutable host image while keeping distinct installations. Installed
hosts cannot be evicted, and cache teardown checks host installations before freeing anything.
The configured capacity bounds source and host entry counts separately.

Three regressions cover ordered/repeated selections, two live programs sharing a host image,
caller-lease release before execution, fresh GC-stressed runs, complete code-registration cleanup,
empty programs and uncaught status, and rejection of invalid ordinals or mixed dependency
snapshots. Test262 worker integration and shared lexical environments remain unfinished.

## 2026-09-10 — Own retained Script images in a leased source cache

`source-cache-acquire!` accepts an ordered nonempty list of Script source bytes and a worklist
seed. It copies the inputs before resetting compiler scratch. Cache keys include source
boundaries/order, the seed, the production JSL index path and bytes, and each indexed path/source
pair. Comparison uses exact bytes. The running executable fixes the compiler, target and runtime
versions; this cache does not persist across processes. It only compiles external-mutation Script
units, so private whole-program assumptions cannot enter through a cache mode flag.

The cache owns source keys and CodeImages in malloc storage. A hit increments the entry's lease
count and returns its process-wide monotonic handle. `source-cache-image!` requires a live lease
and returns a borrowed image for installation; callers must not free or mutate that image.
Release each acquisition after the last use. Installed artifacts also prevent eviction, even
after the caller releases its source lease. Cache teardown checks all entries before freeing any.

Capacity bounds the entry count. An LRU miss replaces the oldest unleased, uninstalled entry
only after successful compilation and capture. If all entries are live, acquisition reports a
capacity error. A new artifact owns the JSL snapshot used by its compilation. Stale and foreign
handles receive explicit errors, including after slot reuse; a closed cache rejects access.
This API is sequential, like the compiler session it owns, and a call resets scratch on a hit
as well as a miss. It does not invalidate the independent JSL library cache.

Four native regressions cover owned source lifetimes, compiler/JSL-cache resets, fresh GC-stressed
execution, exact source/order/seed/dependency keys, LRU behavior, and lease/installation/refusal
paths. The dependency-key regression changes a byte in an owned snapshot to verify rejection;
it does not modify the production JSL files during tests. Automatic program ownership must still
check compatible dependency snapshots across its acquired units. Host caching, shared lexical
environments and Test262 worker integration remain unfinished.

## 2026-09-10 — Compile Script sequence hosts from retained bindings

Callers can pass ordered initializer bindings to `pipeline-script-sequence-image`, install the
returned host with `image-install-bound`, and run it with the provider installations through
`image-run-shared-program!`. Host compilation does not parse source or revisit provider graphs.
It validates named generic Script-entry ABIs, emits the existing aborting sequence helper, and
uses the compiler's optimizer and backend. Source compilation and host compilation share
`pipeline-encode-machine!` from selection through export.

The host reports the pending exception through JS-UNCAUGHT and returns status 3, matching the
source wrapper. It returns status 0 after normal completion, including an empty sequence.
Returning the boxed exception sentinel from main is insufficient: the platform return adapter
converts numeric values, while the source wrapper handles exception reporting before returning.

The caller owns bindings through installation and retains provider images/installations while
the host uses them. Image capture owns host symbol names and bytes; installation pins provider
code identities. Compiler resets may occur after capture and before installation or execution.
The cache owner and automatic Script selection/name generation remain separate work, along with
shared lexical environments and Test262 worker integration.

## 2026-09-10 — Shared Script assembly selects canonical realm objects

`image-run-shared-program!` assembles fresh data copies from installed units. It selects the
first global and each named intrinsic as canonical, then supplies identity bindings and property
unions to the runtime boot passes. The private runner keeps its existing isolated-unit behavior.
Assembly accepts retained Script initializers and native host images without a global root. It
rejects closed-world Script images and reports unsupported shared lexical environments before
execution. The callable ABI alone does not authorize sharing a closed-world heap template.

Intrinsic methods in the current function-object representation own prototype objects. Capture
records those objects under their owning method names in a separate identity namespace. They
are representation-owned objects, not additional specification intrinsics. Canonicalizing these
references lets property validation compare the methods' own properties by identity.

External-boundary compilation materializes Object and Function even without local source uses.
Otherwise two units can encode null and Object.prototype or Function.prototype for the same
initial prototype link. The property merger must reject that mismatch; it cannot infer whether a
null prototype means absent compilation demand or intended state. A regression reproduced this
failure before the foundational-intrinsic change.

Native regressions assemble different intrinsic method subsets, reverse canonical selection,
reuse installed text in fresh GC-stressed realms, and compare retained data/text snapshots after
execution. A separate case checks a source function compiled without intrinsic uses from a unit
that observes its prototype and calls it through Function.prototype.call. High-level source
orchestration and Test262 harness caching remain unfinished.

## 2026-09-10 — Boot-time property unions preserve canonical object state

`RtProgram.object-property-merges` supplies assembler-authorized source/target pairs after
identity binding. `rt-unit-merge-object-properties!` validates the complete batch before any
property mutation or managed allocation. It requires adopted object payload boundaries with
compatible layouts, equal prototype references and matching extensibility. Duplicate properties
must agree on attributes and SameValue values, including duplicate additions from other sources
in the batch. Strings compare by content; object values must have canonical identity already.

The pass walks each source backing store in property insertion order, then defines missing
properties through `rt-prop-define`. It preserves descriptor attributes without invoking
accessors. The source snapshots root planned reference values through allocation. The pass
requires an unstarted, identity-bound realm and finalizes property assembly once, including an
empty batch. The high-level image runner still supplies an empty batch until source identity
selection and property-closure assembly connect to this interface.

Backing-store growth may collect during boot, before a generated frame exists. During the
explicit `assembling-properties` phase, the normal collector uses realm/static roots and the
helper's explicit roots, with no frame cursor. It rejects a generated map token or caller SP in
that phase. Forwarding, remembered-set scanning and heap verification use the existing collector
path. GC stress also applies to boot allocations. The phase ends before Script execution.

Two runtime regressions cover union order, descriptor/reference preservation, equal strings and
minor/major collection with a 64-byte nursery, plus rejection of conflicting existing/pending
properties, prototype mismatches, interior addresses and invalid lifecycle calls. These are
runtime merge tests; independently compiled intrinsic-method assembly remains to be connected
and verified. The Test262 harness cache is still unfinished.

## 2026-09-10 — Retained initializer sequences stop at the first abrupt completion

`callabi-script-sequence!` accepts an ordered list of retained Script initializer targets with
the generic callable signature. It emits ordinary calls and branches on each completion. Only
the normal arm reaches the next initializer; exception arms join an exit with the corresponding
memory state and exception sentinel. The helper leaves the pending exception untouched. Normal
completion returns undefined. An empty sequence preserves incoming control and memory without
an argument-vector allocation; a nonempty sequence shares one empty argument vector.

The native initializer tests now use this helper. Their post-sequence inspector remains outside
the sequence so tests can examine effects and the pending exception after an expected failure.
Five new regressions cover first and middle throws, ordered success, empty setup and skipping
later declarations after an instantiation failure. The exception cases allocate a thrown object
and reuse installed text across fresh GC-stressed realms.

This is the graph-building helper for source orchestration. The high-level runner and Test262
cache still need integration. Shared intrinsic assembly must also merge the property sets
materialized by different units: an identity map alone cannot preserve methods absent from the
chosen canonical object's template. Object payloads have fixed layouts, while their property
backing stores carry shapes and descriptors. The assembler must preserve both identities and
the union of those initial properties before evaluating Scripts.

## 2026-09-10 — Retained Scripts create object-record declarations at execution

Reusable Script units no longer precreate source var/function properties in the heap template.
Their retained initializers check the executing global before creating bindings. The parser
selects the last function declaration for each name, checks those names in reverse declaration
order, checks vars, then defines the selected functions in source order and creates var bindings.
A failed check returns an abrupt completion before the declaration writes or Script body.

JSL checks own-property descriptors and extensibility. Function creation replaces configurable
accessors with writable, enumerable, non-configurable data properties without invoking their
setters. It preserves the attributes of an admissible non-configurable data property. Var
creation preserves existing own values and attributes; a new binding starts as undefined.
Both use the shared property descriptor validator and completion handling. These operations
follow the ordinary object-record parts of [GlobalDeclarationInstantiation](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-globaldeclarationinstantiation)
and [CreateGlobalFunctionBinding](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-createglobalfunctionbinding).

The syntactic may-throw pass includes external Script roots, including declaration-only bodies.
Boundary mode is available during that pass; retained-unit mode is selected after syntax
collection. Seven native regressions cover declaration timing, descriptor rules, duplicate
function order and failure before mutation, reusing installed code across GC-stressed realms.
The test host checks completion and invokes an inspector after an expected failure to verify
the unchanged state and TypeError. That inspector is test orchestration, not Script evaluation.

This supersedes the object-record declaration gaps below for retained Script units. Closed
programs retain their existing static setup. Cross-unit lexical records and conflict checks,
shared intrinsic assembly, a source runner that stops on abrupt completion, and owned harness
cache integration remain required. The Test262 runner still recompiles its harness per variant.

## 2026-09-10 — Var initializers retain the assignment reference

`SsVar` initializer lowering now resolves the name before evaluating the initializer and
uses the same retained reference as assignment expressions. At the external-mutation boundary,
PutValue honors current setters and property attributes. A throwing RHS bypasses the store.
Declarations without an initializer do not assign. Local bindings keep Scope assignment.

The may-throw walk accounts for the implicit PutValue as well as the initializer expression.
Three native regressions cover an allocating RHS with a global setter, strict and sloppy
read-only globals, and an abrupt RHS. The tests reuse installed initializers in fresh
GC-stressed realms. This follows VariableDeclaration evaluation in ECMA-262 14.3.2.1.

This supersedes the initializer gap below; `lower-store-name!` is gone. Script declaration
creation remains separate: function instantiation still uses `lower-global-store!`, and the
heap template still precreates var slots. General source assembly must implement declaration
instantiation, shared intrinsic identities and initializer-abort handling before harness
cache integration can use these units.

## 2026-09-10 — Assignment retains its global environment reference across the RHS

At the external-mutation boundary, `lower-ref-prepare!` resolves nonlocal object-record names
before the assignment RHS. `SyntaxRef` retains the boxed environment object, key identity and
runtime HasBinding result. Keeps preserve those nodes through RHS control flow and collecting
calls; release balances them after PutValue. Local bindings and restricted globals keep their
existing precedence. Nonlocal lexical references still refuse rather than fall through to the
object record.

JSL consumes the retained reference. A strict unresolvable write raises ReferenceError even if
the RHS created the property. For a resolved environment reference, strict SetMutableBinding
also checks whether the property still exists. Set then honors current descriptors and setters;
sloppy unresolvable writes use ordinary Set on the retained global object. Setter exceptions
propagate through the parser's completion handling. Assignment expressions keep their RHS value.

Compound assignment, logical assignment and prefix/postfix update use the same retained
reference for GetValue and PutValue. The read checks the saved resolution before reading the
current binding. No source parser identity or unit-local property ordinal survives as a runtime
binding decision.

Six native regressions cover declared/imported setters, sloppy property creation and attributes,
strict unresolved writes whose RHS creates the property, an intrinsic name absent from the
executing realm, strict/sloppy read-only writes and compound/logical/postfix updates. Each helper
reuses installed code across different callers and fresh GC-stressed realms.

This covers assignment and update expressions at the external boundary. `SsVar` initializers
still use `lower-store-name!`, and Script function instantiation still uses `lower-global-store!`.
Their declaration/reference lifecycle must join the source assembler rather than inherit raw
slot writes. Global lexical records, intrinsic assembly, initializer-abort orchestration and
owned harness cache integration remain unfinished. Closed-program assignments retain their
existing lowering.

## 2026-09-10 — Declared external globals use environment reads too

The external-mutation boundary now routes `lower-global-load` through the same JSL binding read
as an unknown object-record name. A source declaration does not prove that a configurable
property still contains data: another Script can install an accessor. Reading the accessor's
storage word would expose its getter/setter pair as a JavaScript value and skip its effects.
The JSL path calls the getter and propagates its completion.

At this boundary, `typeof` resolves object-record names at execution even when the compilation
knows their declarations or intrinsic names. An absent property yields undefined; an existing
getter can throw. Scope bindings, lexical/TDZ checks and restricted globals retain precedence.
The closed-program own-slot path and its earlier-Script diagnostics remain unchanged.

Four native regressions cover getter results, throwing getters under reads and `typeof`, and
a declared intrinsic absent from the executing global. The tests reuse installed text across
fresh GC-stressed realms with different caller-supplied values.

Writes remain separate work. `SyntaxRef` currently records local-versus-nonlocal resolution,
but no runtime global-binding presence before the right-hand side. A correct assignment path
must preserve that reference classification across RHS effects, then apply environment or
unresolvable-reference PutValue semantics. Testing presence only after the RHS would be wrong.
Global lexical records, declaration lifecycle, intrinsic assembly and harness cache integration
remain unfinished.

## 2026-09-10 — External source reads resolve object-record bindings at execution

At the external-mutation boundary, a name absent from the unit's declarations and local scopes
uses `JsGlobalObjectBindingRead`. JSL checks the executing global object's property chain before
reading the value. An absent binding raises a catchable ReferenceError; an accessor can return
an abrupt completion. `typeof` uses a runtime property read for these names, so another unit's
property can affect the result and a getter exception still propagates.

The parser consumes both operations through its completion handling. Its early may-throw filter
conservatively includes name expressions at the external boundary because it has no lowering
Scope there. Return types remain authoritative and can eliminate checks after local resolution.

External Script compilation materializes ReferenceError. The language-created error uses the
intrinsic prototype identity, without reading the mutable global constructor or its `prototype`
property. It has no own message, which the specification permits for an implicit ReferenceError.
Realm assembly must bind this intrinsic identity along with the other unit-local identities.

This is the object-environment path. Cross-unit lexical environments and TDZ, unresolved writes,
and automatic declaration/intrinsic assembly remain required. Closed-program unresolved names
retain their existing refusal behavior. The Test262 harness cache is not integrated yet.

## 2026-09-10 — Resolved realm bindings update code maps and template references together

`RtProgram.object-bindings` carries assembler-resolved source/target payload addresses for one
fresh realm. After image adoption, `rt-unit-bind-objects!` validates the batch and applies the
same terminal mapping to per-unit object-address arrays, boxed reference words listed by the
heap images, and the published global root. The runtime preserves reference tags. It borrows
the binding input for the call and retains no pointer to that input.

Validation requires exact adopted payload boundaries, equal payload sizes, GC metadata and
shapes. It rejects duplicate sources, self-bindings, chains and cycles. Distinct payloads in one
source image must remain distinct after mapping, including objects that have no code-map entry.
The runtime completes these checks before rewriting maps or fields. Region-range membership
alone cannot establish a valid binding target, so validation constructs an exact payload index.

Binding belongs to boot, before managed allocation or generated-code execution. Finalization
also occurs for an empty batch. A finalized realm rejects rebinding and additional image
adoption. The caller retains the adopted regions until realm teardown; their immovable payloads
remain GC roots after canonical references point across images.

The runtime checks storage invariants. The source assembler must still prove semantic permission
to bind objects, including external-mutation assumptions, compatible intrinsic definitions and
declaration lifecycle. The high-level native image runner currently supplies an empty batch.
Automatic intrinsic resolution and source-unit assembly remain unfinished.

## 2026-09-10 — Static object identity uses realm-owned address maps

StaticRef machine code selects a unit's object-address map through X28, then loads the payload
address for its local object ordinal. It no longer adds a baked payload offset to a unit base.
The sequence still occupies 36 bytes and uses X16 as scratch. The installer retains its existing
slot relocation and validates each local ordinal against the owned image's entry count. Native
ABI descriptor version 4 includes the object-map heap-context contract.

After validating and adopting an image, the runtime walks its payload boundaries and constructs
the map. The realm owns these arrays and frees them at teardown. Mapped payloads belong to
immovable static root regions; the map does not keep a separate movable reference. Both linked
slot zero and installed code slots use this path. Unit bases remain available for image ownership
and adoption checks.

Source image capture also retains global and intrinsic object identities: specification names,
data payload offsets and callable flags. This covers registered prototypes and namespace objects,
plus materialized intrinsic functions. The image owns the names across compiler reset. Capture
rejects duplicate identities, invalid object layouts and changes to live installations.

The runtime initially constructs one-to-one local maps. Realm assembly still needs to resolve
shared intrinsic identities and relocate references stored inside heap templates to the same
chosen objects. Merely redirecting code references would leave template references inconsistent.
Any future alias map must also preserve distinct local object identities and the optimization
contract under which the unit was compiled. The owned names alone do not authorize aliasing a
closed-world image or certify a retained callable body.

## 2026-09-10 — Reusable Script code reads the executing realm's global root

For reusable Script units, both frontend global access and JSL `%GlobalObject` lower to a
memory-dependent load of `RtHeap.global-object`. An embedding host chooses that root before
invoking the unit. The compiler keeps the unit's global template as layout data, but does not
use its address as proof of the executing realm's global identity.

`heap-global-entry` continues to identify the layout object. `heap-global-reference-entry`
reports whether lowering may use a static reference; shared-global mode returns the existing
absent-entry marker and lowering emits the runtime-root load. The parser configures this mode
before lowering and the heap reset clears it. Closed-program compilation retains static global
references. The external-mutation boundary still governs property and call optimization.

The native regression binds a global from a second code image, invokes the retained Script
initializer and calls a retained source reader. The reader checks named globals, non-strict
`this` and the function declaration installed by the initializer. Two independent callers supply
42 and 99; each runs in two fresh realms under GC stress. An earlier version reproduced the
wrong result from unit-local global references.

This contract does not yet provide automatic source-unit realm assembly. The runtime still
rejects competing published global roots. Shared intrinsic identities and declaration creation
at Script instantiation remain required before the assembler can compose source units.

## 2026-09-10 — Reusable Script units retain generic initialization entries

`pipeline-encode-script-unit!` compiles Script sources with an external-mutation boundary and
retains one generic callable adapter per Script root. Callers need no named function export to
retain top-level setup code. The adapters use the existing five-argument JavaScript ABI and
return a boxed completion. The optimizer keeps their unknown-caller paths; the source bodies
remain private implementation details behind those adapters.

`pipeline-capture-script-image` resolves each initializer to an owned text-symbol index before
compiler scratch reset. `image-script-initializer-binding` exports that entry from a live
installation. Capture and binding validate the serialized ABI without constructing compiler
types. Closed-program images retain an absent initializer marker and cannot supply that binding.

In Script-unit mode, the first Script installs its function declarations during initialization,
as subsequent Scripts do. Its initial global function properties contain undefined. Ordinary
closed-program capture retains its existing first-Script image initialization. Var properties
still exist in the image; this change does not implement per-Script declaration creation or a
shared lexical environment across source units.

The native regression calls two retained initializers in order, then reads their shared state.
It repeats execution in a fresh realm with the same installed text and forced collection. The
embedding caller still owns sequencing and completion handling. Program-level exception-abort
orchestration, cross-unit global/intrinsic identity and the Test262 native harness cache remain
unfinished.

## 2026-09-09 — AOT images can execute in memory; compiler scratch is generation-owned

`pipeline-encode-sources!` runs the same closed-world optimization and native backend as object
export. `CodeImage` copies final text, heap templates, shapes, stack maps and relocation records
out of compiler scratch. It contains no graph/type/shape-table pointers. The Darwin/AArch64
installer resolves runtime imports directly to Coil functions, emits checked branch veneers,
applies data references, protects executable writes and invalidates the instruction cache. This
is eager AOT compilation into memory, not speculative execution or a dynamic JavaScript compiler.
No per-program external linker or executable launch participates in this path. The existing
object/link path remains available.

The runtime accepts an explicit program descriptor; file-backed executions keep section lookup.
An installation retains executable text and immutable metadata across executions. Each execution
copies writable image templates into its realm and binds them through the unit-base table (the
2026-09-10 decision below supersedes the initial single-use installation). Realm teardown releases
both generations, metadata and runtime shapes; the embedding owner then frees data copies.
Uncaught JavaScript completion ends the Script sequence
and returns status 3 to the embedding host, while the ordinary executable still exits 3. The
immutable image can be installed again. One realm is active per worker; runtime singleton state
is not thread-safe.

Compiler singleton payloads and allocations live behind a generation-scoped allocator. Capturing
an image transfers ownership by copying; resetting the generation then reclaims all graph,
frontend and backend scratch. Static accessor slots contain only an epoch and payload pointer.
All compiler state must use that boundary; runtime and explicitly owned artifacts must not.

The reusable JSL library cache owns immutable parsed forms in a separate region. Its exact key
is the index path/content/order plus every source's content. Successful checking can be reused
because checking depends only on that full table and the current executable's rules. Interned
types, graph nodes, global facts, function indices and optimization results are rebuilt for each
closed program. Test262 supervisors prime the cache before fork, so replacement workers inherit
it too. This does **not** implement separately compiled native harness units: those still need
a stable cross-unit source-call ABI and conservative optimization/effect contracts. No specialized
whole-program graph is reused under another test's assumptions.

Persistent Test262 workers isolate fatal compiler errors and native crashes. Success and ordinary
JavaScript throws reuse the process; fatal refusals require a forked replacement, not a compiler
exec or link. Transmission, compilation/installation and execution are deadline-bound; retained
output is bounded. Expected runtime exception identity is still unimplemented and cannot produce
a negative-test pass from status 3 alone. The initial installer is Darwin/AArch64, process-local,
with checked 64 MiB text/veneer and ADRP reach limits, not a portable serialized artifact format.

## 2026-09-09 — Property attributes live in the shape tree; accessors are pairs

The object model had one kind of property: a writable, enumerable, configurable data slot.
`Object.defineProperty`, `getOwnPropertyDescriptor`, `defineProperties`, `Object.create` with
descriptors, `freeze`, `seal`, `preventExtensions` and their tests were 190 cases of the 1-in-20
campaign, and 114 of them define accessors.

**Decision.** Attributes are part of the shape edge that introduces a field (`aot.shape`,
`aot.rt.shapes`): the transition map is canonical on (parent, key, attributes), so two objects whose
same key differs in writability have different shape ids, and a fast path proved against a shape
knows its field is a writable data property with no check — V8's descriptor arrays reached the same
conclusion. Changing an existing property's attributes rebuilds the chain with the new edge
(`shape-reshape-attrs`): the layout, and therefore every offset, is unchanged, only the backing
store's shape word moves. [[PreventExtensions]] is a marker edge (key zero, offset -1) that adds no
field and sets a flag every descendant inherits; freeze and seal reshape every field and then close
the object. An accessor property's word is its *pair*, an ordinary object with `get` and `set`,
flagged by the ACCESSOR attribute; there is no new heap kind and the collector traces it like any
object. The `__aot_shapes` blob is version 2, six words per row.

**[[Get]] and [[Set]] are one access each.** The first version asked the questions one at a time —
own attributes, then the chain's holder, then the holder's attributes, then the load — and inlined
the accessor and failure arms at every site. Each unfolded site became four runtime calls, the
getter/setter call sites made every function in the realm reachable, and the budget harness went
from 3,015 to 15,960 machine nodes. So the JSL asks one question: `%PropGetNamed` is ordinary
[[Get]] of a data property, own or inherited (`PropAccess` kind GET), and `%PropSetNamed` is
OrdinarySet's fast cases with the object as receiver (kind SET) — an own writable data property
takes the value, an absent key is added when the object is extensible and no prototype holds it as
an accessor or read-only property. Each folds where the owner's shape and prototype chain are known
(a literal under construction, an image object and its image chain under the closed-world facts):
a data property's read is one load, or the image word itself; an assignment is one store or one
static transition. Where nothing is known each is one runtime call (`rt-prop-get`, `rt-prop-set`),
never a chain of runtime questions. Both answer the exception sentinel when the slow path must
decide — an accessor found, a read-only property, a non-extensible object — and only then does the
JSL walk the chain explicitly (`%PropAttrsOwn`, `%PropChainHolder`), call the getter or setter on
the original receiver, or fail: a failed [[Set]] is a TypeError in strict code and nothing
otherwise, so the parser passes each assignment site's strictness to the JSL (`JsDefineOwnNamed`,
`JsSetKeyed`). The slow path never stores: every case the fast access refused is a call or a
failure. The runtime's `%PropDefine` is ValidateAndApplyPropertyDescriptor over a mask of the
descriptor fields named. `Object.keys` and `propertyIsEnumerable` honour the enumerable bit, so
built-in methods, `Math`'s constants and the intrinsics' global bindings are no longer enumerable,
as CreateIntrinsics makes them.

**The store contract.** Every `PropAccess` store — `%PropStoreOwnNamed`, `%PropStoreOwnNamedAttrs`,
the SET access — writes the value of a present writable data property and leaves its attributes;
the attributes it carries are those an *added* key takes (the default, or a function's `prototype`,
a class's methods). The runtime's `rt-prop-set-own` and `rt-prop-set-own-attrs` keep the same
contract, so a fold and the generic path agree. The first version required the store's attributes
to equal the key's before folding in place, which made every write to a `var` global (attributes
`writable, enumerable`) generic.

**Types carry the facts.** In a program that defines no descriptor (`facts-descriptors?`), the
attribute word is typed `int[-2..7]` and a [[Get]] result excludes the exception sentinel, at the
access and at the primitive it expands to alike (`prop-attrs-ty`, `prop-get-ty`, aot.node.jsops).
The accessor test is `attrs < 8` and the sentinel test a TypeTest, so both fold away and with them
the getter and setter call sites that would make every function reachable. The realm image
defines no accessor; `heap-define-own-attrs!` refuses one, since these types assume it.

**Facts and optimization alternate.** The optimistic pass folds under the facts and leaves a
smaller graph: the accessor arm that was live only because no attribute type had folded yet is
gone, and with it the setter call that made every assigned object escape. The pipeline rescans
that graph and optimizes again until a rescan marks nothing new, at most three rounds
(`pipeline-opto-under-facts!`; two in practice). Every earlier fold stays justified: it was proved
on facts about a program the round only rewrote equivalently.

**Consequences for the folds.** A stored key of an image object may have changed attributes only
if the program defines attributes somewhere (`facts-descriptors?`, set by the analysis when any
define, integrity or preventExtensions primitive exists); while it does not, the fixed-offset
access of a stored key still folds, and once it does, only never-stored keys fold. The static store
paths transition with the attributes they are given and go generic on a non-extensible shape. The
budget harness: 3,015 machine nodes before descriptors, 2,914 after (docs/COMPILE-TIME.md).

**Not yet.** Accessor syntax in object literals (`{get x() {}}`), `defineProperty` of an array index
or `length`, `delete`, `Object.getOwnPropertyNames` and `Reflect` (docs/GAPS.md).

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

The 2026-09-10 stable callable-entry decision below supersedes this section's single-entry,
program-wide-slot rule for function-object code words. The object layout and finite-target
contract remain in force.

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

## 2026-09-10 — Function objects publish a stable callable entry

We separate the function-object entry from the optimized local entry. Reusing compiled code
across programs requires a calling convention whose shape does not depend on the importing
program's maximum formal count. `aot.codegen.callabi` defines version 1 with five arguments:
boxed callee, boxed receiver, boxed `new.target`, nonnegative raw argument count, and a managed
argument-vector pointer. The entry returns the existing boxed completion, including the exception
sentinel. On AArch64 these arguments occupy X0 through X4 and the completion returns in X0;
the existing JavaScript call contract supplies stack alignment, register kills and the X28 heap
context. Ordinary Call/Fun/Parm nodes carry memory and control across the boundary.

The caller evaluates actuals in source order, then allocates and initializes one boxed word per
actual in a compiler-owned vector. An empty vector has one initialized undefined word and count
zero. The collector scans the vector with the runtime's elements descriptor. JavaScript cannot
observe it as an Array or mutate it through properties. A formal read tests its index against the
actual count, returns undefined on the missing path, and retains bounds-check control on the load.
Supplied undefined still contributes to the count. Extra actuals remain in the vector.

For current source bodies, we emit a callable adapter that reads the declared formals and forwards
receiver, new.target and values to the local boxed-slot entry. The adapter pads unused local slots
with undefined. Function objects name the adapter's distinct function identity; known direct
calls can name the local entry. The optimizer can inline or specialize the local body under its
callers without changing the public calling convention. Source indirect calls and JSL
`%CallFunction` both use the stable entry. Script execution roots remain internal functions.

This ABI change does not establish a reusable compilation-unit contract by itself. The current
driver still closes the finite adapter target set over one composed program and recompiles its
graphs. Cached native units must additionally preserve conservative external effects, resolve
their executable closure, remap unit-local identities, and register runtime metadata across units.
We must not publish code optimized under a previous program's closed-world facts as generic code.

## 2026-09-10 — Declare imported functions separately from local bodies

We reserve compilation-local function identities for imports in a declaration table beside the
local Fun-owner table. An identity cannot name both. A declaration owns its symbol spelling and
declared signature in compiler scratch; reset discards that namespace. OP-EXTERN carries the
exact function-pointer type without a local Fun edge. Graph copying preserves the declaration
identity. This follows final Simple's CodeGen external-function map and ExternNode.

An imported call remains an ordinary Call/CallEnd. Following Simple's CallEnd, a declared external
target contributes reachable control, conservative public-memory effects and its declared return
type. Mixed local/imported target sets include that contribution and cannot inline the local
Return as though it were the sole target. A missing undeclared target keeps unresolved-call
behavior. These declarations do not authorize execution before program assembly resolves them.

The initial import contract permits allocation, exceptions and callbacks, plus arbitrary access
to realm state. The image-facts analysis treats imported results as unknown and arguments as
escaping, including mixed target sets. We have no unit-private image visibility contract yet, so
an unsummarized import invalidates image property, prototype and descriptor proofs even with no
object arguments. Adding a narrower effect summary requires evidence for those access limits.

ARM64 selection and object-symbol assembly preserve imported identities in call, address and
function-object code-word relocations. They must not substitute a dead-local-function trap for a
declared import. The memory installer still needs owned named imports/exports and program binding;
these low-level declarations alone do not establish a reusable JavaScript unit or harness cache.

## 2026-09-10 — Bind owned native images before installation

CodeImage owns text/data definition names and import names alongside its byte buffers and
relocations. Capture no longer resolves undefined symbols to process addresses. A callable-unit
capture has no host entry; process-entry capture still requires main. The installer resolves
imports for each installation, leaving the artifact's bytes and symbolic records unchanged.

A binding names one caller import and a text export from an installed provider. Export lookup
rejects missing or ambiguous names. Before allocating executable memory, import resolution rejects
duplicate or unused bindings, stale provider identities, addresses outside the provider's text,
and attempts to override a runtime symbol. Declared unit imports require explicit provider bindings;
only compiler-emitted runtime imports resolve through the runtime's symbol table. Existing BL veneers
and checked address relocations apply to unit imports.

Each installed caller pins its providers in the runtime code registry. Uninstallation refuses
while another installation imports that range. Releasing a caller releases its pins. CodeImage
tracks live installations and refuses free until they reach zero, so registered metadata remains
valid. Callers must retain the CodeImage descriptor at a stable address until uninstallation;
InstalledImage borrows that descriptor. Binding spellings need remain valid only during install.
The descriptor's installation count is mutable ownership bookkeeping; artifact content is immutable.

The native test compiles one generic argument-reader unit, destroys compiler scratch, then compiles
and runs two caller images against that retained installation. It covers extra and missing arguments
and moving collections across the image boundary. The provider uses the runtime's fixed elements
layout and has no realm-specific static objects. This does not prove general JavaScript unit-data
composition. Unit ABI fingerprints, generic callback closure, shape/key and realm-data bindings,
reusable IR artifacts, and harness cache integration remain required before publishing that feature.

## 2026-09-10 — Check native import representations without arena identities

Each text definition and declared unit import in CodeImage owns a native ABI descriptor. Selection
retains the function signature until capture converts it to bytes. The descriptor contains no
interned type IDs: an eight-byte AOTCABI magic, little-endian version/convention/arity words, then
one representation byte for the return and each argument. Version 2 fixes this Darwin/AArch64
register/stack convention, heap register, realm-unit table and value/GC representation contract. Changes to those
contracts require a version bump.

We distinguish integers, floating-point values, boxed values that may reference the heap, boxed
scalars, managed pointers, host pointers and code pointers. Unknown representations cannot bind.
The loader validates version, length and arity before comparing slots. A provider may return a
boxed scalar to a caller expecting a general boxed value; a scalar-box argument may enter a
general boxed parameter. The reverse directions could hide references from GC and are rejected.
Other representation classes must match. The host-entry wrapper has a distinct convention and
cannot satisfy an ordinary generated-code import.

Binding checks happen before executable allocation and provider pinning. A declaration name has
one signature within a compiler generation; conflicting declarations fail at registration.
Declared unit imports cannot fall back to a runtime symbol of the same spelling. This preserves
the separation between generated calls and the runtime's fixed host boundary.

This descriptor checks native transport and root representation. It does not prove nominal types,
integer ranges, dynamic tag refinements, semantic effect summaries, or generic callback closure.
Those belong to the reusable IR/unit contract. The stable JavaScript entry remains the generic
count/vector ABI; publishing harness code still requires that contract and fresh realm bindings.

## 2026-09-10 — Installed code qualifies GC maps and owns a registered PC range

We keep stack-map IDs local to a compiled image. A collecting call passes a 64-bit token whose
low 32 bits identify the local map and whose high 31 bits identify an installation. Installation
identity zero selects the ordinary linked-executable path. Positive identities increase without
reuse; the runtime rejects exhaustion before a token could become negative or collide.

The AArch64 encoder reserves a four-instruction MOVZ/MOVK sequence for this token and records its
offset, register and local ID beside the instruction bytes. Object export uses identity zero.
The memory installer checks the sequence and map record, then patches its private executable
copy with the installation identity. This fixed width preserves instruction layout and stack-map
return PCs. The compiler-owned CodeImage and its map records remain immutable.

The runtime code registry borrows an installation's text range and immutable maps until
unregistration. Registration checks map bounds, duplicate local IDs, local-ID width and return-PC
extent, and rejects overlapping text ranges. We allow registry changes only between realms; live
frames and function objects therefore cannot lose their code. Realm teardown preserves the code
registry, while image uninstallation unregisters before unmapping. Removing the last range frees
the registry's list storage without recycling its identity counter.

The collector resolves the first frame through the qualified token. It resolves callers by their
actual return PCs across registered ranges, using one cursor implementation for root tracing and
before/after verification. A PC in registered code without a matching map is an error, not an
implicit end of the stack. The linked-executable and explicit single-table test paths remain
available. Frame sizes must advance the walk; recursion depth has no fixed limit.

These rules establish code-metadata ownership across images. They do not yet assemble JavaScript
units into one realm: static-image roots, shape/key bindings, unit imports/effects, and reusable
IR/native artifacts still need the compilation-unit implementation.

## 2026-09-10 — Retain static roots from each realm data image

A realm owns a registry of borrowed static data regions. Adoption appends a region rather than
replacing the previous image. The collector scans all registered regions during minor and major
collections, and the reference verifier recognizes references into any registered region. Each
region retains its own entry-table offset and byte extent. Generated-code heap-field offsets
remain unchanged; the registry replaces fields beyond the generated-code portion of RtHeap.

The data owner must supply fresh writable bytes and retain them through realm teardown. Adoption
rejects an inactive realm, overlapping regions (including repeat adoption), invalid section bounds,
and a second image that would publish a global root. Bounds checks precede relocation writes.
Supplementary units must bind the realm's existing global rather than publish another one.

Heap reset and realm destruction share the release path for heap spaces, card metadata and the
static-region registry. Neither operation frees borrowed image bytes. Reset clears global and
exception roots along with the registry; destruction also releases shapes and program metadata.
Installed code remains registered across realm destruction.

Tests retain two copies of one unrelocated template through minor and major collection, cover
boxed and raw roots plus cross-image references, and repeat with fresh copies in another realm.
These images share shape identities. General unit assembly must still remap independently compiled
shape/key identities and provide per-unit data bindings to retained native code. This registry does
not by itself make source harness compilation reusable.

## 2026-09-10 — Retained text resolves static data through realm unit bindings

Amendment, 2026-09-10: the object-address-map decision above supersedes the base-plus-offset
StaticRef sequence described here. Installation slots and per-realm data ownership remain.

StaticRef selection now loads a unit base through X28 and adds the image-relative payload offset.
Function addresses keep Simple's ADRP/ADD form. Static references use a fixed 36-byte sequence:
load the realm's base table, materialize a 32-bit installation slot in X16, load that table entry,
materialize the 64-bit payload offset, and add it. Selection declares X16 as scratch. The encoder
finalizes heap layout before emission and records slot relocations apart from instruction bytes.

Linked executables use slot zero. The memory installer assigns positive slots through the code
registry, checks the reserved MOVZ/MOVK sequence and patches its private text copy once. An
installation keeps its slot until unregistration. Freed slots can serve later installations;
code identities still increase without reuse. A realm allocates its table through the highest
live slot, so sequential test installation does not grow the table with total campaign count.
Native ABI descriptor version 2 includes this new heap-context contract.

InstalledImage owns no writable data mapping. image-instantiate-data copies the immutable template
and resolves its code words against retained installations. image-run-program! checks the complete
import closure, rejects duplicate installations and creates fresh data copies. Runtime boot adopts
the primary image and supplementary images into their assigned slots. The collector retains them
as static roots. After return, realm teardown drops bindings and roots before the loader frees the
copies. Executable bytes, provider pins and code identities remain unchanged across executions.

The program runner currently requires identical shape/key namespaces across its units. Mismatched
namespaces hard-error until the compilation-unit assembler remaps them; source units must not
claim compatibility from native calling conventions alone. Units may share one global root, and
supplementary units cannot publish a competing global. General source initialization records,
semantic import contracts, callback closure and reusable IR/cache integration remain unfinished.

Native tests compile a mutable provider once, discard compiler scratch, and run separate callers
against that retained installation. A first call reads 42 and writes 99; a second call in the same
realm reads 99. Repeated executions restore 42 before the first call. Coverage also includes moving
GC, omitted/extra arguments, missing/duplicate program members and reuse of a freed binding slot.

## 2026-09-10 — Unit shape assembly owns canonical identities and local maps

`cu-shapes-compose` accepts immutable shape blobs in unit order and returns an owned shape blob
plus one local-to-program key/shape map per input. It interns key bytes and maps parent rows before
children. Canonical rows include parent, key, offset, field count, attributes and flags. Equal
property sets do not imply equal layouts: `{x,y}` and `{y,x}` retain their distinct offsets.
The shared root has identity 1; reserved string and elements shapes keep their runtime identities.
Input order determines program IDs, and repeated assembly of the same inputs produces the same
bytes. The result owns its names and maps outside the compiler generation allocator.

The assembler validates blob extents, reserved rows, key bounds, parent ordering and transition
layout before admitting metadata. Non-extensible markers preserve the parent's fields and cannot
introduce keys. `cu-remap-static-shapes!` validates headers and shape references before changing
shape words in a fresh image copy. It leaves reference/code fixups and global-root words unchanged;
their existing readers retain responsibility for validating them. Templates remain immutable.

This artifact does not authorize mismatched native namespaces yet. Generated key constants and
allocation shapes must carry symbolic identity through optimization and consume the unit maps.
The native runner retains its identical-namespace guard until that path is implemented and tested.
Source dependency resolution and reusable ideal-IR linking remain named hard errors.

## 2026-09-10 — Symbolic metadata IDs are payload, not integer constants

`KeyRef` and `ShapeRef` carry a unit-local ID in their node payload. Their integer type describes
an unknown runtime word. It must not describe the local ID: a consumer could fold that integer
before program assembly even if the reference node itself refused constant folding. Reserved
string and elements shapes keep their process-wide constant words.

GVN compares kind and local ID in the current compiler namespace. Graph copying retains both, and
debug labels print the kind and ID. Constructors reject invalid IDs and unsupported kinds.
Property analysis reads `keyref-local` to recover identity evidence without an integer singleton.
Image-fact analysis recognizes these references as non-object values and uses symbolic keys to
record precise writes. It retains the existing numeric-operand contract for current producers.

Tests cover ordinary integers with the same value, key/shape namespace collisions, arithmetic and
equality consumers through SCCP, mixed identity/integer Phis, graph copying and precise write facts.
The initial IR step left native selection unimplemented; the binding implementation below supplies
that path. The frontend migration remains unfinished, and the native runner's identical-namespace
check remains in force.

## 2026-09-10 — Retained text reads realm-bound key and shape maps

Native ABI version 3 adds slot-indexed key and shape map pointers to RtHeap. KeyRef and ShapeRef
select a 28-byte sequence: load the relevant table through X28, select the installation slot,
materialize the 32-bit local index and load its mapped word. X16 is scratch. Installation patches
the slot once; no canonical program ID enters retained text.

EncUnitSite now distinguishes data, key and shape references and records their local identities.
The installer checks namespace bounds and the reserved slot instruction words. Root-only units
use the implicit two-row namespace and need no shape blob. Metadata references need no data image.
The code registry retains the source namespace counts so runtime binding can reject short maps
before generated code indexes them.

RtProgram and its supplementary descriptors borrow explicit key/shape maps through realm teardown.
Runtime binding checks map coverage, invalid/root entries and canonical bounds before publishing
either pointer. A slot cannot be rebound within a realm. Programs that supply neither map use
realm-owned identity arrays, shared across their same-namespace units; supplying only one map is
an error. Heap release frees the slot tables and default arrays, clears their pointers, and leaves
borrowed assembly maps untouched. Metadata-only supplementary units still receive bindings.

A native test compiles and installs one metadata-reading entry, frees compiler scratch, then runs
it against two different owned assemblies and returns to the first. Results follow each assembly's
maps; text bytes remain unchanged. Tests also cover missing coverage, invalid identities, duplicate
binding, inactive realms and a root-only image with no static data.

That test exposed a graph-leaf entry bug: the prologue called rt-heap-state without saving LR.
Simple's FunARM emits no such bootstrap call. Our frame finalizer now counts a process entry as
non-leaf even when the ideal graph has no calls, preserving LR on both entry and return paths.
An exact-instruction regression checks the reserved LR/X28 slots.

At this milestone frontend/JSL key producers and allocation-shape immediates still needed migration.
The key-producer migration below handles the former. General native program assembly keeps
rejecting differing namespace blobs until allocation references use the maps too.
Source initialization, semantic import/callback closure and reusable IR/cache integration remain
unfinished.

## 2026-09-10 — Source property keys use symbolic native references

Parser lowering now creates KeyRef operands for named property operations, object-literal
definitions, constructor/prototype accesses and unresolved globals. JSL `%PropertyKey` produces
the same node. Property expansion preserves symbolic identity when it falls back to runtime
operations. Field offsets and attributes remain integer constants: assembly preserves their
layout meaning, while it remaps key identities.

JSL's named-property fast paths recover the local key through keyref-local, not through an integer
singleton type. Runtime keys keep the generic path. Image-fact analysis follows the same rule and
no longer accepts a numeric constant as evidence of a unit-local name. This prevents folding from
depending on a key ID that another assembly assigns to a different property.

Integer-mode EQ and NE compare two symbolic keys by local identity, including before GVN. We
require assembly to preserve key equality; runtime binding rejects maps that alias two local
keys. We cannot infer numeric ordering from those identities or compare them to an integer
literal at compile time. Floating comparisons and shape references retain their existing rules.
This restores lowering-time folding of JSL's named-key branches without exposing local IDs as
integer constants. The unchanged two-Script graph-size budget covers the regression.

Regression tests distinguish `%PropertyKey` from an integer with the same local value, retain
precise writes for symbolic keys and conservative writes for numeric key words, and compile a
Script mixing computed and named access. That Script retains a native key relocation and runs
twice after compiler scratch is discarded.

The allocation migration below handles the remaining shape operands. The source-key change does
not cache JavaScript harness code or establish source initialization/import closure.

## 2026-09-10 — Allocation headers use realm-mapped shape identities

Ordinary New shapes use the same seven-instruction map lookup as ShapeRef, on both the nursery
fast path and the collecting slow path. Reserved string and elements shapes keep their fixed
runtime words. Instruction sizing includes both lookups before branch and stack-map layout.

The fast path keeps its allocation header address in X16, writes the mapped shape through X15,
and uses X17 as lookup scratch. The slow path writes its shape argument to X1 with X16 scratch.
Both scratch registers belong to the call kill set. EncUnitSite records the slot register; the
installer validates that register against the two reserved MOV words before patching. Invalid
registers, X28 and register/instruction mismatches fail before execution.

A folded load of a fresh allocation's shape header now returns ShapeRef rather than a numeric
local ID. We preserve Simple's private allocation and memory rules; its calloc-based NewARM has
no runtime shape header. The symbolic identity describes our runtime's additional metadata.

Native tests load the actual header through bulk memory, withholding the dedicated shape alias
that permits folding. They install once, discard compiler scratch, execute with two assemblies
that assign different shape IDs, and return to the first assembly. Fast and forced-collection
executions must observe the mapped ID without any change to installed text. Encoder tests check
both scratch registers, updated stack-map offsets, and fixed reserved-shape handling.

The native program assembly entry below integrates these paths. Source initialization records,
semantic import/callback closure and reusable IR/cache integration remain unfinished.

## 2026-09-10 — Native program assembly binds independently compiled namespaces

`image-run-program!` validates the installed import closure and duplicate identities before
assembling shape blobs in the supplied unit order. It copies each unit's static data, resolves
code words and remaps shape headers in those fresh copies. The primary image may occupy any
position in the unit list; its data and maps come from that position, not from an assumed first
slot. Units with no static bytes still receive identity maps.

The runtime borrows the canonical shape blob, per-unit maps, data copies and descriptors through
execution. Teardown releases realm bindings and static roots before the runner frees the copies
and assembly. Installed text, provider pins and artifact templates remain intact for the next
realm. This replaces the runner's identical-namespace guard. Existing checks still reject missing
or duplicate installations and competing global images.

A native regression compiles a provider with named properties and callers with a different key
and shape namespace. It discards compiler scratch, runs the retained provider through each
caller, and reverses assembly order without reinstalling either unit. One call reads 42 and
writes 99; two calls in the same realm observe the mutation. Fresh realms restore 42. The test
checks immutable provider data/text and forces collection with reference verification enabled.

This entry assembles native transport and realm data. It does not authorize whole-program facts
across source units. Source declaration/initialization records, semantic import/effect and
callback closure, and reusable source IR/native-cache integration remain required for harness
reuse. The Test262 runner still recompiles its JavaScript harness per variant.

## 2026-09-10 — Script declaration plans separate source identity from realm bindings

The parser builds one declaration plan per Script. Global collection, initial-image function
installation and later-Script function initialization consume that plan instead of rescanning
the body for declarations. Top-level functions keep source order, including duplicates; var
names include nested statement declarations but exclude nested function bodies. Lexical names
keep let, const and class kinds. A syntactic `this.name` write has a separate effect kind, so
retaining its name cannot turn its assignment into a hoisted declaration.

Function references in a plan are contiguous Script-local declaration ordinals. The parser keeps
a separate generation-local ordinal-to-SyntaxFun table for lowering. `CuScriptDeclarations`
captures strictness, entry kinds and ordinals, with owned copies of the names and entry storage.
It contains no graph node, realm key, compiler function index or source-buffer pointer. Capture
rejects invalid kinds, noncontiguous function ordinals and ordinals on nonfunction entries.

The ownership test overwrites and frees its input buffer, resets compiler scratch, parses another
program and then checks both retained Script plans. It also checks independent strictness,
duplicate function ordering and exclusion of nested lexicals/function-local vars. Existing
multi-Script execution continues to test the production consumers.

These records describe declarations and candidate global-property writes. They do not retain
executable bodies, implement cross-Script lexical environments/TDZ, or authorize reuse of
whole-program facts. Binding the records to retained function objects, source initialization
entry points, semantic import/effect and callback closure, and owned reusable IR/native-cache
integration remain required for harness reuse.

## 2026-09-10 — Native Script bindings use image payload offsets

The source-to-memory pipeline captures Script declaration plans beside `CodeImage`. Each Script
has an ordinal-indexed table of function-object payload offsets in that image's data template.
The pipeline resolves SyntaxFun and heap-entry identities after encoding; the image owns copies
of declarations, names and offset tables. Memory-run and the Test262 memory worker use this capture
path before resetting compiler scratch. Image destruction frees the Script records too.

Capture checks the binding count, payload extent/alignment, data symbol and code-slot relocation.
A code-slot target may be local text or an import. The existing object writer uses the invariant
trap import when whole-program optimization removes an unreachable function body. We preserve
that relocation: an object binding proves neither body availability nor an open caller set.
The native tests retain duplicate declarations and independent Script strictness after compiler
reset, run the image in fresh realms, and reject missing/out-of-range/interior bindings. An unused
function test checks that its retained object still names the invariant trap.

This capture remains a description of one compiled closed world. Source initialization entry
points, shared global/lexical environments, retained callable-body contracts and semantic effect/
callback closure remain required before harness code can serve a different compilation.

## 2026-09-10 — Explicit source callable roots retain generic adapter callers

`pipeline-encode-sources-with-roots!` accepts Script/declaration-ordinal roots. It resolves them
after source lowering and before pessimistic iteration or caller closure. The default source
pipeline supplies an empty root list, preserving its existing closed-world behavior.

For a selected declaration, the parser marks its generic JavaScript adapter as escaping and keeps
its unknown-caller Start hook. The adapter therefore accepts the generic callee/this/new.target/
count/vector ABI without specializing to callers in the current compilation. The source body's
program-local ABI remains private: caller closure drops that body's hook, and the adapter's call
supplies the conservative argument values. Duplicate root requests are idempotent. Unknown
Script/ordinal requests and requests after caller closure hard-error. Parser reset clears roots.

Final Simple's FunNode keeps unknown-caller hooks for escaped function identities, skips those
hooks when deleting dead call paths, and declines ordinary Region collapse while callers remain
unknown. We apply that boundary to explicit source adapters, separately from function-pointer
materialization inside a closed world. The existing post-Opto retention rule keeps the adapter
and its reachable body code.

The native test compiles an uncalled source function once, captures its image, resets compiler
scratch, then installs two independent native callers. Thirteen arguments return argument 13;
one argument returns undefined. Both callers run twice in fresh realms against the same provider
installation. The function's image code relocation names emitted text rather than the invariant
trap. Parser tests cover hook selection, duplicate requests, reset and invalid/late requests.

Callable roots establish entry liveness and generic argument handling. They do not establish a
reusable JavaScript compilation unit: shared source environments, initialization entry points,
global mutation/import contracts, callbacks from other units and owned reusable IR/cache
integration remain unfinished. The Test262 harness cache is not enabled by this API.

## 2026-09-10 — Incoming callable roots impose an external mutation boundary

The source pipeline sets an external-mutation boundary when its callable-root list is nonempty.
It installs the boundary before syntax exception analysis and lowering. Under that boundary,
source reassignment analysis cannot justify a direct global-function call; the parser loads the
current global value instead. Its may-throw filter also treats those calls as potentially throwing,
since an outside write can replace the original target. Parser reset restores closed-world mode.
Adding a callable root after closed-world lowering hard-errors: setting the boundary after that
lowering cannot undo direct calls or exception decisions already embedded in the graph.

Image analysis seeds unknown-owner writes, prototype writes and descriptor changes, and marks
the image entries escaped and mutable. The pipeline repeats this seed on each analysis round.
This shares the existing conservative boundary for unsummarized outgoing imports. We have no
unit-private image visibility contract yet, so we cannot exempt an image object from outside
mutation based on the current source set alone. Default closed-world compilation keeps its
precise analysis and direct-global-call proofs.

The native regression compiles a source reader whose global begins undefined and has no writes
in its compilation. Two independent caller images write 42 and 99 to that global before calling
the retained reader. Both execute twice with fresh realms and the same provider installation.
Analysis tests check mutation marks without local stores and after recomputation. Parser tests
check the direct-call boundary and reset; the initial version exposed the may-throw assumption
described above, which now follows the same boundary.

This removes one class of stale proofs. The source image still owns its global object, and its
callback target type still enumerates local adapters. Shared global/lexical binding, source
initialization entry points, cross-unit callback/import closure and reusable IR/native harness
cache integration remain unfinished.

## 2026-09-10 — Function-pointer types include an opaque external target class

`TFunPtr` carries an external-target membership coordinate alongside its known function-index
set. This coordinate follows the same union, intersection and mixed-side difference rules as
the concrete set; duality preserves stored membership and flips the lattice side. An inhabited
external pointer is not a singleton even if it has one known local target. Text output marks it
with `+external`. The known-target enumeration excludes the opaque class.

At the external-mutation source boundary, function-object code loads admit known local adapters
and an opaque target with the generic JavaScript signature. Normal closed-world loads retain
their finite type. We allocate no fake function index or unresolved symbol for a future callback.
The existing indirect machine call executes the loaded address.

Final Simple's CallEnd gives declared imports reachable control, public-memory bottom and their
declared result without a local Return edge. An opaque callback contributes that same state.
Known local targets still link, but their Returns cannot narrow away the opaque branch. The
inliner defers while that branch remains possible, and image analysis applies external escape
and mutation effects even when no named import exists. Undeclared concrete targets still refuse;
an opaque class does not hide missing finite dependencies.

Tests check dual involution, meet commutativity/associativity and absorption across open/closed
types and their duals. Mixed local/opaque CallEnd tests preserve declared state through optimistic
reset and refuse local-only inlining. Image analysis tests apply external effects without a symbol
declaration. A retained source function calls callbacks from two independent native compilations,
returns 42 and 99, and repeats both executions in fresh realms under GC stress and verification.

The opaque callback mechanism removes the local-only target assumption. Shared source global/
lexical binding and initialization, program-level source import/ownership contracts, and owned
reusable IR/native harness cache integration remain unfinished.

## 2026-09-10 — Materialized function objects retain external generic callers

At an external source boundary, caller closure retains the generic adapter hook for a materialized
function object, even without an explicit Script declaration root. This covers hoisted objects
and function expressions created during execution. The private source body still receives its
arguments through normal graph callers; ordinary closed-world compilation keeps its existing
hook removal and specialization behavior.

Final Simple's Start receives escaped function identities from Stop memory, while public fields
remain externally callable independently of the current memory approximation. Here the external
mutation contract has no unit-private object visibility proof, so we retain materialized adapters
conservatively. Restricting retention to named roots would lose functions returned from a factory
or published in an object property. Pointer materialization already marks these adapters escaping;
caller closure now uses the same source fact at the external boundary.

The native regression first reached `aot_rt_trap_invariant` when a separately compiled caller
invoked a function returned by a retained source factory. With the hook retained, two independent
callers pass 42 and 99 and receive those values. A second regression fetches the function through
a returned object's `run` property. Both modes run twice per caller against one provider
installation, after compiler reset, with GC stress and verification. A parser test checks implicit
function-expression retention and restoration of closed-world behavior after reset.

This establishes conservative body retention for materialized source functions. Shared global/
lexical and intrinsic binding, Script initialization entry points and the reusable source/native
cache remain unfinished. Unsupported source constructs continue to refuse compilation.

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
