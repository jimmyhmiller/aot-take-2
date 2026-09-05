# AOT Graph Lab

The browser graph playground drives the production phase order inside `aot-graph.wasm`. Coil emits
structured graph facts; the JavaScript client lays them out and renders them on Canvas.

The visual grammar follows Simple's final `GraphVisualizer`: use-to-definition edges flow upward;
control is a yellow box, functions are double boxes, values are ellipses, Phis are pale ellipses,
and projections are ports on their Multi producer. Node fill and edge colors follow result types.
Region/Phi pairs share a rank, Loop/Phi backedges do not constrain rank, and a deterministic
barycentric sweep reduces crossings after strongly connected components have been collapsed for
layering. Control flow is laid out as the global spine. Floating nodes form compact dependency
islands around their compiler-published control anchor, so the client never guesses scheduling
ownership. Control and memory edges use separate outside channels, and the default Related mode
only reveals non-structural edges around the selected node. Dragging a node pins it while leaving
the rest of the automatic layout intact. The Coil serializer—not browser code—owns every semantic
classification.

Source ranges are compiler provenance, not a browser heuristic. Clicking or selecting source text
highlights every graph node whose retained origin overlaps that range; selecting a graph node
selects its source range. Provenance is carried through graph construction, GVN commoning,
subsumption, instruction selection, and allocator-created machine nodes.

The phase selector mirrors all thirteen production phases: Parse, Iter, Opto, Typecheck, Looptree,
Serialize, Unlink, Select, Schedule, LocalSched, Regalloc, Encoding, and Export. A phase is shown
even when it validates or packages the current graph rather than changing topology. Every snapshot
is produced after running the selected production phase; the browser does not substitute an earlier
graph or synthesize a successful status.

Build the browser compiler:

```sh
coil build tools/graph-wasm.coil --target wasm32-unknown-unknown -o web/aot-graph.wasm
```

Serve the repository root and open `/web/`. It must be served from the root because the compiler
loads the production `jsl/compiler/index` and its indexed JSL units into the browser VFS.

Each compile uses a fresh Wasm instance. Coil compilation state is process-scoped, so reusing one
mutated instance across phase or source changes is invalid. The browser-host smoke check exercises
every included example through all thirteen phases.

Encoding and Export snapshots also include an authoritative machine-code stream. The Machine code
tab shows each scheduled instruction's text-relative address, exact emitted bytes, target mnemonic,
and originating graph node. Selecting a row, graph node, or source range cross-highlights the other
representations.
