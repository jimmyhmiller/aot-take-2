# Implementation gaps

This is the inventory of work that is absent or incomplete. “Implemented core gap” means the
surrounding module is live and the omission must not be hidden behind a future-phase label.
“Unwritten subsystem” means its public scaffold hard-errors by name. `HANDOFF.md` owns priority;
this file owns completeness.

## Implemented core gaps

| Area | Missing behavior | Consequence |
|---|---|---|
| Dynamic values | Box/Unbox construction and payload access beyond numeric tags | Every checker-admitted singleton TypeTest is selected and encoded; producing and consuming the remaining tagged payload families still requires their runtime nodes |
| Return | Concrete RPC nodes/types for the final four-input shape | Source/JSL Returns carry concrete bulk memory; RPC is reconstructed as a Parm before code generation while Fun ownership remains separate metadata |
| Calls | Cross-unit resolution, captured environments and member-call receivers | Finite multi-target SCCP lookup and direct-call selection resolve targets through the compilation-local function registry; function objects exist and a value-taken Fun is never inlined away |
| Node API | Complete for every implemented node family | Includes cycle-safe two-pass selected-subgraph copy, payload preservation and Fun/Return + Call/CallEnd cross-link repair |
| Phi | Memory-specific same-op guards and the dominance-walk null merge | MemPhi construction, unary/binary scalar pull-down and structural zero/truthy-Cast merging are complete; Load/Store/MemMerge exist |
| Verification | Pointer/control/safepoint/unreachable-use checks | Core edge, dead-input, Phi arity, type and GVN checks are live; the remaining checks require their node families |
| Text IR/eval | Round-trippable graph text and IR interpreter | No durable reduced graph corpus or differential execution oracle |

Add’s Simple left-spine reassociation, constant sinking, Minus conversion, Phi-aware ordering and
Phi-constant push are implemented and regression-tested as of 2026-08-30; they are not open gaps.
Sub's two Minus normalizations and Mul's zero/power-of-two/`2^n ± 1` strength reductions and
Phi-constant push are also implemented and regression-tested.
Shl range sharpening and small-constant distribution are implemented. Dynamic-tag and function
pointer set meet now uses the exact complemented-set algebra in mixed high/low cases and carries
direct associativity regressions, preventing worklist-order-dependent SCCP results.
Tuples/signatures now support arbitrary arity, including memberwise dual/meet and return-type
replacement. Function pointers now carry a high/low set state and implement multi-target set
union/intersection, memberwise signature meet, dual, join and direct-call detection. Their lattice
laws and function indices above machine-word width are regression-tested.
Integer types now carry Simple's widening stage, arithmetic propagates it, and falling Loop Phis
advance through three widening identities before jumping to their declared bound. This bounds the
induction-range fixpoint and is regression-tested at both the type and graph levels.
Float Add/Sub/Mul/Minus and comparisons now fold IEEE constants and insert explicit `ToFloat`
nodes for mixed numeric operands. FunPtr types refresh when their Fun signature sharpens.
IterPeeps now performs Simple's unused-node cleanup and dependency wakeup after progress, and its
fixpoint audit checks monotonic types, both worklists, unused live nodes, and unapplied peepholes.
Optimistic SCCP now snapshots pessimistic types, resets to TOP, enforces both monotonicity bounds,
propagates to a fixed point, links finite function-target sets lazily, resolves recursive numeric modes, and exposes
a node/input-cone fixed-point proof predicate. Branch-local JavaScript truthiness produces pinned
Casts on each CProj for integer and dynamic-tag precision. Scalar Phi same-op pull-down and the
zero/truthy-Cast merge are implemented. The core graph verifier is live.
Temporarily HIGH CallEnd result projections remain attached during optimistic target discovery so
later Return linking can sharpen the original result node.
Phi uniqueness is control-live-aware, all-dead Regions collapse directly, SCCP numeric evidence
crosses CallEnd result projections, and post-SCCP peepholes receive every live node. The verifier's
GVN freshness check recomputes current structure. IEEE float rewrites preserve evaluation grouping
and independently rounded division rather than inheriting Simple's integer-safe algebra.
Calls remain deliberately site-unique in GVN. Production parser and JSL lowering construct calls
with bulk memory, linking aligns the callee memory parameter, and Return/CallEnd thread the result;
the null-memory constructor remains only for focused incomplete-graph tests.
Phi openness follows both its Region and its final input, including the reverse-close state. Nested
If folding recognizes the dominating predicate through a true-arm truthiness Cast. Same-op Phi
pull-down covers every currently implemented eligible unary and binary scalar arity.

## Partial frontend and JavaScript semantics

### 2026-09-07 — Function values over the shared ABI

Function expressions, arrow functions, nested and block-level function declarations (including the
Annex B `if`-arm and labelled forms), immediately invoked functions, a declaration read as a value
and a call through a binding all lower and execute natively. A function value is a heap object
under the FUNCTION prefix whose payload is prototype, properties, raw code word and boxed
environment; every source function shares the `[ret this new.target slot…]` ABI with the program-wide formal
count; a value call loads the code word, guards `%IsFunction` and traps to
`aot_rt_throw_type_error` otherwise (docs/DECISIONS.md, function values). Remaining in this
subsystem: captured variables (a reference to an enclosing function's binding refuses by name),
`this` binding, `new`, prototypes on function objects, methods, accessors, generators, async
functions, default and rest parameters, and reads or writes of Script-level global-object bindings
(a Script-level function declaration read as a value works; assigning to it, or touching an
undeclared global, refuses as a global-object property access).

Landing this exposed three latent defects, each now a hard error where it used to be silent:
a `Con dyn{null}` was not a constant type, so selection produced a zero-size placeholder with no
register class and every use read an uninitialized stack slot (wrong answers only once a
collection had reused the stack); property aliases started at the same number as the new function
payload aliases; and the allocator could colour a live range that had register uses but no machine
definition. `ty-constant?` now admits the null tag, a non-constant `Con` other than TOP/BOT panics
in selection, `ALIAS-FIRST-PROPERTY` follows the function aliases, and `ra-build-lrg!` refuses an
undefined live range. A boxed live range with a fixed definition and a conflicting fixed use also
no longer loops in the managed-root splitters: those apply only to ranges a safepoint restricted.

### 2026-09-08 — Graph size after TypeError objects

A store to an unknown receiver costs about 24 nodes (object-like test, store, two nullish-base
arms calling the shared throw builtin, the pending check); the smallest realm is about 790 nodes
because it instantiates `Error`, `TypeError` and their prototype objects and carries the throw
builtin. Follow-ups: a throw arm that jumps straight to the unwinding path instead of setting the
pending word and re-checking it; hoisting a function's pending checks when the base is proven
non-nullish by an earlier access in the same function. (Intrinsic function and prototype objects as
static data landed 2026-09-08 as the static heap image, docs/DECISIONS.md; the smallest realm is
now 56 nodes after opto. Still allocated per evaluation: function expressions and object literals in
a Script's straight-line top-level code, which also run exactly once — the test262 harness builds
`assert.sameValue = function …` that way — and would join the image under a "runs once" rule for
top-level straight-line statements.)

### 2026-09-08 — TypeError objects

Property access on undefined/null, calls on non-callables, `instanceof` with a non-callable right
operand and strict writes to non-writable globals throw TypeError objects. Missing: an operator's
TypeError (`Symbol` in ToString/ToNumber) is checked only at the next call or member site, not
right after the operator; `new` on a non-constructor; the runtime's remaining traps (ToPrimitive,
ToObject) are still hard refusals, not exceptions; error messages are ours, not any engine's;
`Error.prototype.toString` (an uncaught exception's report renders the value — an Error's name and message, a string, a number — in the runtime, `rt-render-value!`, not through the library).

### 2026-09-08 — Strict code

Strict code compiles and runs (docs/DECISIONS.md, strict code runs). Still missing under strict
mode specifically: `arguments` (unmapped or otherwise), the `TypeError` object for a write to a
non-writable global (a runtime trap today), and ReferenceError for an assignment to an undeclared
name (a runtime refusal in both modes).

### 2026-09-08 — Standard globals

`Object`, `String`, `Number`, `Boolean`, `Error`, `TypeError`, `RangeError`, `SyntaxError`,
`ReferenceError`, `EvalError`, `URIError`, `Array`, `Math`, `isNaN`, `isFinite`, `parseInt` and
`parseFloat` exist as intrinsics (docs/DECISIONS.md, standard globals; arrays; Math and the number
globals) when a program names them. `Math.max`, `Math.min` and `Math.hypot` see four arguments at
most and read an `undefined` argument as absent (`Math.max(1, undefined)` is 1, not NaN); every
built-in function carries a `prototype` object it should not (§10.2.4). Missing: every other global
(`JSON`, `Symbol`, `Date`, `RegExp`, `Reflect`, …, still refused by name at run time); prototype
methods other than `Array.prototype`'s (`Object.prototype.toString`/`hasOwnProperty`,
`Error.prototype.toString`, `String.prototype.*`) — the intrinsic table carries methods now, so
each is a JSL definition away; wrapper objects (`new String(x)`,
`Object(1)`: `ToObject` refuses by name); zero-argument calls read as `undefined` arguments
(`String()`, `Number()`); the runtime's TypeError traps are not `TypeError` objects, so
`assert.throws(TypeError, …)` cannot see them; object literals and `new Object()` do not share one
`%Object.prototype%` — an ordinary object's [[Prototype]] is null unless set, so
`Object.prototype.x = 1` is not visible through `{}`.

### 2026-09-09 — Function objects, Object and the primitive prototypes

`Function.prototype.call`/`apply` (apply over an array, up to four elements), `Object.create`
(without a properties object), `Object.getPrototypeOf`, `Object.keys` (own keys in insertion order;
an array's indices first), `Object.prototype.hasOwnProperty`/`toString`/`valueOf`/`isPrototypeOf`/
`propertyIsEnumerable`, `Number.prototype.toString([radix])`/`valueOf` and
`Boolean.prototype.toString`/`valueOf` execute (docs/DECISIONS.md, function objects). Missing:
`Function.prototype.bind` (a bound function is a closure), `Function.prototype.toString`, `name`
and `length` on functions, `arguments`; property descriptors — `Object.defineProperty`,
`defineProperties`, `getOwnPropertyDescriptor(s)`, `getOwnPropertyNames`, `freeze`/`seal`/
`preventExtensions` and their `is*` queries — since properties have no attributes yet (the
campaign's largest remaining bucket, 177 sampled cases); `Object.assign`, `entries`, `values`,
`fromEntries`, `setPrototypeOf`; `Object.prototype.__proto__` and `toLocaleString`;
`Symbol.toStringTag` in `Object.prototype.toString`; wrapper objects (`new Number(1)`,
`Object(1)`); `Number.prototype.toFixed`/`toPrecision`/`toExponential`/`toLocaleString`;
`Number.isInteger` and the other Number statics; `Object.prototype.valueOf` on a primitive returns
the primitive (no wrapper).

### 2026-09-09 — Strings

A primitive string's properties resolve on %String.prototype% (docs/DECISIONS.md, strings): `length`,
`s[i]`, `charAt`, `charCodeAt`, `at`, `indexOf`, `lastIndexOf`, `includes`, `startsWith`,
`endsWith`, `slice`, `substring`, `concat`, `trim`, `trimStart`, `trimEnd`, `repeat`,
`toString`, `valueOf`, `split` (string separators), `padStart`, `padEnd` and
`String.fromCharCode` execute. Missing: wrapper objects (`new String("x")`, `Object("x")`:
`ToObject` still refuses by name), `toUpperCase`/`toLowerCase` (Unicode case tables),
`codePointAt`/`fromCodePoint`/`normalize`, `replace`/`replaceAll`/`match`/`search` (regular
expressions), `localeCompare`, `substr`, the Symbol.split/RegExp separator forms of `split`,
`includes`/`startsWith`/`endsWith` rejecting a RegExp argument, a method reached only through a
computed key the program never spells as a member (`s['charAt']`, `a['push']`: intrinsic methods
materialize by member name, for every intrinsic, so enumerating a prototype's methods sees only the
named ones), and the ABI deviations shared with arrays: `concat`/`fromCharCode` stop at the first undefined argument, an explicit `undefined`
position or fill reads as absent, and at most four variadic arguments arrive.

### 2026-09-09 — Arrays

Array literals (with holes), indexed reads and writes through numbers and numeric strings, `length`
reads and writes (truncating, extending, `RangeError`), named properties on arrays, `typeof`,
`instanceof`, `Array.isArray`, `Array(n)`/`Array(a, b)`/`new Array`, `String(array)`, and the
methods `push`, `pop`, `at`, `indexOf`, `includes`, `join`, `toString`, `reverse`, `shift`,
`unshift`, `slice`, `concat`, and the callback methods `forEach`, `map`, `filter`, `some`,
`every`, `find`, `findIndex`, `reduce` (docs/DECISIONS.md, JSL calls JavaScript) execute natively
and under collector stress (docs/DECISIONS.md, arrays).
Missing, and the deviations the ABI forces: spread in literals and calls (`[...a]`, `f(...a)`) and
array destructuring (parse, refuse by name); the remaining callback methods (`sort`, `reduceRight`,
`findLast`, `findLastIndex`, `flatMap`) and `reduce` with an explicit `undefined` initial value
(taken as absent: the ABI cannot tell them apart);
`splice`, `fill`, `lastIndexOf`, `flat`, `keys/values/entries` and iteration (`for…of` needs the
iterator protocol); `Array.from`/`Array.of`; sparse-array semantics beyond holes (no dictionary
elements: a write at index 2^31 allocates); `length` as a non-writable/accessor target; the
generic-object forms of the mutating methods — push, pop, shift, unshift, reverse, slice, concat,
join, at (a non-array `this` throws `TypeError` instead of running the `[[Get]]`/`[[Set]]`-based
algorithm; the callback and search methods are generic, docs/DECISIONS.md); variadic arguments are taken up to the four ABI slots, and an
omitted argument is indistinguishable from `undefined`, so `Array(undefined)` is `[]` and
`push(undefined)` pushes nothing; the library iterates by recursion over an index because JSL has
no loop form (`loop`/`recur` admission is the next JSL feature) — one native frame per element, so
`concat` or `slice` of a large array runs deep (500 elements is 500 frames of 80 bytes; a hundred
thousand would exhaust the stack); `Array.prototype.toString` on a receiver whose `join` is
overridden ignores the override.

### 2026-09-08, amended 2026-09-09 — Global object properties

`this.name = v` in a Script's own code declares the global `name` (the global object's image shape
carries it, so the property and the binding are one word). A property created through any other
alias of the global object (`globalThis`, a variable holding it, a function's sloppy `this`)
transitions the global object at run time and every access keeps working: a Script's global
accesses are image-object property accesses at fixed offsets (docs/DECISIONS.md, image object
property reads fold under closed-world facts). Missing: `delete` of a global; the global object's
own prototype chain.

### 2026-09-09 — Property descriptors

Data and accessor descriptors, `defineProperty`, `defineProperties`, `getOwnPropertyDescriptor`,
`Object.create` with descriptors, `freeze`, `seal`, `preventExtensions`, `isFrozen`, `isSealed` and
`isExtensible` work over ordinary objects (docs/DECISIONS.md, property attributes live in the
shape tree). Missing: accessor syntax in object literals and classes (`{get x() {}}` refuses as
"object methods and accessors"); `defineProperty` of an array element or `length`, and of a
string's or function's exotic properties (`name`, `length`); `delete`; `Object.getOwnPropertyNames`,
`Object.getOwnPropertyDescriptors`, `Object.entries`/`values`, `Reflect`; a `Symbol` key. An
assignment to a primitive base throws in strict code but the sloppy-mode wrapper-object semantics
(a property created on a temporary wrapper) are not observable either way.

### 2026-09-09 — The image analysis is closed over the call graph but not over the runtime

`aot.node.imagefacts` follows values through Parms, Returns and the finite target sets of value
calls; a call whose pointer type names no finite set, a value stored into any object or array, a
thrown value and a runtime primitive's operand are escapes. An escaped object counts every key an
unnamed-owner store writes as written, so `this.k = v` in a function whose `this` may be an
escaped image object keeps `x.k` generic on primitive receivers. A define, freeze, seal or
preventExtensions is a store in the analysis's sense and sets `facts-descriptors?`, after which a
stored key's attributes are unknown, every attribute word is typed `int[-2..15]` and every [[Get]]
may answer the accessor sentinel, so the getter and setter call sites stay live and make every
function reachable: a program that names `Object.defineProperty` anywhere pays for accessors at
every unfolded site. A per-key or per-object accessor fact would narrow that; `delete` must register
the same way when it lands. The facts are rescanned after the optimistic pass folds under them
(`pipeline-opto-under-facts!`, at most three rounds), so a fold that depends on a call the first
round removes lands in the second.

### 2026-09-08 — finally

Abrupt completions run their finally blocks (docs/DECISIONS.md, finally): return, throw with or
without a catch, rethrow from a handler, a return in the block replacing the completion. Missing:
break and continue crossing a finally (refused by name); a finally's own throw replacing a
pending completion is handled by the same mechanism but has no test yet.

### 2026-09-08 — Exceptions

`throw` and `try`/`catch` execute (docs/DECISIONS.md, exceptions are a sentinel completion): a
throw inside a try is a jump to its catch carrying the value in a synthetic Scope variable; a throw
leaving a function stores the value in the runtime's pending word and returns the exception
sentinel; a call site whose callee may throw tests the result's tag and either takes the pending
value to its enclosing try (clearing the word) or completes with the sentinel; the entry wrapper
tests each Script root's completion (and `main`'s, in a function-entry program) and reports an
uncaught exception through `aot_rt_uncaught` with status 3 before any later Script runs. `finally` runs on normal completions; an abrupt
completion crossing a `finally` (a return, or a throw with no catch) refuses by name, as does a
destructuring catch parameter. Runtime refusals (non-callable calls, the unimplemented
conversions) are still hard errors rather than TypeError completions, and the uncaught report
prints the boxed word: naming the error constructor waits for `new` and prototypes.

### 2026-09-08 — Receivers, function objects and total coercions

`this` is the receiver slot of the enclosing non-strict function mapped by `JsSloppyThis`
(undefined or null becomes the global object; outside a realm that case refuses at run time) or,
in strict code, the slot itself; at a Script's top level it is the global object. `o.m(args)`
evaluates the owner once and passes it as the receiver. Function objects carry properties: the
object-like guard (`%IsObjectLike`, `%UnboxObjectLike`) admits the FUNCTION prefix to the same
property machinery, since the function payload begins with the object's two words. Value-taken
functions inline like any other; a Fun left without callers names the runtime invariant trap from
its code word. Duplicate hoisted declarations keep distinct symbols; the last one keeps the plain
name. Arrow `this` is a capture and refuses by name.

Arithmetic and comparison are total over the dynamic axis: `JsPrimitiveNumber` and `JsAdd` route
every tag either to a conversion or to a named runtime refusal (`aot_rt_unimplemented_to_primitive`
for objects, `..._to_string` for concatenation with a non-string, `..._string_to_number`, a
TypeError for Symbol), so programs whose operands the compiler cannot type still compile and only
the unimplemented conversion refuses when actually reached. ToPrimitive, ToString of numbers and
ToPrimitive is the conversion still to write (StringToNumber, parseInt and parseFloat run in the runtime through `%StringToNumber`, `%ParseInt` and `%ParseFloat`, `aot.rt.number`).

### 2026-09-08 — Property access as a node, the runtime shape tree, and the graph-size budgets

Own-property loads, has-checks and stores are `PropAccess` nodes (docs/DECISIONS.md, property
access is a node): they fold to a Load, a constant or the static transition when the owner's
backing store is visible through memory SSA, and expand once before type checking otherwise — into
one runtime operation over the shape tree (docs/DECISIONS.md, generic property access), never an
enumeration of shapes. The static shape table travels in the `__aot_shapes` section; the runtime
extends it. Remaining: the dynamic axis does not carry a struct, so a value that crosses a Box
loses its shape and every access through it pays the runtime call; a guarded small-set fast path
(a few shape compares before the call) is not built; a property read on an image object (an
intrinsic prototype through `JsGetNamed`'s string and array arms, a hoisted function's
`prototype`) is not folded even though the image shape is known at compile time
(docs/COMPILE-TIME.md §8 row 10); the runtime transition lookup is linear over
all shapes; `o[k]` interns its key at run time against the blob's key table (`aot_rt_intern_key`, minting
runtime ids for new names; linear search) and takes the named path — a constant string key is
not yet folded to its compile-time id; an array index key takes the element path at run time
(docs/DECISIONS.md, arrays), any other key is a named property; deletion, accessors, attributes, symbols as keys and dictionary mode do not exist. `tests/bloat-test.coil` holds node-count ceilings that fail on any
regression of this class; `iter-peeps!` and `iter-run!` panic with a trace of recent rewrites or
inlined sites instead of spinning; `property-expand-all!` panics if the shape universe grows.

Constructors and chains: `new` on a non-callable reads `prototype` before it tests callability, so `new undefined` reports `Cannot read properties of undefined` where the specification's EvaluateNew reports `X is not a constructor` (the type is right, the text is not); class
constructors, bound functions and `Symbol.hasInstance` are unimplemented (`new.target` is an
argument slot and executes in non-arrow functions: docs/DECISIONS.md, new.target);
`instanceof` on a non-callable right operand traps as a TypeError. A function DECLARATION nested
in a function is instantiated at every evaluation of its name, not once per FunctionDeclaration-
Instantiation, so `inner === inner` and `inner.prototype` identity are wrong there (top-level
declarations are instantiated once by GlobalDeclarationInstantiation and are correct); this is
the closures slice's job.

Harness status (2026-09-08): `assert.js` + `sta.js` + a test compile and run as one realm; a
passing test exits 0 and `assert.throws` works. The first refusal on a failing assertion and on
most real tests is a standard global (`Object`, `String`, …), named in the runtime message
(`reference to the undeclared global \`Object\``): the builtin library is the next slice, then
ToString of numbers in concatenation for the harness's messages.

Unresolvable names: a global declared by a later Script is a refusal only in the top-level code
of an earlier Script; a function body reads the slot when called, which yields undefined instead
of a ReferenceError if the call comes before that Script's instantiation. A read or write of a
name no Script declares refuses at run time with the undeclared-global message; the correct semantics (global object property lookup, ReferenceError
on a missing read, implicit global on a sloppy write) wait for global-object bindings as
properties. `typeof` of such a name is "undefined". Standard globals (`syntax-standard-global?`)
refuse at run time even under `typeof`.

Backend: a Script whose control never reaches its Return (`for (;;) ;`) panics in the loop tree
(`looptree-walk!: postvisited child has no loop tree`) — an infinite loop with no exit has no
path to Stop; a program with such a loop does not compile yet. The CallEnd optimistic rule that
keeps a continuation reachable while every linked Return is provisionally dead now defers to the
pessimistic answer when the parse already proved the continuation dead.

### 2026-09-07 — Diagnostics

`aot dump FILE PHASE [--dot] [--script]` prints the graph after parse, iter, opto, typecheck,
select, gcm, sched or regalloc as one `n-text` line per node (`#nid label :type <- inputs @block
rN`, where `rN` is the assigned location after allocation and numbers past the register file are
stack slots). `n-panic!` prints the offending node and its inputs before exiting; `ty-text` is the
one type notation. The runtime's `AOT_RT_GC_VERIFY` checks every mapped frame root and every live
object field before and after each collection and names the first stale pointer by frame, return
PC and slot. A pointer held in a location the maps do not describe remains invisible to it; the
allocator invariant above is what closes that hole from the compiler side. Not yet built: a
backtrace on panic without a debugger, and a per-safepoint dump of the stack maps.

### 2026-09-07 — Grammar-closure campaign follow-up

The campaign in `docs/TEST262.md` (4,222 files) found 3 false accepts, one bug: escaped
identifier StringValues were views into a growing lexer pool and dangled after reallocation.
Tokens now own their decoded text. With that, the parse-negative space is closed except for phase
imports (deliberate) and non-ASCII identifiers; progress on test262 from here means executing
positive tests: multi-Script realms for the harness prelude, function values and closures,
exceptions, constructors and prototypes, and the built-ins the harness touches.

### 2026-09-07 — Annex B for-in initializers and the fail-closed guard on unknown tokens

`for (var x = 1 in o)` parses in sloppy code (B.3.5: a plain `var` binding with an initializer in a
for-in head); the strict pass rejects it in strict code, and patterns, lexical bindings and `of`
heads keep their proven errors. Lowering of for-in still refuses. `syntax-error!` now fails closed
when the token in front of the parser is one the lexer cannot classify (a raw non-ASCII identifier
character, `@`): `var π = 1;` was a false SyntaxError before this guard and is a compiler error
now. Non-ASCII identifiers stay outside the admitted subset until the lexer carries the
ID_Start/ID_Continue tables.

### 2026-09-07 — Identifier escapes

The lexer decodes `\uXXXX` and `\u{…}` escapes inside IdentifierNames to their StringValue,
kept in a per-source pool the token references. ASCII code points are classified exactly (letters,
`$`, `_`, digits after the first); ZWNJ/ZWJ continue a name; a `\` not followed by `u`, a malformed
or out-of-range escape, a non-identifier ASCII code point (`\u0023!`, `\u007B\u007D;`) and a
surrogate are proven errors. Any other non-ASCII code point needs the ID_Start/ID_Continue tables
the compiler does not carry yet and fails closed (`Unicode identifier classification`), as do raw
non-ASCII identifier characters. An escaped IdentifierName is never a keyword or contextual word
(`\u0061sync function`, `st\u0061tic m() {}`, `l\u0065t x` are errors) but is still the name for
StringValue rules: escaped `await`/`yield` in their reserving contexts, escaped reserved words in
Identifier positions (`v\u0061r x`, `({v\u0061r})`), and strict-mode `let`/`eval`/`arguments`.
Property names and member access accept escaped reserved words (`x.\u0069f`).

### 2026-09-07 — Sloppy `let` identifiers and Annex B function declarations

`let` is an ordinary identifier outside strict code: bindings (`var let`, `function let() {}`,
parameters, catch), references (`let;`, `let.x`, `(let[0])`, `{let}`), labels and for heads
(`for (let in o)`, `for (let;;)`) parse, and the strict pass rejects every one of them in strict
code as a reserved word. Proven errors: `let [` never starts a Statement or an ExpressionStatement
(`let[0];`, `if (x) let\n[a] = 0;`), a same-line `let x` / `let {` in a statement position, `let`
as a lexically bound name (`let let`, `const let`, `let [let]`, for-in/of lexical heads), and the
for-of lookahead exclusions `for (let of …)` and `for (async of …)` (`for await (async of …)` is
admitted). Annex B.3.3 `if (x) function f() {}` parses in sloppy code as a synthetic Block holding
the declaration, recorded in `annexb-blocks` so the strict pass rejects it in strict code;
labelled function declarations (`a: b: function f() {}`) parse as labelled items in sloppy code.
Proven errors: generator/async declarations in either position, function declarations as
loop/`with` bodies, labelled functions as `if`/loop/`with` bodies (IsLabelledFunction), and both
forms in strict code. B.3.2's web-compat var hoisting of block functions is not modelled; the
lowering of nested function declarations still refuses.

### 2026-09-07 — `for await` as syntax

`for await (… of …)` parses inside async functions, async arrows, async methods and async
generators; `SsForIn` carries an `awaited` flag. Proven errors: `for await` outside an async
context (including nested plain functions and non-async arrows), `for await` with an `in` clause or
a `;` head, initializers on `of` heads (`var x = 1 of`, lexical and pattern bindings), and the
usual for-in/of head rules. Lowering refuses `for-await-of asynchronous iteration` by name; the
async iteration protocol (GetIterator async, Await on each step) is unimplemented. Annex B's
`for (var x = 1 in o)` still fails closed.

### 2026-09-07 — Patterns campaign follow-up

The campaign in `docs/TEST262.md` (4,006 files) found 20 false accepts, all in destructuring and
all fixed: a `...rest` element followed by a trailing comma is a valid literal but never a pattern
(tracked per literal in `rest-comma`), and for-in/of assignment-pattern heads are now visited by
the strict pass. Remaining parser refusals: phase imports (deliberate) and non-ASCII identifiers and regex group
names (`for await`, sloppy `let`, Annex B function declarations and for-in initializers, and
identifier escapes were admitted later the same day).

### 2026-09-07 — Regular-expression pattern early errors

`src/parse/regex.coil` validates every RegularExpressionLiteral body at parse time under the
grammar its flags select: the strict `u` grammar, Annex B's web-compat grammar without `u`/`v`,
and the `v` ClassSetExpression grammar; named groups switch on the N rules in every mode. Proven
errors cover quantifiers with nothing to repeat and out-of-order bounds, quantified lookbehinds
(and lookaheads under `u`), unterminated groups and classes, out-of-order and escape-bounded class
ranges, invalid identity/control/hex/unicode escapes, `\u{…}` out of range, backreferences to
nonexistent groups, `\k` without a named group, empty, malformed, escaped-surrogate and duplicate
(same alternative) group names, `(?ims-ims:…)` modifier repeats and empty modifier pairs, `\p{…}`
names and values checked against the Unicode 17 tables (exact spelling, no `Is`/`In` prefixes or
loose matching), properties of strings only under `v` and never negated, and the `v` reserved
syntax and double punctuators, mixed set operators and negated classes that may match strings.
The syntax-only panic on any regex literal is gone. Not classified: a non-ASCII code point in a
group name (ID_Start/ID_Continue tables are not in the compiler) fails closed as a compiler
error. Regex objects still do not lower (`regular expression objects`); the pattern is validated,
not compiled.

### 2026-09-07 — Destructuring patterns as syntax

Binding and assignment patterns parse everywhere the grammar admits them: `let`/`const`/`var`
declarations (with the initializer requirement, also inside `for (;;)` heads), formal and rest
parameters of every function form, catch parameters, `for (… in/of …)` heads (declarations and
bare patterns), arrow parameters through the parenthesized cover, and `=` assignment where an
unparenthesized object or array literal is the target. Patterns live in their own table
(`SyntaxPattern`: name, Reference leaf, object, array, each with an optional default); a literal
reinterpreted as a pattern is marked consumed so `{a = 1}` survives only inside one. Proven early
errors: rest element not last or with a default, object rest that is not a plain name (binding) or
simple target (assignment), method or call or optional-chain leaves, a parenthesized pattern or
parenthesized name where a binding is required, duplicate bound names across a parameter list or
lexical scope, catch-parameter/lexical conflicts, `yield`/`await` inside destructured parameters,
strict `eval`/`arguments` leaves, and destructuring declarations without initializers. Not yet
lowered — every form refuses by name (`destructuring declarations`, `destructuring parameters`,
`destructuring assignment`, `destructuring for-in/of heads`); the runtime needs iterator
destructuring (`IteratorRestArray`, `ObjectRest`) and per-leaf PutValue/InitializeBinding first.

### 2026-09-07 — Grammar-completion campaign follow-up

The campaign in `docs/TEST262.md` (2,933 files) exposed 53 false accepts, all fixed with
regressions: Annex B's sloppy duplicate-function allowance now requires every declaration of the
name in the Block to be a plain function; call-expression targets are web-compatible only for
`=`, compound assignment and update expressions; `await` inside nested arrow parameters of an
async arrow head is an error; `super.#x`, a private name right of `in`, arrows used as operands,
callees or `new` targets, `return` in a static block nested in a function, and non-strict code in
class heritage or computed keys are all proven errors. A required token that is missing is now a
SyntaxError in Script code unless the offending token is lexically unknown (identifier escapes,
non-ASCII identifiers, `@`); TypeScript entry mode keeps failing closed there. The remaining
parser refusals were destructuring patterns and regex pattern validation (both admitted the same
day, above), phase imports, `for await`, identifier escapes and Annex B function-in-statement.

### 2026-09-07 — Classes as syntax

Class declarations and expressions parse: heritage, methods (static, accessor, generator, async),
fields with initializers, private names, and static blocks. Class code is strict; field
initializers and static blocks are method-like contexts. Proven early errors: duplicate or special
constructors; static `prototype` methods/fields and `constructor` fields; duplicate private names
outside a getter/setter pair; `#constructor`; whitespace inside `#name`; references to undeclared
private names (resolved when the declaring class closes, through nested classes and functions);
`#name` anywhere but the left operand of `in`; `delete` of a private member; `super()` outside a
derived constructor and its nested arrows; `arguments` in field initializers and static blocks;
`await` and `return` in static blocks; field ASI; class names that are strict-reserved; class
declarations conflicting with other lexical names; and an arrow function as heritage. Unicode
escapes in element names fail closed at the lexer. Classes, private members and brand checks
refuse lowering by name; class heritage and computed keys are outside the strict expression walk.

### 2026-09-07 — Functions everywhere as syntax

Nested function declarations, function expressions, arrow functions (through the parenthesized
and `async(...)` cover grammars), object methods, getters, setters, generators and async functions
now parse with their contexts: `yield` and `await` are expressions only inside generator and async
bodies and reserved as binding names there, `new.target` needs an enclosing non-arrow function,
`super.x` needs a home method, `super()` a derived constructor (none exist yet). Proven early
errors: duplicate parameters with non-simple lists, arrows and methods; a `use strict` directive
over a non-simple parameter list; accessor arity; rest-parameter position and defaults; invalid
arrow parameters and a line terminator before `=>`; `yield`/`await` in formal parameters and in
arrow parameters; reserved function names; block-level function declarations conflicting with
`let`/`var` (with Annex B's sloppy duplicate-function allowance); and parameter/lexical conflicts.
Sloppy `let` names, Annex B function-in-`if` and labelled functions were admitted later the same
day, as were destructuring parameters.

The Script statement list is parsed under a root context so nested functions have a parent; only
declarations the program loop saw at the top level are hoisted closed-world Funs. Nested
declarations, expressions, arrows and first-class references to hoisted declarations became
function values later the same day (see above). Methods, `yield`, `await`, `super`, default, rest,
generator and async functions still refuse by name.

### 2026-09-07 — Primary expressions, member chains, templates and regex tokens

`this`, `new` (with and without arguments, nested), `new.target`, computed members, calls through
any callee, spread arguments, optional chains, array literals with holes and spread, `import()`,
template literals (untagged and tagged) and regular-expression literals now parse. Object literals
admit shorthand (desugared to a named property with an IdentifierReference), computed keys,
spread, string and integral numeric keys; methods, accessors, generators, non-integral and
escaped keys fail closed. Proven early errors: `this`/`new.target`/`import()`/optional-chain
assignment targets, `new.target` outside a function, `import.meta` and import/export declarations
in a Script, `import()` arity and spread, `new import()`, tagged templates and `new` on optional
chains, CoverInitializedName outside a pattern, private names in object literals, duplicate
`__proto__` across string and identifier spellings, template NotEscapeSequences, and regex flag
syntax. Phase imports (`import.source`/`import.defer`) and `super` fail closed.

Lowering executes a substitution-free template as its cooked string and object shorthand as the
named property it desugars to. `this`, `new`, `new.target`, computed access and assignment and
non-name callees execute; spread, optional chains, `import()`, template substitutions
(ToString), tagged templates, object spread and computed keys refuse by name (array literals now
lower; see the arrays entry). The regex pattern
grammar is not validated: a syntax-only verdict fails closed whenever a regex literal survives
every other check, so no pattern early error can be missed silently or falsely reported.

### 2026-09-07 — Iteration statements, labels and the remaining statement grammar

`do-while`, classic `for` (expression, `var` and `let`/`const` heads, optional test/update),
`continue`, labelled statements and labelled `break`/`continue` lower through final Simple's loop
and `jumpTo` protocol: one Loop with lazy Phis, a pruned Scope copy per jump, the first
`continue`'s copy becoming the continue Scope and the loop bottom merging into it before the
update and the backedge. A `do-while` exit and a labelled block exit start dead and receive their
paths by merge, as the switch exit already did. A `for` head `let` is one binding, not a
per-iteration environment; that is unobservable until closures exist and must change with them.

`for-in`, `for-of`, `throw`, `try/catch/finally` and `with` parse with their early errors
(head declarations, catch-parameter conflicts, `throw` line terminators, strict `with`, labels
that are strict reserved words) and refuse lowering by name: property enumeration, the iterator
protocol, exception completions and object environments are absent. `debugger` lowers to nothing.
Statement-position declarations (`if (x) let y`, `while (x) class C {}`, loop-body function
declarations, `async function` bodies) are proven SyntaxErrors; Annex B function-in-`if`, sloppy
`let` identifiers, destructuring heads, catch parameters, `for await` and `for (var x = 1 in o)`
were all admitted later the same day. The lexer gained a two-token lookahead for `let x` versus a bare `let` identifier.

### 2026-09-07 — Operator grammar, sum-typed syntax records and NaN branch codes

The parser now recognizes the full expression operator precedence and the comma operator. `>`,
`<=`, `>=`, `++`, `--` (prefix and postfix, on names and named properties), `,`, `&&=`, `||=` and
`??=` lower through production JSL (`compare.jsl`, `update.jsl`, the existing predicates) and have
a native regression. `%`, `**`, `&`, `|`, `^`, `<<`, `>>`, `>>>`, `==`, `!=`, `in`, `instanceof`,
`~` and `delete` are admitted syntax that refuses lowering by JSL entry-point name: remainder and
exponent need float primitives the checker lacks, bitwise operators need the distinct JS32
primitives noted below, loose equality needs string-to-number conversion, and `in`/`instanceof`/
`delete` need generic property keys and function objects. A sloppy-mode CallExpression assignment
target parses (it is a runtime ReferenceError, not an early error) and refuses lowering. Update
expressions on generic property reads still hit the unproven numeric Unbox refusal recorded below.

Grammar not yet admitted fails closed as a compiler refusal: arrow functions, computed members,
optional chains, templates, spread, `async`, labels, `for`/`do`/`try`/`throw`/`with`/`class`
statements, nested/expression functions, `this`/`new`/`super`/`import` primaries, regex
literals, object-literal shorthand/methods/computed keys, and `let` as a sloppy identifier (array
literals have since been admitted; see the arrays entry).

The native regression for runtime NaN comparisons exposed that AArch64 float `<`/`<=` used the
integer LT/LE condition codes, which are true for unordered operands. Both CSET and the branch now
select MI/LS from the FLAGS producer's register class (see `docs/DECISIONS.md`). No test262
campaign has been re-run since; the counts in `docs/TEST262.md` predate this change.

### 2026-09-06 — Assignment expressions and remaining property boundaries

`=`, `+=`, `-=`, `*=` and `/=` now parse as right-associative expressions in initializers, calls,
conditions, returns and expression statements. The lowering walk evaluates a named property base
once, preserves it across RHS rebinding, and uses the live post-RHS Scope for stores. Compound
updates read before evaluating the RHS and use production JSL arithmetic. Binary operands retain
their values across RHS assignment, and while/call lowering follows conditional Scope replacement.
Strict binding checks also visit nested assignment targets; const and TDZ checks remain active.

Compound arithmetic on a generic property read still fails the unproven-Unbox check, even for
`let o = { value: 2 }; o.value += 40`. A refusal regression records this missing conversion or
memory-proof capability. It does not count as a semantic or Test262 pass. Logical/bitwise compound
assignments, updates, destructuring and computed References remain unsupported.

The existing `JsGetNamed`/`JsDefineOwnNamed` data-property model lacks accessors/descriptors and
nullish-base exceptions; its non-object fallback is not full JavaScript `[[Get]]`/`[[Set]]`.
The shape prepass also closes transitions across all source write keys, which can grow
combinatorially. Tests reuse a property name where distinct names are irrelevant to the behavior
under test. Restricting that closure with sound per-object reachability remains open.

### 2026-09-06 — Syntax-only Script validation

The syntax-only driver shares the production syntax pass and reports proven early errors through
a versioned typed result, without lowering or execution. Test262 parse negatives use this path.
Strict validation covers the admitted grammar: directive scope and inheritance, binding names,
identifier references, assignment targets, duplicate simple parameters and legacy numeric/string literals.
Unknown grammar and compiler failures cannot count as SyntaxError results. Non-simple parameters
and nested function syntax remain outside the admitted grammar. Strict
runtime binding, receiver and arguments behavior remains an explicit compilation refusal.
Global initialization and runtime exceptions remain outside this parse result channel.

The first syntax campaign exposed three accepted-invalid numeric spellings: `10._1`, `10._e1`
and `10._`. Numeric maximal-munch scanning now rejects those spellings and validates separators,
radix digits, exponents and BigInt suffix boundaries. Number conversion supports decimal fractions
and exponents, binary/octal/hexadecimal integers and non-strict legacy forms. Compact integer
boxing requires an exact binary64 round trip, so fractional literals retain their double payload.
BigInt value lowering remains an explicit refusal. Unicode numeric/identifier boundaries beyond
recognized whitespace remain unsupported. Strict validation rejects legacy literals from their
original source spelling. No numeric-token test establishes full lexical or runtime conformance.

String literals decode character, identity, hexadecimal, Unicode and legacy escapes into UTF-16
before JSL allocation. Lone surrogates remain individual code units. Line continuations contribute
no characters; the lexer counts CRLF as one source line. Strict checks reject legacy escapes,
including before a later directive in the same prologue. Directive checks use raw spelling.
Template literals, escaped identifiers and string-named object literal keys remain unsupported.

### 2026-09-06 — Switch selection, fallthrough and unlabelled break

Switch evaluates its discriminant once, before entering the shared CaseBlock lexical scope.
Case selectors run in order on the unmatched path and use JSL strict equality. Default receives
the final unmatched path regardless of its source position. Body lowering merges selected entries
with fallthrough, without repeating selector evaluation. Empty switches preserve discriminant
effects, and all-returning cases stop subsequent statement lowering.

Unlabelled break now merges a pruned Scope snapshot into the nearest switch or while exit, using
Simple's jumpTo order. Syntax validation rejects breaks outside a breakable statement, including
in unreachable code. Nested loops/switches maintain separate targets. If lowering now merges the
live branch exit Scopes instead of stale entry Scopes after nested loops replace them.

Labelled break, continue and finally unwinding remain absent. Runtime TDZ state across case paths
with different initialization states still triggers the named Scope refusal. Case declarations
share one lexical scope and the early-error walk rejects duplicate names/defaults and var conflicts.

The native switch matrix exposed missing JsOp copying during JSL body cloning. The copier now
preserves the runtime-capability index and ordered edges, following Simple's subclass-payload
copy contract. No inlining limit or representation check changed. Focused graph coverage checks
that payload, and the switch matrix also reuses its binary under GC stress.

### 2026-09-06 — Function var instantiation and declaration lists

The frontend hoists function-local var names from blocks and branches, including unreachable
statements, into the function Scope. New bindings obtain undefined through JSL. Repeated var
declarations and declarations matching simple parameters preserve the existing value; initializers
execute at their source position. Comma-separated var, let and const declarations retain source
order without creating a block scope. Lexical lists instantiate their names before any initializer.

Declaration-name validation now precedes graph construction and visits unreachable nested blocks.
It rejects duplicate lexical names, lexical/var conflicts and function-body lexical/parameter
conflicts. This closes the previously recorded unreachable declaration-name checking gap; it does
not provide typed SyntaxError reporting or claim complete early-error coverage for absent syntax.

Script var still refuses with a named GlobalDeclarationInstantiation diagnostic. Such bindings
must belong to the shared global object, not the Script execution Fun. An unshadowed implicit
arguments object also remains unsupported; a var declaration must not replace it with undefined.
Destructuring, parameter defaults, nested function declarations and captured environments remain
outside this admitted slice.

### 2026-09-06 — typeof value classification

The frontend lowers typeof through JsTypeof in production JSL. The native regression covers
undefined, null, booleans, strings, objects and both Number representations, including NaN,
infinities and signed zero. It also covers operand effects, nested typeof, local shadowing and
deliberately false TypeScript annotations. The JSL definition classifies the represented Symbol
and Function tags; function values are produced now, Symbol construction is not.
BigInt and HTMLDDA production remain absent.

Unresolved names require a complete global environment. The compiler refuses this path by name,
including parenthesized references, instead of treating unimplemented globals such as JSON as
absent. Declared uninitialized names take the existing TDZ refusal. Result strings are static data
(a string `StaticRef` in the `__aot_heap` image; docs/DECISIONS.md, the static heap image),
so `typeof` no longer allocates. The regression reuses its compiled binary under GC stress.

### 2026-09-06 — Lexical instantiation and initializer-free let

The frontend creates direct let/const bindings before evaluating a function, Script or block body.
Reads and writes before initialization now refuse compilation instead of accessing an outer binding
or a singleton global. Initializer-free let obtains undefined through JSL at declaration execution.
Statement-only if/while bodies reject bare lexical declarations; const requires an initializer.
Block exit after a loop now removes bindings from the live exit Scope.

Executable TDZ ReferenceError completions and captured lexical environments remain absent.
Declaration-name validation now covers unreachable nested blocks as described above. These refusals are
compiler outcomes, not successful Test262 runtime-negative results. Scope merges check matching
initialization markers; path-dependent initialization outside the admitted grammar must hard-error
until the graph carries executable TDZ state.

### 2026-09-06 — Division, unary numbers and numeric globals

The frontend now lowers `/`, unary `+` and unary `-` through JSL. Shared primitive Number
conversion handles booleans, null and undefined across arithmetic. Numeric operations preserve
IEEE infinities, NaN and signed zeros. `Infinity` and `NaN` resolve after lexical bindings and
ignore writes in the admitted non-strict mode, while still evaluating the assignment RHS.
Strict-mode writes still require strict-mode and exception support. String-to-number conversion,
object ToPrimitive, Symbol conversion exceptions and BigInt remain unsupported; their values
cannot pass the numeric Unbox proof check. String/string addition retains concatenation.

The native regression exposed two graph defects now corrected: comparison pull-down used the
Boolean result bound for floating operand Phis, and Box retained representation zero after an
initially untyped producer acquired a raw type. Neither fix weakens the type invariants.
Shared conversion stays in a JSL function so arithmetic remains below the existing inlining-size
limit. This exposed a false recursion report from traversing a CallEnd-to-Return edge and a
borrowed-control lifetime error while folding Box(TOP); both now have regressions. Existing
constant-folding expectations remain unchanged. Top-level Script lexical/function declarations
over the three restricted globals now refuse compilation, but typed exception reporting remains
unimplemented. Local and parameter shadowing remains valid.
Graph copying now preserves explicit Box tags as well: the previous shell constructor lost
Boolean/null/undefined tags by trying to infer them from an already-boxed dynamic value.
The long-lived-tree regression also exposed an illegal accumulator hoist: early scheduling saw
an unvisited inner-loop Phi without its cached Region placement. GCM now publishes that structural
placement while skipping Phi recursion, matching Simple's cfg0 lookup. The focused GCM regression
schedules the consumer before the Phi, and the original native workload remains unchanged.

### 2026-09-06 — Strict equality

The frontend lowers `===` and `!==` through production JSL. Number comparison covers both
numeric representations, NaN and signed zero; strings compare UTF-16 contents, while the
remaining represented tags use identity. BigInt production and comparison remain unsupported.
Loose equality and the wider conversion operations remain absent. The native regression combines
generic calls, fresh allocations, mixed tags, precedence and left-to-right operand effects.

The checker now separates numeric `%Eq`/`%Ne` from dynamic `%SameBits`. It previously admitted
dynamic operands to numeric comparisons even though lowering could not settle their machine mode.
The new primitive compares representation words; JavaScript equality policy stays in JSL.

### 2026-09-06 — Logical expressions and lexical boundaries

`&&`, `||`, `??`, `!`, `void`, `true`, `false`, and `null` now lower through production JSL
predicates/singletons and ordinary Scope diamonds. Logical expressions return an operand, never
a coerced Boolean. Unparenthesized mixing of `??` with `&&`/`||` is refused. Block comments,
CR/CRLF/LF/LS/PS, ECMAScript whitespace, and maximal-munch punctuators are recognized.

Script goal now has a separate source execution root: top-level statements run in source order,
source `main` is not implicitly called, top-level `return` is rejected, and the host ignores
ordinary expression completion values. Source positions are preserved without wrapping text in
a function. This is not a complete Global Environment Record: function access to Script lexical
bindings and access before initialization explicitly refuse compilation. Script `var`, strict-mode
semantics, exceptions, and harness-defined assertion functions remain absent. The Coil test262
runner now records full-suite outcomes; its unsupported shared-global-script host prevents
execution of the standard assertion harness. See `docs/TEST262.md` for the measured baseline.
An actual `use strict` directive explicitly refuses compilation rather than executing sloppily.
Numeric and string literal support is described above. Identifier Unicode/escapes and reserved-word validation remain
incomplete. Recognizing a multi-character punctuator does not admit its expression semantics.

Arithmetic still lacks full ToNumber/ToPrimitive: strings and objects cannot in
general cross its numeric Unbox boundary. Generic property reads can retain every dynamic tag;
arithmetic on those results is rejected even for programs whose stored property happens to be
numeric. This is a semantic implementation gap, not evidence that such JavaScript is invalid.
The broader `jsl/index` is not the production registry; `jsl/compiler/index` is.

### TypeScript evidence

Function-entry mode retains primitive and parenthesized union annotations on parameters, local
bindings, and returns. These are unproven claims; runtime parameters remain fully dynamic, even
when annotations disagree with actual values. `never` denotes the empty union, and `void` does
not assert an undefined return payload. Annotation-driven discharge, use-site diagnostics,
structural types, generics, type aliases, and literal/function/array type syntax remain absent.
JavaScript Script mode rejects TypeScript annotations rather than silently changing its grammar.

Native regressions exposed three implementation defects now corrected: JSL conditional arm
lifetimes, Split reuse across different Phi predecessor blocks, and obsolete spill-placement
anchors after allocation rewires a copy's input. They are correctness fixes, not new permissions
to relax representation or scheduling checks.

Referenced architecture documents `docs/DESIGN.md` and `docs/JSL.md` are missing in this checkout.
`docs/FRONTEND.md`, `docs/BACKEND.md`, implementation headers and `docs/DECISIONS.md` are the
available current contracts; missing documents must not be treated as reviewed evidence.

- The lexer/parser lower named functions, hoisted calls, decimal integer spellings with full
  binary64 Number semantics, arithmetic calls, bindings, assignment, lexical blocks, conditional
  expressions, statement `if`/`else`, and nested `while`. Bare returns and live function
  fallthrough produce boxed `undefined`; early and loop-body returns merge through the function
  exit accumulator. Function parameter and return annotations are optional, admitting the
  corresponding ordinary JavaScript syntax. The frontend also admits UTF-16 string literals,
  object literals, and named property reads/writes through production JSL. Classes, `for`, loop
  exits, exceptions, closures, computed property syntax, and many expressions remain.
- Scope SSA bindings, lazy Phis, branch merges, loop closure, memory binding, and guard machinery
  exist. The frontend uses binding/branch merge and atomic lazy-Phi loop closure today;
  source-level narrowing and nonlocal loop exits remain.
- JSL reading, indexed two-pass declaration/body lowering, refusal diagnostics, integer literals,
  lexical `let`, `if`, semantic calls, tag tests, complementary-edge Cast narrowing, and the
  numeric/undefined generic fallback exist. The full production JSL grammar and primitive surface
  remain.
- `JsOp` construction and the string/object/number primitives below JSL.
- Distinct JS32 primitive lowering for `%BitAnd/%BitOr/%BitXor/%BitNot/%Shl/%Shr/%Ushr`, including
  float-to-int32 conversion and modulo-32 counts. The implemented scalar bit/shift nodes are
  Simple-style internal i64 operations and must not be reused for this observably different job.

## Partial memory, object and runtime subsystems

- Pointer, memory and nominal struct lattice families are implemented with structural interning,
  dual and meet. Shape-set, string and full RPC behavior remain.
- Load, Store, MemMerge and ReadOnly nodes are implemented, including alias-aware Load-after-Store,
  distinct-alias bypass, Store-after-Store, precise MemMerge lookup, and the `MemOps` interface.
  MemPhi, allocation initialization and bulk call-memory threading are implemented. Full Simple
  memory escape/finality facts and the remaining Load/Store peepholes remain.
- Hidden-class transitions, inherited alias allocation and stable payload-relative property
  offsets are implemented. Shape-set lattice integration and property nodes remain.
- Named/keyed property access nodes on the dynamic axis (arrays exist: docs/DECISIONS.md, arrays).
- Closures and captured environments.
- Exceptional control edges.
- The Coil generational moving core, nursery promotion, compacting old-generation semispaces,
  raw/boxed card-table remembered edges, per-card object starts, boxed-edge tracing, serialized-map parser,
  SP-relative raw/boxed root rewriting and automatic collection on semispace exhaustion are
  implemented. On Darwin the Coil runtime discovers the linked `__DATA,__aot_stackmaps` section
  through the executable Mach-O header. Explicit relocation nodes/projections, schedule- and
  dominance-sensitive R2 verification, post-write barriers, and typed maps from allocator liveness
  to final call/allocation return-PC offsets exist; Mach-O and ELF carry aligned stack-map sections.
  ELF runtime section discovery remains before linked Linux collection can claim parity.
- Coil throw paths. The Coil-owned `aot_rt_alloc(bytes,shape,map-id,caller-sp)` path, runtime header,
  zeroed payload, generational allocation, per-allocation stress collection and generated-code ABI
  are implemented.

## Unwritten optimizer, backend and compilation infrastructure

### 2026-09-09 — Register allocation: a boxed array value merged by a many-armed Phi does not converge

The allocator exceeds its split budget (`ra-run!: allocator exceeded its split budget`) on a loop
whose body calls a method through an object and indexes an array with the loop variable:

```
var obj = {}; var arr = [1, 2]; var r = 0;
for (var i = 0; i < arr.length; i++) { r = obj.f(arr[i]); }
```

The failing live range is a Phi over several JSL dispatch arms that all carry the same boxed
array value (and the same `mov 0` constant on more than one arm); the loop-boundary splitter
splits that value before each Phi edge every round while the value stays live across the arms'
calls, and after eight rounds a range still fails. Four cases of the 1-in-20 test262 sample
(`Object.keys`, `decodeURI`, `Error.prototype.stack`, reserved-words tests) hit it. Simple's
`splitByLoop` and spill choice are the reference to re-read before changing the policy.

- Multi-target/escaping-function SCCP integration and semantic checks for the remaining JavaScript
  value families. Direct-call SCCP, node-aware proof, Stop-reachable type checking and the ordered
  production phase driver are implemented.
- Loop-tree construction and typed infinite-loop exit insertion are implemented for the current IR.
- Arm64 selection and ABI contracts are implemented for current ideal opcodes. The complete JS
  semantic/runtime node surface and x86-64 selection remain.
- GCM, memory anti-dependencies, durable local scheduling, register masks, LRG/IFG construction,
  coalescing, colouring, splitting/spilling retries and frame finalization are implemented. Phi
  edge copies follow final Simple's shared-LRG plus edge-Split model; cold-edge-first loop-Phi
  splitting and legal Split coalescing have direct coverage. Managed-root split boundaries apply
  only to ranges a safepoint restricted, and every live range with a register use must have a
  machine definition. Safepoint-specific allocation evidence and broader pressure stress coverage
  remain.
- AArch64 encoding, checked local/symbol relocation, literal pools, valid Mach-O/ELF arm64 objects,
  native Mach-O linking and a complete implemented ideal-to-native execution test are implemented.
  Split encoding includes IFG-proved X16 scratch expansion for stack-to-stack copies. Preference-
  aware branch inversion, iterative B19 relaxation through an inverted-condition/B26 veneer, and
  sparse layout-planned B26/BL26 veneer hubs beyond direct branch range are implemented alongside
  stack-map/object metadata. The ordered source-to-object driver and native execution matrix cover
  every currently admitted source form.
- Ideal-graph serialization, compilation units and dependency resolution.
- The assembly printer and the graph/type text parsers. Graphviz, the graph text printer and the
  type printer are implemented.
- CLI `compile`, `run`, `compile-script`, `run-script` and `dump` are implemented.

## Current Simple comparison boundary

The Stop-rooted hand-built programs in `tests/program-graph-test.coil` establish the structural
spine: Fun is a Region, Parm is a Phi, pure values float, If produces control projections, and
Region/Phi positions correspond. Parser, pipeline and native execution suites separately establish
source-to-graph and source-to-object behavior for every currently admitted syntax form. Return and
CallEnd preserve Simple's final `control, memory, value, RPC` / `control, memory, value` positions,
including concrete bulk memory, clearing RPC during trivial inlining and reconstructing the
architectural RPC Parm before code generation. Persisted compilation units and their serialized
envelope remain outside the implemented boundary.
