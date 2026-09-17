# Benchmarks

These inputs compare the native compiler and Node using the same deliberately recursive Fibonacci
algorithm and `fib(40)` workload. Both programs validate the complete result; success exits with
status zero. Compilation is performed before timing so the AOT result measures only the generated
executable.

On an Apple M2 Max running macOS 26.5.2, Node 26.5.0, and hyperfine 1.18.0, 15 measured runs after
three warmups produced:

| Runtime | Mean | Standard deviation | Range |
| --- | ---: | ---: | ---: |
| aot-take-2 | 902.1 ms | 8.1 ms | 885.9–912.5 ms |
| Node | 979.5 ms | 35.3 ms | 919.6–1034.9 ms |

The generated AArch64 executable was **1.09 ± 0.04 times faster** in this whole-process benchmark.
This is one small recursive numeric workload, not a general JavaScript performance claim.

## Managed binary trees

`binarytrees-aot.ts` and `binarytrees-node.js` run the same supported-language adaptation of the
Benchmarks Game allocation pattern at depth 15: one stretch tree, one retained long-lived tree, and
the usual batches of temporary trees. Both validate the complete 6,444,382 checksum. The AOT run
uses the runtime's default 8 MiB nursery and 64 MiB old-generation semispaces; no GC environment
override is present.

On the same machine and Node 26.5.0, 15 measured whole-process runs after three warmups produced:

| Runtime | Mean | Standard deviation | Range |
| --- | ---: | ---: | ---: |
| aot-take-2 | 127.1 ms | 3.2 ms | 122.8–132.7 ms |
| Node | 118.5 ms | 2.8 ms | 110.8–122.2 ms |

Node was **1.07 ± 0.04 times faster**. Unlike the Fibonacci workload, this comparison exercises
managed object allocation, recursive traversal, repeated default-policy collections, and a root
retained across the full temporary-tree workload.

## Warm-JIT comparison

`fib-warm-aot.ts` and `fib-warm-node.js` each execute one explicit `fib(35)` warmup and then twenty
more calls in the same process. The warmup participates in the validated aggregate, so neither
compiler can discard it. V8's optimization trace confirms that `fib` advances through Maglev to
TurboFan during the run.

Ten measured whole-process runs after one external warmup produced:

| Runtime | Mean | Standard deviation | Range |
| --- | ---: | ---: | ---: |
| aot-take-2 | 1.698 s | 0.012 s | 1.679–1.710 s |
| Node | 1.752 s | 0.050 s | 1.710–1.836 s |

The generated executable was **1.03 ± 0.03 times faster**. This comparison is dominated by
warmed recursive execution, but it still times the whole process and the shared warmup; it is not
an isolated in-process timing region.

Reproduce it from the repository root:

```sh
coil build --release
build/release/aot compile benchmarks/fib-aot.ts /tmp/aot-take-2-fib.o
cc /tmp/aot-take-2-fib.o build/release/aot-runtime.o -o /tmp/aot-take-2-fib
hyperfine --warmup 3 --runs 15 /tmp/aot-take-2-fib 'node benchmarks/fib-node.js'

build/release/aot compile benchmarks/fib-warm-aot.ts /tmp/aot-take-2-fib-warm.o
cc /tmp/aot-take-2-fib-warm.o build/release/aot-runtime.o -o /tmp/aot-take-2-fib-warm
hyperfine --warmup 1 --runs 10 /tmp/aot-take-2-fib-warm 'node benchmarks/fib-warm-node.js'

unset AOT_RT_HEAP_BYTES
build/release/aot run benchmarks/binarytrees-aot.ts /tmp/aot-take-2-binarytrees.o /tmp/aot-take-2-binarytrees
hyperfine --warmup 3 --runs 15 /tmp/aot-take-2-binarytrees 'node benchmarks/binarytrees-node.js'
```

Set `AOT_RT_GC_STATS=1` on the generated AOT executable to print machine-readable collection,
allocation, promotion, and remembered-card counters to standard error at process exit. The flag is
off by default and does not change collection policy. Statistics mode deliberately routes
allocations through the instrumented slow path, so benchmark elapsed time without that flag.

## V8 Benchmark Suite, version 7

`benchmarks/v8/` holds the eight benchmarks of the V8 Benchmark Suite v7 and its `base.js` harness,
as the original Scripts: Richards, DeltaBlue, Crypto, RayTrace, EarleyBoyer, RegExp, Splay and
NavierStokes. Each file keeps its own license header. They were taken from the Node.js packaging
of v7 with its CommonJS wrapper removed (three lines per file), and checked line for line against
the plain-Script v6 copies, whose benchmark bodies are identical; only `BenchmarkSuite.version`
differs. `run.js` is the driver: it runs every suite the preceding Scripts registered and prints
each result and the score, as the suite's `run.html` does.

Run one benchmark as a realm of three Scripts, in order:

```sh
build/release/aot run-script benchmarks/v8/base.js benchmarks/v8/richards.js benchmarks/v8/run.js \
  /tmp/richards.o /tmp/richards
cat benchmarks/v8/base.js benchmarks/v8/richards.js benchmarks/v8/run.js | node -
```

### Status, 2026-09-16

None of the eight runs yet. Under Node 26.5.0 on the Apple M2 Max all eight complete.

| Benchmark | Node score | aot-take-2 |
| --- | ---: | --- |
| Richards | 54,499 | compiler panic: register allocator split budget (harness) |
| DeltaBlue | 138,563 | compiler panic: register allocator split budget (harness) |
| Crypto | 63,030 | compiler panic: register allocator split budget (harness) |
| RayTrace | 140,524 | compiler panic: register allocator split budget (harness) |
| EarleyBoyer | 124,661 | parser refusal: escaped or non-ASCII string property key |
| RegExp | 16,167 | refusal by name: regular expression objects |
| Splay | 66,366 | compiler panic: register allocator split budget (harness) |
| NavierStokes | 42,294 | compiler panic: register allocator split budget |

Five of the eight stop in the same place, and it is not benchmark code: **compiling `base.js` by
itself** fails with `ra-run!: allocator exceeded its split budget` on the Phi for
`continuation || index < length`, the loop condition of `RunStep` inside
`BenchmarkSuite.RunSuites`. A reduction of that function alone compiles and runs, so the failure
needs more of the harness than the loop. NavierStokes fails in the allocator the same way at a
different node. The harness had never compiled in this repository before: the 2026-09-15 compiler
stops earlier, on captured variables.
