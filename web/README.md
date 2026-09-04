# AOT Graph Lab

The browser graph playground runs the production parser, JSL lowering, and ideal-graph optimizer
inside `aot-graph.wasm`. Coil emits structured graph facts; the JavaScript client lays them out and
renders them on Canvas.

Build the browser compiler:

```sh
coil build tools/graph-wasm.coil --target wasm32-unknown-unknown -o web/aot-graph.wasm
```

Serve the repository root and open `/web/`. It must be served from the root because the compiler
loads the production `jsl/compiler/index` and its indexed JSL units into the browser VFS.
