function fib(value) {
  if (value) {
    if (value - 1) {
      return fib(value - 1) + fib(value - 2);
    }
    return 1;
  }
  return 0;
}

if (fib(40) !== 102334155) {
  throw new Error("incorrect Fibonacci result");
}
