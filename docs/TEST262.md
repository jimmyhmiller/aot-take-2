# Test262 conformance campaign

## Fixed denominator

Suite: tc39/test262, revision `419d3e0a2273ba01a3bfcbec423f2801425b8e93`.
The local checkout lives outside this repository at
`/Users/jimmyhmiller/Documents/Code/open-source/test262`.

Run the Coil inventory with:

```
coil run tools/test262.coil -- inventory /Users/jimmyhmiller/Documents/Code/open-source/test262
```

The inventory requires that revision and a clean test/harness tree. Git supplies tracked paths;
Coil reads and interprets the test metadata. No shell, JavaScript, or Python runner participates.
The full inventory on 2026-09-06 found 53,582 test files and 102,926 required variants, with zero
metadata errors. It includes staging and Intl tests. `_FIXTURE` inputs do not count as standalone
tests, as required by upstream. Unsupported tests remain in the denominator.

The 10% goal requires at least 5,359 passing files. A file passes only when all of its required
variants pass. Also report variant totals, but do not substitute a variant percentage for the
file percentage. Report metadata errors, not-run cases, unsupported capabilities, compiler
refusals/crashes, timeouts, and JavaScript failures apart from passes.

## Execution contract

Follow [upstream INTERPRETING.md](https://github.com/tc39/test262/blob/419d3e0a2273ba01a3bfcbec423f2801425b8e93/INTERPRETING.md).
Each variant needs an isolated realm. The default goal is Script, with both non-strict and strict
variants; flags select the exceptions. Preserve raw bytes for raw tests. Evaluate the required
upstream harness files in order in the same global environment before the test, while retaining
independent Script parsing and directive prologues. Do not concatenate scripts into a function
or a single shared directive prologue.

A negative test passes only for the expected JavaScript exception constructor and phase. A
compiler panic, unimplemented diagnostic, verifier failure, signal, or timeout cannot satisfy
that expectation. An async test needs the specified completion handshake, not a zero process
exit. Module resolution must load fixture inputs in the test's realm. The host bindings in the
upstream contract still require implementation.

Execute variants sequentially. Compile the runner once per campaign. Bound child runtime and
captured output, terminate timed-out process groups, and retain per-case diagnostics. Keep the
full conformance campaign separate from the fast `coil test --jobs 1` development gate.

## Current implementation boundary

The inventory and execution-metadata reader run. The reader preserves ordered includes,
features/locales, negative phase/type, and required variants. It accepts the flow/block sequence
and scalar syntax used by this pinned corpus. Unsupported execution-field YAML syntax produces
a metadata error; this is not a general YAML library.

The source-unit planner and observation classifier now have policy tests. The inventory validates
plans for all 102,926 required variants, with zero planning errors. Plans keep harness Scripts
separate from the test, retain include order, and apply the strict prefix to the test alone.
Raw inputs retain their exact bytes. File-success checks require one passing result for each
required mode, rejecting missing or duplicate variants. The classifier distinguishes compiler,
harness, timeout, and crash outcomes from JavaScript exceptions and checks negative phase/type.
Its tests supply synthetic observations; they are not test262 execution results.

The sequential worker now invokes the compiled AOT driver, links its object with the Coil runtime,
and runs the native executable. Compile/link stages have ten-second deadlines; native execution
has a two-second deadline. Captured stdout/stderr have 64 KiB limits. A timeout or truncated
capture cannot pass. Native self-tests exercise this path and confirm that a compiler panic does
not satisfy a negative SyntaxError expectation.

Parse-negative Script variants now use `aot parse-script` on the test source alone. They do not
load or evaluate harness code. The syntax-only command shares the production syntax collection
and early-error checks, and never enters JSL lowering, global initialization or native execution.
The worker requires the complete `AOT-PARSE/1 SyntaxError` record plus exit 73; neither one alone
establishes an error. Normal parse completion requires its own record plus exit zero.

Only proven early errors enter that channel: Script return, duplicate switch default, missing
const initializer, lexical-name conflicts, malformed numeric/string tokens and an unlabelled break
without an enclosing target.
Unknown grammar still fails outside the syntax-error channel. Strict validation also checks
restricted bindings/assignments, reserved references, duplicate simple parameters and legacy
numeric literals and string escapes. It derives strictness from each body and Script inheritance, without leaking
a function directive into siblings. Strict code compiles and runs: a strict function takes its
receiver as it is, a strict write to a non-writable global is a runtime TypeError refusal.
Global restricted-property failures belong to initialization and cannot count as
parse errors. Runtime negative tests still lack a typed abrupt-completion protocol.

The runner now compiles each variant's harness Scripts into the same realm as the test, as
separate sources in plan order (`aot compile-script HARNESS... TEST OUT.o`). Constructors (`new`,
`instanceof`, `prototype` objects), dynamic property stores on objects the compiler cannot see
(the runtime shape tree), `throw` and `try`/`catch` execute; undeclared globals and computed
member access compile and refuse at run time; the upstream assertion harness still needs the
conversions the remaining runtime refusals name (ToString for its messages, key interning for
`o[k]`, arrays) and the standard globals; on 2026-09-08 the harness plus a trivial test compiled,
linked and ran (exit 0), and a failing assertion refused at `String(value)` by name. Module plans and async
execution receive explicit unsupported results and remain in the denominator. Typed JavaScript abrupt-completion
reporting at runtime and realm host bindings remain unimplemented. Do not convert a nonzero native exit into
an expected exception by parsing its diagnostics.

## Latest measured campaign, 2026-09-08

The realm/exceptions/receivers/constructors campaign measured **4,225 / 53,582 files passing
(7.88%)**, up from 257 (0.48%): verdict-pass 8,014, verdict-fail 123, verdict-unsupported 57,058,
verdict-compiler-error 37,731, no crashes or timeouts (`build/test262-campaign-20260908`). Compiler
errors are dominated by the missing standard globals and by refusals the runtime names; the
intrinsics slice (Object, String, Number, Boolean, the Error family) lands next.

## Latest measured campaign, 2026-09-06

The assignment-expression campaign measured **257 / 53,582 files passing (about 0.48%)**, up from
247. Of 102,926 required variants, 412 passed, 94,464 were unsupported and 8,050 produced compiler
errors. Failure, crash, timeout, harness-error and unexecuted counts were zero. Passing files
remain parse negatives with all required modes passing; the denominator still includes unsupported
cases and compiler errors.

Evidence: `build/test262-assignment-campaign/results.tsv` and `summary.txt`. Fingerprints:

- Compiler: `5adbee421566b896170e54faf79286cea05009aa`
- Coil runtime: `34e337f669de579135ca399eddd16f782dc6307c`

The full sequential development gate passed 574 tests. Generic property arithmetic still has a
representation-proof refusal. Shared assertion-harness execution and the 10% goal remain open.

## Grammar-closure campaign, 2026-09-07

After `for await`, sloppy `let`, Annex B function declarations and for-in initializers, and
identifier escapes were admitted, the campaign in `build/test262-grammar-closure-campaign/`
measured **4,222 / 53,582 files passing (about 7.87%)**, up from 4,006. Of 102,926 variants,
8,011 passed, 438 produced compiler errors, 94,474 were unsupported and 3 failed. Fingerprints:
compiler blob `fbee4fa5eb0f1a2866cb6718161220f1e1bd0f13`, runtime `09f5ef57b34d0aeadabc52c42c52eac6d100c4a7`.

The 3 failures were one bug: the decoded StringValue of an escaped identifier lived in a lexer pool
that later scanning reallocated, so `{ \u0069mplements }` as a strict assignment-pattern leaf
compared against freed bytes. Escaped tokens now own a right-sized copy; fixed with lexer and
parser regressions. The 438 compiler errors are phase imports (400, deliberate), non-ASCII regex
group names (16), non-ASCII identifiers (6) and a handful of lexer fail-closed paths (block
comments, regex flags, `#` names). The parser now proves or admits essentially every negative
parse test; the remaining 94,474 unsupported variants are positive tests that need the harness
prelude compiled into a shared realm (`shared-global-scripts`, 82,806), an async host (10,815)
or a module loader (843).

## Patterns campaign, 2026-09-07

With destructuring patterns and regular-expression pattern validation admitted as syntax, the
campaign in `build/test262-patterns-campaign/` measured **4,006 / 53,582 files passing (about
7.47%)**, up from 2,933. Of 102,926 variants, 7,623 passed, 819 produced compiler errors, 94,464
were unsupported and 20 failed. Fingerprints: compiler blob
`9a7321b108b85af0eceab29ffb0951e4ffaaeedb`, runtime `09f5ef57b34d0aeadabc52c42c52eac6d100c4a7`.

The 20 failures were false accepts in destructuring, all fixed with regressions the same day: a
rest element followed by a trailing comma (`[...x,] = y`, `({...x,} = y)`, also in for-in/of heads
and arrow parameters), and strict-mode `eval`/`arguments`/`yield` leaves in for-in/of assignment
pattern heads, which the strict pass had not visited. Remaining compiler errors by refusal: phase
imports 400 (deliberate), `for await` 178, unadmitted primaries 125, Annex B function-in-statement
59, non-ASCII regex group names 16, sloppy `let` 11, Annex B for-in initializers 6, and a handful
of lexer/parser fail-closed paths.

## Grammar-completion campaign, 2026-09-07

After the parser refactor to sum-typed syntax records and the admission of the full operator,
statement, function and class grammar, the campaign measured **2,933 / 53,582 files passing (about
5.47%)**, up from 247. Of 102,926 variants, 5,548 passed, 2,717 produced compiler errors (parser
refusals of still-unadmitted grammar: destructuring patterns, regex pattern validation, phase
imports, `for await`, identifier escapes, Annex B function-in-statement), 94,608 were unsupported
and 53 failed. The 53 failures were false accepts of invalid programs (block-level duplicate
generator/async/class declarations, call expressions as logical-assignment and for-in/of targets,
`await` in nested async-arrow parameters, `super.#x`, private names right of `in`, arrows as
operands, `return` in static blocks inside functions, non-strict class heritage); each is fixed
with a regression in `tests/parse-test.coil` after this campaign, so a rerun would not reproduce
them. Every passing file is still a parse negative.

Evidence: `build/test262-syntax-campaign/results.tsv` and `summary.txt`. Fingerprints:

- Compiler: `ffe6ce4c7deb3fb89cb0b8de1eac66cb78a3ffe3`
- Coil runtime: `09f5ef57b34d0aeadabc52c42c52eac6d100c4a7`

The full sequential development gate passed 589 tests at that commit. Shared assertion-harness
execution and the 10% goal remain open.

## String-escape campaign, 2026-09-06

The string-escape campaign measured **247 / 53,582 files passing (about 0.46%)**, up from 205.
All required variants passed for those files. Of 102,926 variants, 401 passed, 94,464 were
unsupported and 8,061 produced compiler errors. The report records zero failure, crash, timeout,
harness-error or unexecuted rows. Unsupported results and compiler errors remain in the denominator.

Evidence: `build/test262-string-escape-campaign/results.tsv` and `summary.txt`. Fingerprints:

- Compiler: `039a482722b7df99ebc32b65f8ea132f94ab35d7`
- Coil runtime: `34e337f669de579135ca399eddd16f782dc6307c`

The full sequential development gate passed 571 tests. Passing files remain parse negatives;
shared assertion-harness execution and the 10% goal remain open.

## Strict-validation campaign, 2026-09-06

The strict-validation campaign measured **205 / 53,582 files passing (about 0.38%)**, up from 127.
All required variants passed for those files; the 78 added files are strict parse negatives.
Of 102,926 variants, 332 passed, 94,464 were unsupported and 8,130 produced compiler errors.
The report records zero failure, crash, timeout, harness-error or unexecuted rows. Unsupported
results and compiler errors remain in the denominator.

Evidence: `build/test262-strict-validation-campaign/results.tsv` and `summary.txt`. Fingerprints:

- Compiler: `f71d37c6b56e878a6e7c40422e39b1c4f7d70d98`
- Coil runtime: `34e337f669de579135ca399eddd16f782dc6307c`

The full sequential development gate passed 568 tests. Strict runtime execution and shared
assertion-harness evaluation remain unsupported. The 10% goal remains open.

## Numeric-literal campaign, 2026-09-06

The numeric-literal campaign measured **127 / 53,582 files passing (about 0.24%)**, up from 39.
All are parse-negative tests with both required variants passing. Of 102,926 variants, 254 passed,
94,542 were unsupported and 8,130 produced compiler errors. The report records zero failure,
crash, timeout, harness-error or unexecuted rows. Unsupported results and compiler errors remain
in the denominator; this does not establish working assertion-harness execution.

Evidence: `build/test262-numeric-literals-campaign/results.tsv` and `summary.txt`. Fingerprints:

- Compiler: `a1ac82a900401f5fd2f6dacb01ef0ba6ba11b378`
- Coil runtime: `34e337f669de579135ca399eddd16f782dc6307c`

The full sequential development gate passed 566 tests. The goal remains at least 5,359 passing
files and a working harness; neither requirement is complete.

## Parse-only introduction campaign, 2026-09-06

The syntax-only campaign measured **39 / 53,582 files passing (about 0.07%)**. All 39 are
parse-negative tests, with both required variants passing. Across 102,926 variants, the report
records 78 passes, 3 failures, 94,544 unsupported results and 8,301 compiler errors. It records
zero crashes, timeouts, harness errors or unexecuted variants. Compiler-error counts grew because
the runner now attempts parse negatives that previously stopped at the shared-harness boundary;
those errors do not count as passes.

Evidence: `build/test262-parse-negative-campaign/results.tsv` and `summary.txt`. The pinned suite
revision remains unchanged. Git blob fingerprints:

- Compiler: `a7b1dee218270a683a66d648e5668163be2c63ef`
- Coil runtime: `34e337f669de579135ca399eddd16f782dc6307c`

The full sequential development gate passed 563 tests. This campaign does not establish working
assertion-harness evaluation or meet the 10% target.

## Initial measured baseline, 2026-09-06

The first campaign measured **0 / 53,582 files passing (0%)**. Across 102,926 required variants,
102,896 were unsupported and 30 produced compiler errors. No compiler error counted as an expected
JavaScript exception. The report contained no crashes, timeouts, or harness errors.

The fingerprinted baseline is in `build/test262-fingerprinted-baseline/`. `results.tsv` contains
one row per variant and artifact identifiers. `summary.txt` records the denominator, verdict
totals, suite revision, and these Git blob fingerprints:

- Compiler: `52d2fc238b8787e129bad257191f7f58fa9360d3`
- Coil runtime: `2d18e5a94c92545f9e92decd5e4cf5b4c71446d8`

Reproduce with a fresh output directory after building the manifest artifacts:

```
coil build
coil build src/main.coil -o build/aot-test262-compiler
coil run tools/test262.coil -- run /Users/jimmyhmiller/Documents/Code/open-source/test262 ./build/aot-test262-compiler build/release/aot-runtime.o build/test262-next-campaign
```

The runner refuses an existing output directory. It checks suite revision/cleanliness before
execution and again before publishing results. It returns one when any test has not passed;
this is the expected baseline exit status. Generated reports and diagnostics stay under `build/`.

The goal remains a working runner and at least 10% passing across the denominator above.
