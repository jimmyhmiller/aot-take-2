# Test262 conformance campaign

## In-memory campaigns

Build once, then run an exact, evenly distributed 1,000-file sample (use a new output directory):

```
coil build tools/test262.coil -o build/aot-test262-memory
AOT_T262_LIMIT=1000 AOT_T262_JOBS=4 build/aot-test262-memory run-memory /Users/jimmyhmiller/Documents/Code/open-source/test262 build/test262-memory-1000
```

This eagerly compiles native code and relocates/executes it in memory. There is no per-case
compiler launch, object file, external linker or executable launch. Each shard has a persistent
worker with fresh compiler scratch and runtime realm per request. Fatal compiler exits/signals
cause replacement by fork. The supervisor retains a content-validated, parsed-and-checked JSL
library for workers to inherit. Each worker also owns bounded caches of retained Script images
and sequence hosts, plus a compiled provider for explicit JSL boundaries (`:noinline` and
`:specialize`). Different source compilations reuse that provider's machine code; ordinary
optimizable JSL definitions remain local. The provider includes intrinsic identities independent
of any one test's syntax. Artifact reuse does not reuse mutable realm state or an installed
mapping across SourcePrograms. It compiles the test unit before acquiring the ordered harness bundle, then
executes harness Scripts before the test in a fresh shared realm. Cache keys include exact source
bytes/boundaries, seed and JSL dependencies. Fatal worker replacement discards its native cache.
Shared global let/const bindings include TDZ, const-write completions and runtime declaration
checks. Captured local/block environments and other compiler gaps remain; this integration does
not establish complete Test262 semantics or a speedup over the earlier closed-program runner.

The engine currently requires Darwin/AArch64. `AOT_T262_COMPILE_SECONDS` defaults to 30 for
transmission and compile/install stages; `AOT_T262_RUN_SECONDS` defaults to 15. Output retention
is 64 KiB per stream; overflow cannot pass. Normal JavaScript throws return to the worker, but
typed runtime negative-test matching remains unimplemented. Parse-negative tests retain the
exit-73 plus exact SyntaxError-record contract and do not compile harness code.

`AOT_T262_LIMIT` selects exactly that many files across the pinned, sorted inventory; it cannot
be combined with `AOT_T262_SAMPLE` other than 1. All required variants count, including unsupported
plans. `summary.txt` records the engine, executable hashes, limit, wall time and verdict counts.
Each attempted memory variant retains `.memory.stdout`, `.memory.stderr` and `.memory.metrics`;
metrics are TSV: compile/transmission ns, assembly/install ns (including a host-cache miss), run
ns, observed compiler-region reserved-byte peak, cumulative worker starts within its shard,
source-cache hits, source-cache misses, host-cache hits, host-cache misses. Cache counters are
cumulative within the current worker and reset on replacement; use worker starts to distinguish
lifetimes. Scratch sampling occurs at phase reports and successful cache captures, so a fatal
compile can end before its peak is reported. Campaign exit 1 means not all files passed.

For direct native-memory Script execution outside Test262:

```
coil run tools/memory-run.coil -- HARNESS.js TEST.js
```

Add `--retained` after `--` to compile each input as an independent retained Script unit,
then assemble and execute them in input order in one fresh realm:

```
coil run tools/memory-run.coil -- --retained HARNESS.js TEST.js
```

This exercises the public source-cache/program API. The default compiles the inputs together
as a closed program. Set `AOT_TIME=1` to print per-phase compilation timings for either mode.

The runner itself is built normally once. In-memory AOT does not enable JavaScript `eval`,
`new Function`, or imports of unknown source at runtime.

### Cached harness measurement, 2026-09-10

Sparse named-write facts and grouped loop layout reduced the observed campaign time
to **54.351 seconds** with four workers. `results.tsv` matches the 56.841-second
run below byte-for-byte. Evidence: `build/test262-sparse-facts-grouped-layout-1000`,
executable git-blob `0c335bc56b1e04b50487780dc65d8d1c45e9c3c5`. The run overlapped
build/regression checks. The full compiler gate passed 843/843 tests.

After body-local copying and sparse GC liveness words, the same campaign took
**56.841 seconds** with four workers. Its `results.tsv` matches the 60.142-second
run below byte-for-byte. Evidence: `build/test262-sparse-copy-gc-verified-1000`,
executable git-blob `dec1d6006e3e2bfa6db42e916ba040bc290634b2`. This campaign
overlapped regression/build checks. The final compiler gate passed 840/840 tests.

With sparse stack-map recording, linear graph verification and indexed GCM
dominators, the same 1,000-file / 1,927-variant sample took **60.142 seconds** with
four workers. Its complete `results.tsv` matches the 76.138-second campaign below:
170 passing files and zero timeouts/crashes/harness errors/not-run. Evidence:
`build/test262-linear-indexed-1000-20260910`, executable git-blob
`2aa3137749978d6430b5e4bba7d8fc86074f66e4`. The new run overlapped build/regression
checks, so this is an observed campaign time rather than an isolated benchmark.

After transitive predicate-availability bounds, distinct-user scheduling and shared global
lookup bodies, the same sample took **76.138 seconds**. It passed the same 170 files as
the preceding shared-lexical run, which took 301.375 seconds. Variants: 324 pass, 370 fail,
1,195 unsupported, 38 compiler errors, zero timeouts/crashes/harness errors/not-run.
The complete verdict comparison has ten changes: former timeouts now report unsupported.
Deadlines stayed unchanged. Evidence: `build/test262-distinct-users-global-read-1000-20260910`,
executable git-blob `700afe2649c541a7ebb4a086672db75b99c8a344`.

Among the 540 requests reaching installation, compile/transmission time had median 100.811 ms,
p90 797.279 ms and maximum 1,621.982 ms. Across all 1,714 attempted memory requests, including
compiler refusals, thirteen exceeded one second and the maximum was 5,825.597 ms. A request
can include test and harness compilation; these are not per-source compiler timings.
This campaign predates the subsequent encoder ownership-cache improvement. The target of
hundreds of milliseconds per compilation remains open.

The exact 1,000-file sample (1,927 variants, four workers) took 238.563 seconds with retained
source/host caching and variant-first compilation. It passed 169 files: 322 passing variants,
360 failures, 1,199 unsupported, 38 compiler errors and eight compile timeouts. Crashes, harness
errors and not-run counts were zero. Evidence: `build/test262-cached-test-first-1000-20260910`,
binary fingerprint `0b8bb83450bcd9d3a43821c61d0ac7e46bd7ece3`.

The first cached run, compiling the harness first, took 425.343 seconds with the same 169 passing
files and two compile timeouts (`build/test262-cached-harness-1000-20260910`). Reordering compilation
cut that run's time by 44%, while preserving harness-first evaluation. It remains slower than
the earlier 101.511-second closed-program run. The eight timeouts cover both modes of three large
Temporal tests and `language/expressions/property-accessors/S11.2.1_A4_T8.js`; retained compilation
cost remains unfinished. These measurements predate shared global let/const support.

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

## Running campaigns

The runner shards files across forked workers (`AOT_T262_JOBS`, default 8; worker k takes every
k-th eligible file in suite order and writes `shard-k.tsv`/`shard-k.counts`, which the parent
merges into `results.tsv` and `summary.txt`). `AOT_T262_SAMPLE=N` runs every N-th file only: a
quick campaign over 1/20 of the suite takes about nine minutes on eight workers and its pass rate
is over the sampled files (the summary records `jobs=` and `sample=`). Artifacts are
`case-<file-index>-<variant>`. Stage deadlines: compile `AOT_T262_COMPILE_SECONDS` (default 30),
link `AOT_T262_LINK_SECONDS` (default 30), run `AOT_T262_RUN_SECONDS` (default 15; a freshly linked
executable's first launch waits about 2.5 s on macOS while the host validates the new binary — the
old 2 s run deadline turned every such case into a timeout once that validation slowed on
2026-09-09); a compile past its deadline is a `timeout` verdict, so when timeouts appear the
per-case compile time is what to fix. Never edit `jsl/` or run `coil build` during a campaign.

```
AOT_T262_SAMPLE=20 AOT_T262_JOBS=8 coil run tools/test262.coil -- run /Users/jimmyhmiller/Documents/Code/open-source/test262 ./build/aot-test262-compiler build/release/aot-runtime.o build/test262-sample-YYYYMMDD
```

## Latest measured campaign, 2026-09-16 (full, after iteration, JSON, collections and Date)

The full inventory, 53,582 files, in memory at `AOT_T262_JOBS=6`: **14,806 files passing
(27.63%)**, up from 11,720 (21.87%). 55 minutes wall. Variants: pass 28,627, fail 25,889,
unsupported 39,034, compiler-error 9,252, crash 113, timeout 11.

What moved it: destructuring, optional chaining, spread and object rest, the iteration protocol,
`Array.prototype.sort`, the array iterator kinds, `Array.from`/`of`, `Object.entries`/`values`/
`assign`/`fromEntries`, JSON with replacer and reviver, Map and Set, image accessors, Date, and the
String and Array methods a script reaches for.

**One bug is 75% of the compiler errors.** `rt-unit-merge-object-properties!: conflicting existing
property` accounts for **6,958 of the 9,252** — about 13% of the whole corpus, dwarfing every other
cause (the next are 285 `expected semicolon or line terminator` and 96 `invalid destructuring
target`). It is worth knowing exactly what it is before anyone fixes it:

- It is **not reachable through `aot run-script`**. The harness and the test compiled together in
  one compilation pass; so do two scripts that materialize overlapping intrinsics, and two scripts
  that redeclare each other's globals.
- It needs the runner's **cached harness bundle**: the harness is compiled once as its own unit and
  merged with each test unit, so the two images were built against realms that materialized
  different sets of intrinsics, and the merge then finds one property defined twice with values
  that are not SameValue.
- Reproduction: `AOT_T262_LIMIT=60 AOT_T262_JOBS=1` gives 6 conflicts out of 8 compiler errors.
  `test/built-ins/Array/proto.js` conflicts under the runner and passes standalone;
  `test/built-ins/DataView/prototype/getFloat16/this-is-not-object.js` conflicts under the runner
  and standalone refuses honestly by name (`Float64Array`).

So the 27.63% understates what the compiler does by something under 13 points, and the fix is in
artifact reuse rather than in JavaScript semantics.

## Latest measured campaign, 2026-09-09 (sampled, after Math and the number globals)

With Function.prototype call/apply, the Object statics and prototype methods, the Number and
Boolean prototypes, the closed-world image facts (a compile-time increment: 327 files either way)
and then `Math`, `isNaN`, `isFinite`, `parseInt` and `parseFloat`, the 1-in-20 sample measured
**340 / 2,680 files passing (12.68%)**: verdict-fail 1,186, verdict-compiler-error 112, no crashes,
no timeouts. The failures rank themselves as before: 716 undeclared globals (Temporal 100, eval 70,
ArrayBuffer 58, Symbol 53, Date 50, RegExp 42, JSON 31, Intl 30, Proxy 22, Reflect 22, Set 22, …),
190 property descriptors (`Object.defineProperty` 127, `getOwnPropertyDescriptor` 26,
`defineProperties` 12, `Object.create` with descriptors 10, freeze/isExtensible/…), 74 ToObject on a
primitive (44 of them `new String(…)`), 50 `Array.prototype` methods on array-likes (every, reduce,
filter, map, indexOf, some, forEach — generic since), 30 reads of properties of `undefined`, 25 the
`Function` constructor (a permanent refusal), 16 ToPrimitive of an object. Evidence: a scratch
snapshot's `build/test262-sample-20260909i/results.tsv`.

## Earlier measured campaign, 2026-09-09 (sampled, after arrays, strings and callbacks)

With arrays, the callback methods, `new.target`, StringToNumber, String.prototype and the campaign's
own fixes (the may-throw filter's `instanceof`, GCM's shared globals, the loop tree's parent rule,
the allocator's deleted edges), the 1-in-20 sample measured **305 / 2,680 files passing (11.38%)**:
verdict-pass 580, verdict-fail 1,256, verdict-unsupported 3,190, verdict-compiler-error 112, no
crashes, no timeouts (the run deadline now absorbs a fresh binary's first launch). Uncaught
exceptions report their value, so the failures rank themselves: 742 undeclared globals (Temporal,
eval, ArrayBuffer, Date, Symbol, Function, RegExp, JSON, Math, …), 177 `Object.defineProperty` /
`getOwnPropertyDescriptor` / `create` / `defineProperties` not a function, 74 ToObject on a
primitive (`Number.prototype`, `Boolean.prototype`, wrapper objects), 26 `Function.prototype.call`
on an intrinsic method, 16 ToPrimitive of an object. Evidence: a scratch snapshot's
`build/test262-sample-20260909d/results.tsv`; the earlier same-day run before the callback work
measured 289.

## Latest measured campaign, 2026-09-08 (sampled, after the compile-time architecture)

With static string literals, all-caller-save frames, direct split insertion and the other
corrections of docs/COMPILE-TIME.md, the same 1-in-20 sample (2,680 files, 8 workers) ran in
**4m13s** (from 8m50s) and measured **262 / 2,680 files passing (9.77%)**: verdict-pass 498,
verdict-fail 1,025, verdict-unsupported 3,498, verdict-compiler-error 113, verdict-timeout 4. The
four timeouts are run-stage (each case compiles in under 50 ms standalone and linked; the executable
exceeds the 2 s run deadline), so they are runtime hangs to investigate, not compile time.

## Earlier measured campaign, 2026-09-08 (sampled)

After strict mode, intrinsics, keyed access, TypeError objects and `finally`, a 1-in-20 sample
(2,680 files, 8 workers, 8m50s) measured **259 / 2,680 files passing (9.66%)**, up from 7.88% on
the full baseline: verdict-pass 493, verdict-fail 1,013, verdict-unsupported 3,497,
verdict-compiler-error 117, verdict-timeout 17 (compiles past 10 s under load; the deadline is 30 s
now). Run-stage refusals by frequency: undeclared standard globals 661 (the builtin library),
uncaught exceptions 260, wrapper objects 64, StringToNumber 15, ToPrimitive 9, one invariant trap
(top-level `this.x = v`, fixed). Compile-stage: array literals 1,165, BigInt 483, classes 366,
default/rest/generator/async functions 127, object methods and accessors 105, regular expressions
91, methods as values 89, Script lexical TDZ 64. Arrays are the largest single blocker.

## Earlier measured campaign, 2026-09-08 (full)

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

The runner reads `jsl/compiler/index` and its units from the working tree at run time and links
`build/release/aot-runtime.o`: do not edit `jsl/` or run `coil build` while a campaign runs (the
2026-09-08b campaign compiled against a half-edited unit and refused nearly every case), or run
the campaign from a separate worktree. The runner refuses an existing output directory. It checks suite revision/cleanliness before
execution and again before publishing results. It returns one when any test has not passed;
this is the expected baseline exit status. Generated reports and diagnostics stay under `build/`.

The goal remains a working runner and at least 10% passing across the denominator above.
