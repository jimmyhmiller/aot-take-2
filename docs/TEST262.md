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

Execution, result accounting, realm host bindings, module loading, and async supervision are
not implemented by this tool yet. The compiler's existing Script entry is necessary groundwork,
but lacks the shared global environment and exception/function-expression support needed by
the upstream assertion harness. No test262 execution or passing percentage has been established.

The goal remains a working runner and at least 10% passing across the denominator above.
