function readField(o) { return o.x; }
for (let i = 0; i < 100000; i++) readField({x: i});
