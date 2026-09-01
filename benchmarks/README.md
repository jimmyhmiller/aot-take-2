# Benchmarks

These inputs compare the native compiler and Node using the same deliberately recursive Fibonacci
algorithm and `fib(40)` workload. Both programs validate the complete result; success exits with
status zero. Compilation is performed before timing so the AOT result measures only the generated
executable.

On an Apple M2 Max running macOS 26.5.2, Node 26.5.0, and hyperfine 1.18.0, 15 measured runs after
three warmups produced:

| Runtime | Mean | Standard deviation | Range |
| --- | ---: | ---: | ---: |
| aot-take-2 | 893.0 ms | 1.9 ms | 890.6–897.3 ms |
| Node | 975.7 ms | 21.0 ms | 932.2–1025.6 ms |

The generated AArch64 executable was **1.09 ± 0.02 times faster** in this whole-process benchmark.
This is one small recursive numeric workload, not a general JavaScript performance claim.

Reproduce it from the repository root:

```sh
coil build --release
build/release/aot compile benchmarks/fib-aot.ts /tmp/aot-take-2-fib.o
cc /tmp/aot-take-2-fib.o -o /tmp/aot-take-2-fib
hyperfine --warmup 3 --runs 15 /tmp/aot-take-2-fib 'node benchmarks/fib-node.js'
```
