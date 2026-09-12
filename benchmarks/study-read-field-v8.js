function readField(o) { return o.x; }
%PrepareFunctionForOptimization(readField);
for (let i = 0; i < 1000; i++) readField({x: i});
%OptimizeFunctionOnNextCall(readField);
readField({x: 1001});
