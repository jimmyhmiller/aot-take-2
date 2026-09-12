function readField(o) { return o.x; }
%PrepareFunctionForOptimization(readField);
const objects = [{x: 1}, {a: 0, x: 2}, {b: 0, x: 3}, {c: 0, x: 4}, {d: 0, x: 5}, {e: 0, x: 6}];
for (let i = 0; i < 1000; i++) readField(objects[i % objects.length]);
%OptimizeFunctionOnNextCall(readField);
readField({x: 1});
