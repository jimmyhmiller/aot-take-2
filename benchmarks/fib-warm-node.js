function fib(value) {
  if (value) {
    if (value - 1) {
      return fib(value - 1) + fib(value - 2);
    }
    return 1;
  }
  return 0;
}

let total = fib(35);
let remaining = 20;
while (remaining) {
  total = total + fib(35);
  remaining = remaining - 1;
}

if (total !== 193776765) {
  throw new Error("incorrect Fibonacci aggregate");
}
