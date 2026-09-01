# Decisions

This file records deliberate architecture choices that differ from Simple or settle behavior not
fixed by the reference implementation. Code contradicting a decision here is a bug unless this
file is amended at the same time.

## 2026-08-31 — AArch64 stack-to-stack splits use a proved IP0 scratch

Final Simple models a split as accepting any physical register or stack slot at either endpoint,
but its AArch64 encoder throws `TODO` when both endpoints are stack slots. We keep the complete
split mask and implement that missing case as `LDR X16, [SP, source]` followed by
`STR X16, [SP, destination]`.

X16/IP0 is not silently clobbered. `Arm64SplitNode` excludes X16 from its own input and output
masks and exposes X16 through `m-killmap`. The interference graph therefore proves that no other
value is live in X16 across a split, while X16 remains allocatable in regions without splits. The
selected size is four bytes for every ordinary split and eight bytes for stack-to-stack expansion,
so layout and emission continue to agree exactly.

## 2026-08-31 — The first collector uses a non-collecting post-write barrier

Simple has no garbage collector and therefore fixes no write-barrier policy. Our initial moving
collector is stop-the-world and generational. A Store whose value is a raw managed reference or a
boxed word that may contain one is followed by a pinned Barrier. The Barrier consumes the Store's
new alias-memory state plus `(object, value)` and returns that same memory type, placing remembered-
set maintenance after the heap write in the memory SSA chain.

Arm64 lowers the Barrier to the project runtime ABI symbol `aot_rt_write_barrier`, with object/value
in X0/X1 and ordinary caller-save kills. The runtime entry is explicitly non-collecting, so this call
is not a safepoint and needs no relocation dance or stack map. A future concurrent or SATB collector
would require amending this decision and changing placement semantics; it must not silently reuse
this post-write boundary as though the policies were equivalent.
