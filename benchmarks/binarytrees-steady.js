// Steady-state binary trees: the same allocation pattern as binarytrees-aot.ts (one stretch tree,
// one long-lived tree, batches of temporary trees at depth 15), repeated. The same Script runs under
// Node and aot-take-2; it warms the workload in the process, then times only the measured runs.
// Every run validates the full 6,444,382 checksum.
function bottomUpTree(depth) {
  if (depth < 1) {
    return { left: undefined, right: undefined };
  }
  const next = depth - 1;
  return { left: bottomUpTree(next), right: bottomUpTree(next) };
}

function itemCheck(node) {
  if (node.left) {
    return 1 + itemCheck(node.left) + itemCheck(node.right);
  }
  return 1;
}

function work(iterations, depth) {
  let i = 0;
  let check = 0;
  while (i < iterations) {
    check = check + itemCheck(bottomUpTree(depth));
    i = i + 1;
  }
  return check;
}

function once() {
  const maxDepth = 15;
  let total = itemCheck(bottomUpTree(maxDepth + 1));
  const longLivedTree = bottomUpTree(maxDepth);
  let depth = 4;
  while (depth < maxDepth + 1) {
    total = total + work(Math.pow(2, maxDepth - depth + 4), depth);
    depth = depth + 2;
  }
  return total + itemCheck(longLivedTree);
}

function measure(warmups, iterations) {
  let i = 0;
  while (i < warmups) {
    if (once() !== 6444382) throw new Error("incorrect checksum during warm-up");
    i = i + 1;
  }
  const start = Date.now();
  i = 0;
  while (i < iterations) {
    if (once() !== 6444382) throw new Error("incorrect checksum");
    i = i + 1;
  }
  const elapsed = Date.now() - start;
  console.log("binary trees: " + iterations + " runs in " + elapsed + " ms, " + (elapsed / iterations) + " ms each");
}

measure(5, 20);
