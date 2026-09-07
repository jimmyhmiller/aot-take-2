# Decisions

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

NaN-boxing makes null, undefined, booleans and compact integers machine words with the same storage
width as boxed object references. Values live across collecting calls need addressable spill homes
for allocator convergence, but a word whose lattice tag excludes string, symbol, object and
function cannot require relocation.

Register allocation therefore carries a distinct boxed-scalar live-range kind. Call boundaries may
place it in the stack namespace, while stack-map construction omits it. Reference-bearing dynamic
unions retain the conservative boxed-root kind. This distinction is derived from the shared dynamic
tag lattice rather than from individual opcode names.

## 2026-09-02 — Moving-root stack boundaries extend the allocator convergence budget

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
