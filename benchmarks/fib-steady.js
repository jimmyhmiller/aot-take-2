// Steady-state recursive Fibonacci. The same Script runs under Node and aot-take-2: it warms the
// workload in the process until V8 has optimized `fib`, then times only the measured iterations.
// Each iteration's result is validated, so neither runtime can skip the work.
function fib(value) {
  if (value < 2) {
    return value;
  }
  return fib(value - 1) + fib(value - 2);
}

function measure(warmups, iterations) {
  let i = 0;
  while (i < warmups) {
    if (fib(30) !== 832040) throw new Error("incorrect fib(30) during warm-up");
    i = i + 1;
  }
  const start = Date.now();
  i = 0;
  while (i < iterations) {
    if (fib(30) !== 832040) throw new Error("incorrect fib(30)");
    i = i + 1;
  }
  const elapsed = Date.now() - start;
  console.log("fib(30): " + iterations + " iterations in " + elapsed + " ms, " + (elapsed / iterations) + " ms each");
}

measure(30, 100);
