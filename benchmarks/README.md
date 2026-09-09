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
