# The frontend contract: source → tree → graph → JSL

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

So the rule is:

> **The frontend's entire semantic knowledge is a table mapping syntax to a JSL entry-point name.
> It emits a call to that name and nothing else. It never reimplements a semantic step.**

`jsl/abstract/property.jsl` states this contract in its own words, beside `GetGlobalBinding`:
*"Keep the presence decision beside GetGlobalBinding so the frontend does not duplicate the Realm
environment semantics."* That is the boundary, and it was drawn by the people who wrote `jsl/`.

### What this buys, concretely

`a + b` is not an `Add` node. `JsAdd` is:

```lisp
(builtin JsAdd :transitioning true :params [(a dyn) (b dyn)] :ret dyn
  (let [(left  (ToPrimitive (%Box a) (%Box undefined)))
        (right (ToPrimitive (%Box b) (%Box undefined)))]
    (if (%IsString left)
        (%StringConcat left (ToStringValue right))
        (if (%IsString right)
            (%StringConcat (ToStringValue left) right)
            (%Box (%Add (NumberRaw left) (NumberRaw right)))))))
```

The parser emits `Call(JsAdd, a, b)` and stops. Then the ordinary optimiser does the work — and
this is the whole performance thesis in one example:

```
Call(JsAdd, a, b)              a and b proven int
  inline                       the JsAdd graph is an ordinary Fun graph
  ToPrimitive folds            a primitive is already primitive
  %IsString folds false        the tag is proven
  → %Box(%Add(%NumberRaw a, %NumberRaw b))
  Box/Unbox cancel             they are ordinary nodes that cancel in pairs
  → Add(a, b)                  one machine instruction
```

Nothing about that is speculative and there is no deoptimisation path. Where the types are *not*
proven, the same graph survives as the generic path with the branches intact — which is exactly
what should happen, because then the program really can concatenate strings.

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
lowering finishes. So:

- one `defsum Syntax`, with children in a side array addressed by `(offset, len)` — the same trick
  the type lattice uses, keeping the sum small and non-recursive;
- arena-allocated with dense ids, freed after lowering;
- source spans, because a diagnostic without one is unactionable;
- **no** per-construct structs, **no** visitor framework, **no** typed-AST layer, and **no**
  analysis that could equally be done on the graph.

If a pass wants to ask a question about the *program*, it asks the graph. The tree is asked only
about *syntax*.

---

## 3. The pipeline, end to end

```
source text
   │  lexer                      regex-vs-divide and ASI need parser feedback
   ▼
tokens
   │  parser                     cover grammars resolved here
   ▼
Syntax tree  ──────────────┐     thin, arena, discarded after lowering
   │  declaration pass     │     hoisting, TDZ, module records, binding resolution
   ▼                       │
lowering walk  ────────────┘     drives ScopeNode; SSA falls out
   │
   │  every operator / property / binding / iteration step emits
   │      Call(<JSL entry point>, args…)
   ▼
ideal graph  ◄──── JSL definitions, lowered from jsl/index into Fun graphs
   │
   │  iterpeeps + opto: inline, constant-fold, discharge guards, unbox
   ▼
specialised graph → backend
```

### Current arithmetic slice

The implemented `number`-annotated arithmetic slice preserves the JavaScript representation
boundary even though its accepted values are presently narrower than ECMAScript:

- source literals are `Box(ConInt)`, not raw integer values;
- user-function parameters, results and calls use `dyn`, exactly like JSL calls;
- a `number` annotation does not change a parameter into a raw integer;
- closed-world argument flow may prove a singleton integer tag, after which JSL's `%UnboxInt`
  becomes justified and ordinary Box/Unbox cancellation exposes raw arithmetic;
- backend handoff refuses a live Unbox whose dynamic input is not representation-proven.

Parameter and return annotations are optional, so the same function grammar admits ordinary
JavaScript declarations. Annotated and unannotated functions both use the identical `dyn` return
and argument signature; the annotation never selects a raw representation.

Externally entered `main` parameters are admitted as `dyn:any`, regardless of their TypeScript
spelling. Programs that only select or forward those values therefore retain an honest generic
If/Region/Phi graph. Arithmetic over them is not backend-ready yet: until generic numeric fallback
exists, its live `%UnboxInt` fails the explicit representation-proof handoff instead of trusting the
annotation.

Function bodies currently admit sequential `let`/`const`, assignment, lexical blocks, expression
statements, return, calls, arithmetic, conditional expressions, statement `if`/`else`, and basic
`while` loops.
Statement branches duplicate and merge ScopeNode directly, so reassigned bindings acquire Phis
only when the arm values differ. Two returning arms join their controls and values at the function
Return. A one-arm return remains refused until the final function-exit scope can merge early exits.
ScopeNode is the sole lowering environment, so shadowing and reassignment construct SSA during
parsing. `while` follows final Simple's atomic loop protocol: an open Loop and lazy binding Phis are
built first, then `scope-end-loop!` installs the control backedge and every materialized Phi
backedge without exposing an intermediate graph. `break`, `continue`, and loop-body returns remain
outside the admitted subset.

The production JSL subset now admits integer literals, lexical `let`, value-producing `if`, calls
between JSL definitions, and dynamic tag predicates such as `%IsInt`. A recognized tag predicate
installs an ordinary Cast for the tested binding on the true control edge; checked `%UnboxInt`
therefore consumes proof from the graph instead of trusting a TypeScript annotation. The guarded
`JsIncrementIntOrIdentity` definition demonstrates both outcomes: unknown dynamic input preserves
its TypeTest/If/Phi fallback, while boxed integer input specializes to raw addition and re-boxing.
Index loading is two-pass: every declaration receives its stable function index before any body
lowers, then bodies resolve names across the complete table. Forward semantic references therefore
remain legal without making function indices depend on traversal accidents.

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
What remains is to connect it first to one fixture JSL definition and then to source lowering.

The shortest path to proving the architecture, and it needs no parser at all:

1. ~~`Start`, `Stop`, `Return`, `Region`, `If`, `Phi`, `Proj`, and `iterpeeps`.~~ Implemented.
2. ~~`Fun`, `Parm`, `Call`, `CallEnd`, and inlining.~~ Implemented.
3. Implement `src/jsl/` reader and lowering for **one** fixture builtin.
4. Make a hand-built `Call(FixtureSub, con 5, con 3)` fold to the constant `2`.

Step 4 is one test, and passing it exercises the reader, the lowering, the primitive layer, `Fun`
and `Call`, the inliner, `Box`/`Unbox` cancellation and the peephole fixpoint — the entire spine.

**But not with a real `jsl/` builtin, and it is worth being precise about why.** `JsSub` looks
isolated — `(%Box (%Sub (NumberRaw a) (NumberRaw b)))` — but `NumberRaw` is
`(%UnboxNumber (ToNumberValue v))`, and `ToNumberValue` reaches `ThrowTypeError`, `IsNumber`,
`ToPrimitiveNumber` and thence `ToPrimitive`, `GetMethod` and `Call`. Lowering is
transitive even when *folding* is not: on two proven integers `IsNumber` folds true and the whole
`ToPrimitive` arm is dead — but the arm still has to be BUILT before it can be deleted.

So the first target is a **fixture unit of our own**, living in `tests/fixtures/*.jsl` and loaded
only by tests. It never goes in `jsl/`, so `jsl/` stays exactly the real ECMA-262 library and no
coverage claim can accidentally cite a fixture:

```lisp
(builtin FixtureSub :params [(a dyn) (b dyn)] :ret dyn
  (%Box (%Sub (%UnboxInt a) (%UnboxInt b))))
```

That proves the machinery honestly and then real `jsl/` units follow as their dependencies land.
A fixture is a scaffold for the pipeline, never evidence about ECMAScript: no coverage claim may
cite one.

The parser comes after that, because only then does every entry point it emits actually resolve.
