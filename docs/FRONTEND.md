# The frontend contract: source → tree → graph → JSL

## Current executable boundary (2026-09-06)

The production registry is `jsl/compiler/index`; the broader surface described below is a design
contract, not a claim that every listed operation is executable. Logical operators use `JsTruthy`,
`JsNullish`, `JsLogicalNot`, and `JsVoid`; Boolean/null literals use JSL singleton macros. The
frontend constructs short-circuit Scope/control/memory merges while JSL supplies predicates.

`compile-script` and `run-script` select JavaScript Script grammar and execute top-level code.
They do not call a source function named `main` or reinterpret expression completion as an exit
code. The existing `compile`/`run` commands retain the function-entry convention and optional
TypeScript annotations. Annotation records are evidence only, never trusted runtime types.
Neither path is a test262 harness. See `docs/GAPS.md` for explicit global-environment, strict-mode,
exception, and annotation-checking limitations.

Two questions this document settles, because everything in `src/parse/` and `src/jsl/` depends on
the answers and neither can be decided locally:

1. **Is there a parse tree, and what shape is it?**
2. **How does a syntax construct become JavaScript semantics?**

---

## 1. The answer to the second question is already in `jsl/`

`jsl/` is not a library of internals. It is a **frontend-facing surface**, and it already contains
the entry point for essentially every JavaScript construct:

| Syntax | JSL entry point |
|---|---|
| `a + b` | `JsAdd` |
| `a - b`, `a * b`, `a / b`, `a % b`, `-a` | `JsSub`, `JsMul`, `JsDiv`, `JsMod`, `JsNegate` |
| `a === b`, `a == b` | `StrictEqual`, `LooseEqual` |
| `a < b`, `a <= b` | `IsLessThan`, `IsLessEqual` |
| `a & b`, `a << b`, `a >>> b` | `BitwiseAnd`, `ShiftLeft`, `ShiftRightUnsigned` |
| `!a`, `typeof a`, `void a`, `a ?? b` | `LogicalNot`, `TypeOfValue`, `VoidValue`, `IsNullishValue` |
| `o.x`, `o.x = v` | `GetNamedProperty`, `SetNamedProperty` |
| `o[k]`, `o[k] = v`, `delete o.x`, `k in o` | `GetElement`, `SetElement`, `DeleteProperty`, `HasProperty` |
| `f(...)`, `o.m(...)` | `Call`, `GetMethod` |
| a bare identifier at global scope | `GetGlobalBinding`, `TypeOfGlobalBinding` |
| a parameter, an omitted argument | `GetParameterBinding`, `OmittedArgumentValue` |
| `[a, ...b]` | `NewArray`, `ArrayLiteralAppend`, `ArrayLiteralSpread`, `ArrayLiteralElide` |
| `for (x of it)` | `GetIterator`, `IteratorComplete`, `IteratorValue` |
| `{...rest}` destructuring | `ObjectRest`, `ObjectRestKeyExcluded`, `IteratorRestArray` |
| `arguments` | `NewArgumentsObject`, `InitializeArgumentsElement` |
| a class field | `DefineField` |
| `a instanceof B` | `OrdinaryInstanceOf` |

So the semantic-boundary rule is:

> **Each admitted JavaScript operator or predicate maps to a JSL entry-point name. The frontend
> emits that call and does not reimplement the abstract operation.**

Structural control and lexical Scope construction remain frontend work, and the current slice
constructs its sole global primitive, `undefined`, directly. As additional expressions become
admitted, their observable JavaScript semantics belong behind this JSL boundary.

`jsl/abstract/property.jsl` states this contract in its own words, beside `GetGlobalBinding`:
*"Keep the presence decision beside GetGlobalBinding so the frontend does not duplicate the Realm
environment semantics."* That is the boundary, and it was drawn by the people who wrote `jsl/`.

### What this buys, concretely

`a + b` is not an `Add` node. The currently compiled numeric/undefined `JsAdd` is:

```lisp
(builtin JsAdd :params [(a dyn) (b dyn)] :ret dyn
  (let [(left (if (%IsUndefined a)
                  (%Div (%ToFloat 0) (%ToFloat 0))
                  (%UnboxNumber a)))
        (right (if (%IsUndefined b)
                   (%Div (%ToFloat 0) (%ToFloat 0))
                   (%UnboxNumber b)))]
    (%Box (%Add left right))))
```

The parser emits `Call(JsAdd, a, b)` and stops. Then the ordinary optimiser does the work — and
this is the whole performance thesis in one example:

```
Call(JsAdd, a, b)              a and b proven numeric
  inline                       the JsAdd graph is an ordinary Fun graph
  %IsUndefined folds false     the tags are proven
  %UnboxNumber specializes     boxed int converts; boxed double is a representation move
  → %Box(%Add(left, right))    IEEE binary64 addition
  select                       one floating add plus the required result representation boundary
```

Nothing about that is speculative and there is no deoptimisation path. Where the types are *not*
proven, the same graph survives with its undefined-to-NaN branches intact. String concatenation and
the rest of full `JsAdd` remain outside the currently admitted source/runtime slice.

**This is the reason the op count does not grow with ECMAScript.** A builtin that lowers to the
ideal graph is inlined and specialised into user code. An opcode plus a runtime C function never
can, and would additionally cost an arm in `compute`, `idealize`, the verifier, the printer, the
interpreter and instruction selection — ten dispatch sites, for each of about a thousand builtins.

---

## 2. Yes, there is a parse tree — for four specific reasons

Simple's parser has no AST: it drives `ScopeNode` directly and SSA falls out of parsing. That works
because Simple's syntax maps almost one-to-one onto graph nodes.

JavaScript does not permit it, and the reasons are specific rather than general:

- **Cover grammars.** `(a, b) => c` and `(a, b)` are the same prefix; `({a} = x)` parses `{a}` as an
  object literal and then *reinterprets* it as a destructuring pattern. Reinterpretation is easy on
  a tree and needs unbounded backtracking without one.
- **Hoisting.** `var` and function declarations are visible before their textual position, so the
  full set of declarations in a scope must be known before any code in that scope is emitted.
- **Forward type references.** `function f(x: Foo) {}` may precede `interface Foo`. Annotations
  cannot be resolved on first sight.
- **Class bodies and closures.** Field initialisers run in constructor context, and a closure's
  captured set is not known until its body has been read.

**But the tree must not become a second IR.** Simple's real insight — the graph *is* the program —
still holds. The tree exists to solve ordering and lookahead, and it is discarded the moment
lowering finishes. The current implementation therefore uses:

- `SyntaxExpr` and `SyntaxStmt` records, each a source span plus a `defsum` node, and `SyntaxFun`
  declaration headers, with child expressions/statements referenced by dense ids in parser-owned
  side arrays; every walk over them is an exhaustive `match`;
- parser-owned dense storage that is cleared before the next compilation unit; no later compiler
  pass retains or queries syntax records after graph lowering;
- source spans, because a diagnostic without one is unactionable;
- **no** per-construct structs, **no** visitor framework, **no** typed-AST layer, and **no**
  analysis that could equally be done on the graph.

If a pass wants to ask a question about the *program*, it asks the graph. The tree is asked only
about *syntax*.

---

## 3. The pipeline, end to end

```
source text
   │  lexer                      line terminators feed ASI; unsupported regex context fails closed
   ▼
tokens
   │  parser                     constructs the admitted grammar without semantic typing
   ▼
Syntax tree  ──────────────┐     thin, parser-owned, not observed after lowering
   │  declaration pass     │     named-function hoisting and stable function identities
   ▼                       │
lowering walk  ────────────┘     resolves admitted bindings and drives ScopeNode; SSA falls out
   │
   │  admitted JavaScript arithmetic and truthiness emit
   │      Call(<JSL entry point>, args…); structural control lowers directly
   ▼
ideal graph  ◄──── JSL definitions, lowered from jsl/index into Fun graphs
   │
   │  iterpeeps + opto: inline, constant-fold, discharge guards, unbox
   ▼
specialised graph → backend
```

### Current executable slice

The implemented numeric/undefined slice preserves the JavaScript representation boundary:

- source integer spellings are boxed as either exact signed-48 payloads or binary64 values, never
  silently truncated raw integers;
- user-function parameters, results and calls use `dyn`, exactly like JSL calls;
- a `number` annotation does not change a parameter into a raw integer;
- closed-world argument flow may prove a numeric representation, after which JSL's
  `%UnboxNumber` and ordinary Box/Unbox cancellation expose raw arithmetic;
- a genuinely mixed number/undefined value keeps the JSL TypeTest/If/Cast fallback through
  selection, with JavaScript `ToNumber(undefined)` producing NaN rather than trusting an
  annotation;
- backend handoff still refuses any live Unbox whose control-path representation proof is absent.

Parameter and return annotations are optional, so the same function grammar admits ordinary
JavaScript declarations. Annotated and unannotated functions both use the identical `dyn` return
and argument signature; the annotation never selects a raw representation.

The native entry point is a distinct compiler-owned `main` wrapper. It calls the boxed source
function under the deliberately unspellable internal symbol `$aot$.source_main`, supplies the
canonical boxed `undefined` for every omitted source parameter in both register and stack slots,
and converts the boxed JavaScript result to a host process status. An ordinary source call uses the
same fixed internal ABI: missing formals receive `undefined`; every extra actual is still evaluated
left-to-right for effects and is then omitted from the callee's formal input bank. Internal
parameters remain fully dynamic and specialize only from closed-world call evidence; annotations
are never used to bypass representation proof.

The sole admitted global value is the shadowable binding `undefined`. This source slice is
non-strict (duplicate formal parameters follow non-strict last-binding semantics), so assigning to
the unshadowed, non-writable global evaluates the complete right-hand side and then has no effect.
A lexical `let undefined` instead resolves through the ordinary Scope slot and updates normally.

Function bodies currently admit sequential `let`/`const`/`var`, assignment, lexical blocks,
expression statements, return, calls, conditional expressions, `switch`, `break` and `continue`
with or without labels, labelled statements, statement `if`/`else`, `while`, `do-while`, classic
`for`, and `debugger`. `for-in`/`for-of`, `throw`, `try` and `with` parse and refuse lowering. The complete ECMAScript operator precedence is
parsed: every binary, unary, update, compound-assignment, logical-assignment and comma operator
has a syntax variant naming its JSL entry point. Operators whose entry point is in the production
index execute (`+ - * / < > <= >= === !== && || ?? ! void typeof - + ++ -- , = += -= *= /= &&=
||= ??=`); the rest (`% ** & | ^ << >> >>> == != in instanceof ~ delete` and their compound forms)
parse, pass early-error validation, and refuse lowering by their JSL name. Primary and member
grammar is complete except functions, classes and `super`: `this`, `new`, `new.target`, computed
members, general callees, spread, optional chains, array literals, `import()`, templates and regex
literals parse, and the forms without runtime support refuse by name at lowering.
Statement branches duplicate and merge ScopeNode directly, so reassigned bindings acquire Phis
only when the arm values differ. Final Simple's pruned return-Scope protocol is represented by a
function-local accumulator of control, memory, and value: bare returns and live fallthrough add
boxed `undefined`, early exits kill only their own path, and one final Region/MemPhi/value Phi owns
all exits. Statements after an unconditional return remain valid parsed syntax but are not lowered
back onto live control. ScopeNode is the sole lowering environment, so shadowing and reassignment
construct SSA during parsing. Every loop follows final Simple's atomic loop protocol: an open Loop and
lazy binding Phis are built first, then `scope-end-loop!` installs the control backedge and every
materialized Phi backedge without exposing an intermediate graph. A return in the body contributes
to the function accumulator while the loop's false projection remains live. `break` and `continue`
follow Simple's `jumpTo`: a pruned Scope copy merges into the target's exit or continue Scope.

Every executable member of the `SyntaxNode` and `SyntaxStmtNode` sums has a native execution regression:
numeric literals, names, grouping, `+`/`-`/`*`, named calls, conditional expressions, `let`, `const`,
assignment, expression statements, blocks and shadowing, value/bare/implicit returns, `if` with and
without `else`, and `while` with block and single-statement bodies. The matrix also covers forward
and duplicate declarations, duplicate parameter last-binding semantics, missing and extra actuals,
the shadowable global `undefined` and its non-strict non-writable assignment behavior, ASI
(including restricted `return`), line comments, unreachable statements after return, recursion,
and zero-, one-, multi-iteration and nested loops. Graph tests separately assert left-to-right
control and memory ordering, including the preserved RHS effects of an assignment to global
`undefined`, where the admitted source subset has no externally visible mutation. Lexical
recognition of additional token kinds is not admission:
unsupported primaries fail immediately before graph lowering.

The production JSL subset now admits integer literals, lexical `let`, value-producing `if`, calls
between JSL definitions, numeric conversion primitives, and dynamic tag predicates such as
`%IsInt` and `%IsUndefined`. A recognized tag predicate installs ordinary Cast proof on both the
taken and complementary edges when the dynamic tag lattice can represent the complement; checked
Unboxes therefore consume control-path proof from the graph instead of trusting a TypeScript
annotation. The guarded `JsIncrementIntOrIdentity` definition demonstrates specialization, while
the numeric builtins retain an undefined-to-NaN fallback when their arguments do not sharpen to a
single numeric representation. Index loading is two-pass: every declaration receives its stable
function index before any body lowers, then bodies resolve names across the complete table. Forward
semantic references therefore remain legal without making function indices depend on traversal
accidents.

Two things join in the middle, and they join at **`Call` to a `Fun`** — nothing more exotic:

- the frontend produces calls to named entry points;
- `jsl/index` produces `Fun` graphs registered under those names, in index order, because a
  declaration's position in that file *is* its closed-world function index.

Inlining is then the ordinary inliner, and specialisation is the ordinary optimiser. There is no
JSL-specific machinery downstream of `src/jsl/lower.coil`, which is the property that makes this
design worth having.

### Inlining is not a policy we invent — it is Simple's, and it is not a pass

Simple's answer is better than any policy we would have designed, and it imposes a **structural
requirement** on how `src/node/call.coil` is written, so it is recorded here rather than discovered
later.

**It is not a separate pass.** `IterPeeps` carries a second worklist of `CallEnd` nodes, and one
fixpoint loop interleaves them: run peepholes until clean, take ONE inline candidate, run peepholes
until clean again, repeat until neither makes progress. Inlining and peepholing are the same
fixpoint.

**Trivial inlining clones nothing.** This is the part worth reading twice. To inline, Simple marks
the `CallEnd` and the `Fun` as folding, rewires the `Fun`'s first control input to bypass the
`Call`, and nulls the `Return`'s link — and then stops. The **existing Region-collapse peephole**
does the actual work, because a `Fun` *is* a `Region` and a `Parm` *is* a `Phi`: a one-input Region
collapses into its predecessor and its Phis collapse into their single values, which are the
caller's actual arguments. Inlining falls out of peepholes that already exist.

> **The structural requirement:** `Fun` must be a Region and `Parm` must be a Phi. If we invent a
> different call representation, this mechanism does not exist and inlining becomes a bespoke pass
> that has to reproduce argument substitution, control splicing and return merging by hand.

**Cloning is a pre-step, not a second mechanism.** When the callee has other callers, Simple copies
the body, points the call at a fresh `FunPtr` with an inline-only function index, and then runs the
*same* trivial inline on the clone. One mechanism, always.

**The decision is a tri-state, and it defers rather than declines:**

| | meaning |
|---|---|
| `1` | inline now, trivially |
| `2` | clone the body first, then inline trivially |
| `-1` | **not now, but might become one** — `addDep` re-queues it when the blocking fact changes |
| `-2` | never; stop asking |

That `-1` is our own "deferred, never declined" law showing up in Simple's code: a candidate blocked
by a not-yet-constant function pointer, arguments that do not yet `isa` their formals, or a body
that cleanup might still shrink, is retried rather than dropped.

**The heuristic is deliberately minimal** — a 100-node cap, `_noInline`, never for self-recursive
functions (that is loop unrolling by another name), and exactly one linked target with a constant
non-null function pointer. Simple's 200-node initializer exception waits for this frontend to
classify initializers and distinguish class bodies. The precision comes from the call graph SCCP
discovered, not from a clever cost model.

**So there is no JSL inlining question.** A JSL definition is a `Fun`; it inlines through the same
`CallEnd` worklist, the same tri-state, and the same fold as any user function.

---

## 4. What has to exist before any of it runs

The control, call, inlining, dynamic-value and optimizer spine below is implemented and tested.
It was established in the following order; each step remains covered directly even though the
production source path now crosses the complete sequence.

The shortest path to proving the architecture, and it needs no parser at all:

1. ~~`Start`, `Stop`, `Return`, `Region`, `If`, `Phi`, `Proj`, and `iterpeeps`.~~ Implemented.
2. ~~`Fun`, `Parm`, `Call`, `CallEnd`, and inlining.~~ Implemented.
3. ~~Implement the JSL reader/checker and lower one production numeric builtin.~~ Implemented.
4. ~~Make a hand-built `Call(JsSub, con 5, con 3)` specialize to the numeric result `2`.~~
   Implemented.

Step 4 is one test, and passing it exercises the reader, the lowering, the primitive layer, `Fun`
and `Call`, the inliner, `Box`/`Unbox` cancellation and the peephole fixpoint — the entire spine.

The proof now uses the production `jsl/compiler/sub.jsl` unit rather than a reduced fixture. Its
undefined-to-NaN guards, `%UnboxNumber` conversions, binary64 subtraction and `%Box` result all
lower before the ordinary call/inlining fixpoint specializes boxed `5` and `3` to `2`. This makes
the test evidence match the unit the source frontend actually calls; no reduced fixture is counted
as ECMAScript coverage.

The parser comes after that, because only then does every entry point it emits actually resolve.
