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
const initializer, lexical-name conflicts, malformed numeric tokens and an unlabelled break
without an enclosing target.
Unknown grammar still fails outside the syntax-error channel. Strict validation also checks
restricted bindings/assignments, reserved references, duplicate simple parameters and legacy
numeric literals. It derives strictness from each body and Script inheritance, without leaking
a function directive into siblings. Strict runtime compilation remains unsupported.
Global restricted-property failures belong to initialization and cannot count as
parse errors. Runtime negative tests still lack a typed abrupt-completion protocol.

The compiler still lacks the shared global environment and exception/function-expression support
needed by the upstream assertion harness. Multi-Script evaluation, module plans, and async execution receive
explicit unsupported results and remain in the denominator. Typed JavaScript abrupt-completion
reporting at runtime and realm host bindings remain unimplemented. Do not convert a nonzero native exit into
an expected exception by parsing its diagnostics.

## Latest measured campaign, 2026-09-06

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
