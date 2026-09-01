function fib(value) {
  if (value) {
    if (value - 1) {
      return fib(value - 1) + fib(value - 2);
    }
    return 1;
  }
  return 0;
}

function main() {
  return fib(40) - 102334155;
}
