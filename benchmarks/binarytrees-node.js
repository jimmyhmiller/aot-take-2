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

function powerOfTwo(exponent) {
  if (exponent < 1) {
    return 1;
  }
  return 2 * powerOfTwo(exponent - 1);
}

function main() {
  const maxDepth = 15;
  let total = itemCheck(bottomUpTree(maxDepth + 1));
  const longLivedTree = bottomUpTree(maxDepth);
  let depth = 4;
  while (depth < maxDepth + 1) {
    const iterations = powerOfTwo(maxDepth - depth + 4);
    total = total + work(iterations, depth);
    depth = depth + 2;
  }
  return total + itemCheck(longLivedTree) - 6444382;
}

process.exit(main());
