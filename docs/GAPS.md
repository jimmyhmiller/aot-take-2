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
| Calls | Escaping function pointers, cross-unit resolution and JavaScript callable objects | Finite multi-target SCCP lookup uses the compilation-local function registry; member-call receivers and callable object allocation remain absent |
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
Destructuring parameters, sloppy `let` names, Annex B function-in-`if` and labelled functions fail
closed.

The Script statement list is parsed under a root context so nested functions have a parent; only
declarations the program loop saw at the top level are hoisted closed-world Funs. Every other
function is a value the lowering refuses by name: nested declarations, expressions, arrows,
methods, `yield`, `await`, `super`, and first-class references to hoisted declarations. Default,
rest, generator and async top-level declarations refuse at the Fun header. Closures and function
objects are the next semantic subsystem.

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
named property it desugars to. `this`, `new`, `new.target`, computed access and assignment,
non-name callees, spread, array literals, optional chains, `import()`, template substitutions
(ToString), tagged templates, object spread and computed keys refuse by name. The regex pattern
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
`let` identifiers, destructuring heads/catch parameters, `for await` and `for (var x = 1 in o)`
fail closed. The lexer gained a two-token lookahead for `let x` versus a bare `let` identifier.

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
statements, nested/expression functions, `this`/`new`/`super`/`import` primaries, array literals,
regex literals, object-literal shorthand/methods/computed keys, and `let` as a sloppy identifier.

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
and Function tags, but the frontend still lacks their constructors/first-class value production.
BigInt and HTMLDDA production remain absent.

Unresolved names require a complete global environment. The compiler refuses this path by name,
including parenthesized references, instead of treating unimplemented globals such as JSON as
absent. Declared uninitialized names take the existing TDZ refusal. Result strings use managed
literal allocation and the JSL function declares that effect; a constant-string pool remains
required to remove repeated allocation. The regression reuses its compiled binary under GC stress.

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
- Named/keyed property and array access nodes.
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

- Multi-target/escaping-function SCCP integration and semantic checks for the remaining JavaScript
  value families. Direct-call SCCP, node-aware proof, Stop-reachable type checking and the ordered
  production phase driver are implemented.
- Loop-tree construction and typed infinite-loop exit insertion are implemented for the current IR.
- Arm64 selection and ABI contracts are implemented for current ideal opcodes. The complete JS
  semantic/runtime node surface and x86-64 selection remain.
- GCM, memory anti-dependencies, durable local scheduling, register masks, LRG/IFG construction,
  coalescing, colouring, splitting/spilling retries and frame finalization are implemented. Phi
  edge copies follow final Simple's shared-LRG plus edge-Split model; cold-edge-first loop-Phi
  splitting and legal Split coalescing have direct coverage. Safepoint-specific allocation evidence
  and broader pressure stress coverage remain.
- AArch64 encoding, checked local/symbol relocation, literal pools, valid Mach-O/ELF arm64 objects,
  native Mach-O linking and a complete implemented ideal-to-native execution test are implemented.
  Split encoding includes IFG-proved X16 scratch expansion for stack-to-stack copies. Preference-
  aware branch inversion, iterative B19 relaxation through an inverted-condition/B26 veneer, and
  sparse layout-planned B26/BL26 veneer hubs beyond direct branch range are implemented alongside
  stack-map/object metadata. The ordered source-to-object driver and native execution matrix cover
  every currently admitted source form.
- Ideal-graph serialization, compilation units and dependency resolution.
- Assembly and ordinary IR printers. Graphviz is implemented.
- CLI `compile`, `run`, `compile-script`, and `run-script` are implemented; a user-facing
  IR/assembly dump command remains.

## Current Simple comparison boundary

The Stop-rooted hand-built programs in `tests/program-graph-test.coil` establish the structural
spine: Fun is a Region, Parm is a Phi, pure values float, If produces control projections, and
Region/Phi positions correspond. Parser, pipeline and native execution suites separately establish
source-to-graph and source-to-object behavior for every currently admitted syntax form. Return and
CallEnd preserve Simple's final `control, memory, value, RPC` / `control, memory, value` positions,
including concrete bulk memory, clearing RPC during trivial inlining and reconstructing the
architectural RPC Parm before code generation. Persisted compilation units and their serialized
envelope remain outside the implemented boundary.
