# Callable function versions

Status: implemented and validated on 2026-09-19.

The compiler needs to specialize a shared function without requiring its body to be inlined.
JavaScript source functions and locally lowered JSL definitions use the same mechanism. A private
entry is an ordinary Fun with its own Parms and Return. Calls remain calls unless the independent
inliner later chooses to eliminate them.

## Research and the AOT adaptation

[Click and Paleczny, *A Simple Graph-Based Intermediate Representation*, 1995](https://grothoff.org/christian/teaching/2007/3353/papers/click95simple.pdf)
provides the representation: control, data and memory dependencies inhabit the same graph. It does
not prescribe a function-version policy. The existing lattice and node worklist should optimize
each version; no second implementation of JavaScript operations or return-type formulas is needed.

[Chambers, Dean and Grove, *Whole-Program Optimization of Object-Oriented Languages*, 1996,
§4](https://dada.cs.washington.edu/research/tr/1996/06/UW-CSE-96-06-02.pdf) describes selective method
specialization, retaining general-purpose methods and sharing specialized versions across suitable
argument classes. Exhaustive receiver customization can produce too many nearly identical bodies
while missing useful specialization on other arguments. Vortex uses profile information to choose
profitable cases. Our bounded static policy is an adaptation; this implementation does not claim
to implement Vortex's profile-guided profitability algorithm.

[Chevalier-Boisvert and Feeley, *Interprocedural Type Specialization of JavaScript Programs Without
Type Analysis*, 2016, §3](https://arxiv.org/pdf/1511.02956) describes specialized function entries with
a version cap and generic fallback. Its return-continuation specialization can invalidate generated
code when another return type appears. That part depends on a JIT. Here all returns must be justified
by the ordinary graph fixed point, all possible fallback code is compiled ahead of time, and no
observed first return is treated as proof.

[Agesen, *The Cartesian Product Algorithm*, 1995](https://bibliography.selflanguage.org/cpa.html)
is relevant background on argument-context-sensitive type inference. The bibliography and abstract
were available, but its linked PDF returned 404 during this investigation. Detailed CPA mechanisms
are therefore not used as authority for this implementation.

Simple's final `FunNode.copyBody()` and `CallEndNode.doInline()` were read directly. Their two-pass
copying and call-link repair protocol is reused. Simple immediately inlines the copied body;
retained entries, contracts, policy, and their lifetime are explicit extensions here.

## Entry contracts and graph lifetime

Admission follows ordinary optimistic typing. An optimized body may be copied for a narrower
entry domain, but its discarded branches cannot be reconstructed by widening that domain. A trial
captures the source's current parameter and memory bounds before copying. Its normalized argument
key is intersected with those bounds. For a parameter already folded away, the current caller meet
retains the restriction under which its uses were folded; it must not revert to the broad signature.
An entry with unknown callers retains its declared domain. The original graph and its normal
closed-world typing remain intact.

Private entries hold fixed parameter contracts while routing is open. Every redirected call must
prove that its actual argument and memory types are contained in the contract. A later caller cannot
widen it. Calls whose types are
unknown or incompatible retain the generic target; there is no unchecked annotation-based dispatch.
This first policy does not insert speculative runtime guards. Existing control-flow guards can
provide the type evidence used at a call site.

Keys normalize integer constants and ranges to runtime categories before intersecting the source
entry bound. Immutable image identities, including known callable targets, are retained. Mutable
object contents remain memory facts and are not inferred from identity alone. Return, control and
memory facts come from ordinary nodes; reuse also checks that the
destination's continuation state does not widen the caller's existing state.

Body copying preserves source function-pointer identities. A private entry has a distinct internal
object-local linker symbol in Mach-O and ELF, but a copied expression referring to the original function still denotes that
function. Closure/environment arguments retain their normal ABI positions. Copied recursive calls
initially name the generic function. The same argument proof used for any call can redirect them to
an accepted entry, including their own entry. Registration precedes optimization, but a pending
trial is not a routing target. Consequently the initial profitability check can miss improvements
that require simultaneous specialization of a recursive cycle or another callable specialization
inside a pending trial. The policy is conservative; it does
not claim complete discovery of profitable recursive versions.
Optimistic typing is repeated after routing changes recursive components.

Once admission finishes, private entries resume ordinary Fun/Parm caller-meet typing. Their caller
sets can now sharpen below the admission key without risking a later wider reuse. An unused generic
fallback can disappear. Public or provider entries whose callers remain unknown retain their full
generic domain. Imported functions without local bodies remain generic calls. Source and JSL returns
and private-version returns are rooted for code generation under the same liveness rules.

## Selection and trial optimization

A version must separate facts on a used parameter that the shared body cannot already learn from
all its callers. Unused ABI slots are not a reason to clone. The default policy prioritizes large,
recursive, or explicitly non-inlined functions; small ordinary bodies remain the inliner's concern.
Admission waits for ordinary inlining and its deferred candidates to drain. Otherwise a retained
entry can compete with pending inlining and change which code gets shared before cleanup settles.

The optimizer cleans a private trial before redirecting any caller. The trial has a kept Return and
the ordinary Start unknown-caller hook, so its arguments are available to ordinary node typing and
folding. The hook is removed before publication or rejection.
An accepted size specialization must at least halve the body and serve two compatible call sites.
A small body with a strictly sharper return can also qualify, because callers can use that return
fact even while retaining the call. This is a static heuristic, not a claim about measured execution
frequency. Rejected trials are never published to callers and can be collected without rolling back
caller optimizations. Attempted contracts are memoized; unsuccessful trials consume construction
budget but do not consume the limit on accepted versions.

## Policy and controls

`AOT_FUNCTION_VERSIONS='*=2,identity_noInline=4,JsAddOperator=1'` controls the maximum number of
private entries for each named source function; the generic entry is additional. Zero disables new
versions for a function. Matching overrides are applied in order, last match winning. The Coil API
`versions-set-limit!` supplies the same control before optimization. Function naming follows the
existing compiler names, including mangled names where the frontend needs them.

The initial default is two accepted private entries, a 1,024-node body admission ceiling and a
compilation budget of 4,096 copied nodes, including unsuccessful trials. These are
profitability/resource limits, not correctness assumptions.
Accepted bodies additionally share a retained-code allowance of 1% of the live graph at the first
trial (with a 12-node minimum for tiny entries). `AOT_VERSION_GROWTH_PERCENT=0..100` controls this
allowance; zero disables admission. Construction work and retained code are charged separately.
These budgets count ideal nodes; they are not bounds on emitted machine instructions or bytes.
Without profiles, the default deliberately favors small code growth. Increasing a function's count
does not override the compilation-wide resource budgets.
Exhaustion leaves calls generic. A successfully inlineable call is left to the inliner. A
`_noInline` function remains eligible for callable versions. `AOT_VERSION_TRACE=1` reports routing.
All state resets between compilations.

## Validation requirements

Graph tests cover distinct entries, numeric reuse, caps, generic fallback, capture of closed-body
bounds, recursion, JSL metadata, randomized worklist seeds, and reset. Native tests must demonstrate
that retained entries execute with
correct identities and effects. Object tests check local linkage and relocation identities in
Mach-O and ELF. Existing call, optimizer, backend, execution and graph-budget tests
must remain green. Warming and timing Fibonacci and binary trees must use identical workloads in
both runtimes; no performance claim follows merely from implementing versioning.

The frozen-worktree gate (`coil build -o build/release/aot`, then `coil test --jobs 12`) passed
**936 tests, zero failures**. `coil lint --fix` and `coil check` are clean. All five native versioning
tests also pass with `AOT_NO_SPECIALIZE=1`, exercising the graph-copy mode. The recursive precision
regression checks the inferred numeric return contract as well as execution.

The harness graph has 6,320 machine nodes / 1,250 blocks, versus 6,295 / 1,247 with versioning
disabled. The unchanged hard limits are 6,500 / 1,300. Admission follows completion of the inliner
and its deferred candidates; measuring and routing before that boundary produced unnecessary growth.

Warmed measurements on 2026-09-19 use the unchanged `benchmarks/fib-steady.js` and
`benchmarks/binarytrees-steady.js`, three sequential samples per configuration. Enabled and disabled
versions use the same runtime; this excludes the separate runtime optimization worktree. Node
v26.5.0 uses the same inputs, with optimization checked through `--trace-opt`.

| Workload | Versions enabled, ms | Disabled, ms | Node, ms |
|---|---:|---:|---:|
| fib(30), median | 5.32 | 5.36 | 5.80 |
| fib(30), range | 5.26–5.42 | 5.24–5.59 | 5.77–5.84 |
| Binary trees, median | 447.35 | 466.15 | 42.75 |
| Binary trees, range | 442.70–449.40 | 463.60–484.10 | 42.25–64.40 |

Fibonacci's emitted text is unchanged at 25,788 bytes. Binary trees decreases from 41,068 to
40,604 bytes and improves about 4% at the median in these samples. It remains about 10.5 times
slower than Node. The remaining runtime performance gap is unresolved.

The earlier binary-trees pad issue was separately reproduced by reapplying the removed allocation
proof in an isolated worktree. With that proof present, disabled versions give fib(30) times of
7.41, 7.48 and 7.45 ms; enabled versions give 5.42, 5.39 and 5.38 ms. The IR changes from
`dyn{int,double,string}` to `dyn{int,double}` for Fibonacci's return. A string call is routed to its
own `JsAddOperator` entry; ordinary caller-meet typing and SCCP recover the numeric recursive
component. No Fibonacci-specific rule or handwritten return summary is involved. The allocation
proof itself remains outside this implementation branch and has not been newly validated for
general semantic correctness here.
