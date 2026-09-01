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

## 2026-08-31 — Dynamic words use high-prefix NaN boxing with signed 48-bit integers

Simple has no JavaScript value representation. Our dynamic word reserves positive quiet-NaN
prefixes in the high 16 bits: `0x7ff8` is the canonical double NaN, `0x7ff9` is an integer, and
subsequent prefixes are assigned to the other non-double tags. Non-NaN doubles remain their exact
IEEE-754 bits. A tagged value's low 48 bits are its payload.

The integer payload is signed two's complement. Boxing therefore replaces the high 16 bits with
`0x7ff9`; unboxing sign-extends bit 47. This gives the promised signed 48-bit immediate range and
also preserves a small program result in the low exit-status bits. Encoding this explicitly is
mandatory: treating Box as an identity would make negative integers and runtime tag tests wrong.

## 2026-08-31 — Return GVN identity includes function ownership

Final Simple rejects Return equality when either owning Fun is dead, while its distinct RPC edges
normally keep live Returns in different functions structurally unequal. Our currently supported
frontend has not yet materialized RPC nodes, so two live Returns can otherwise become identical
during the short clone-inlining window. That merged node carries only one `fun-nid`, corrupting the
other function's ABI masks, symbol, and frame ownership.

Function ownership therefore participates directly in Return equality and hashing here. This
makes explicit a fact Simple normally obtains from the RPC edge and remains valid after concrete
RPC construction: a Return is a function exit, not a freely shareable tuple expression.

## 2026-08-31 — Atomic loop finalization keeps the entry Scope alive

Final Simple's `_endLoop` closes control and then every lazy Phi backedge while the Java ScopeNode
object remains locally reachable. Coil reclaims graph nodes eagerly when their last use disappears.
Resolving the back Scope's memory sentinel can therefore remove the entry Scope's last graph use
before later variable slots have been finalized.

`scope-end-loop!` explicitly keeps the entry Scope for the complete atomic operation and releases it
after the back Scope is killed. This is a lifetime adaptation only: edge order, lazy-Phi rules, and
the final useless-Phi cleanup continue to follow Simple.

## 2026-08-31 — Phi results at one block head interfere pairwise

Phi definitions execute in parallel at their Region or Loop head. Distinct surviving value Phis at
one head are simultaneously defined and cannot occupy the same register. Simple's backwards
liveness walk derives this constraint from the live Phi ranges. Our durable schedule and unified
LRGs did not reliably materialize that edge, allowing two loop induction values to share X0 and
turn a terminating loop into an infinite loop.

The IFG builder now records pairwise interference between overlapping, register-producing Phi masks
at a block head before its ordinary backwards walk. This states the SSA parallel-definition rule
directly and remains conservative when a Phi later needs spilling.
