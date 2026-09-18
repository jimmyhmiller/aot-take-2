# Optimizer proof contracts

This document records the property and specialization contract implemented by the
sea-of-nodes repair. The complete module map is `LAYOUT.md`; existing platform,
runtime and language decisions remain in `DECISIONS.md`.

## Identity is not state

`TIdentity` is a finite/cofinite set lattice over compilation-local image entry
identities. Meet is union, join is intersection, and dual is complement. Empty
and universal are distinct elements. The set storage is shared with the existing
canonical integer-set implementation, but identity and function-pointer types
are separate domains. There is no cardinality truncation inside lattice meet.

`TDyn` and `TMemPtr` carry this independent coordinate. Static references introduce
it; boxing and unboxing preserve it. Ordinary Phi, parameter, return, cast and GVN
operations use the product lattice. Integer widening preserves the identity
coordinate. Identity alone never proves a mutable property present or constant.

## Property proofs belong to a memory position

`prop-own-state(memory, receiver, key, dependent)` is the common proof interface
for specialization, own-property idealization and prototype-holder access. Its
answers are unknown, absent, or present. Present data and accessor descriptors
remain distinguishable through the immutable shape attributes. Absent is not
present with the value `undefined`.

The underlying exact-shape query follows memory SSA definitions. A properties
word Store establishes the backing storage and shape. Distinct aliases and
proven different owners can be bypassed. Phis and memory parameters retain an
exact shape only when every incoming path proves the same shape. Open merges,
cycles, unknown calls and unsupported effects conservatively return unknown.
The query visits at most 1,024 states and has a recursion-depth limit of 256;
either limit loses optional precision, never correctness. Every inspected node
is registered as a dependency of the requesting optimization.

The original Start memory projection represents arbitrary incoming memory.
`START-INITIAL-MEM` is a separate memory projection consumed only by the process
entry wrapper, whose runtime boot creates a fresh realm. An external callable or
retained Script unit must not receive that projection as its unknown-caller seed.
The heap image seeds state at this boundary; a later property assignment changes
memory, not the initial image.

Where exact local state is unavailable, conservative closed-world summaries may
prove invariants that hold at every memory position. Only the common query
interprets these summaries for own properties. A per-key invariant does not prove
the complete backing shape: adding a property by a direct shape transition
requires an exact shape. An invariant unwritten image value can be materialized
as a constant; other reads retain a Load through their incoming memory state.

Prototype traversal preserves ordinary Get/Set semantics. An inherited accessor
continues through the JSL accessor path. OrdinarySet creates a new own property
only after proving that the prototype chain permits it. Unknown prototype state
keeps generic JSL behavior. Physical storage reservation must never be confused
with making an own property semantically present.

The JSL assignment definition accepts `%OwnPropertyAbsent` as specialization
evidence when memory proves the complete shape. This permits lowering the ordinary
assignment body at a creation site. Absence alone does not authorize a store: the
resulting PropSet still proves extensibility and the inherited descriptor before
creating the own property. Accessors and unknown chains retain JSL behavior.

## Expansion and publication

Simple's IterPeeps drains reducing peepholes, admits one inline, and drains again.
JSL source specialization now admits one expansion per round under that same
discipline. A batch that merely snapshots the arena size is insufficient: its
first replacement can invalidate evidence used by later candidates.

Source expansion charges a compilation-wide budget of 4,096 sites and 262,144
constructed nodes. The latter is checked before the next admission, so the last
admitted finite body can cross the node threshold. The charge includes nodes that
subsequently die. Budget exhaustion leaves generic calls and does not interrupt
the mandatory worklist solve. Direct self-recursion remains refused; the global
budget also bounds expansion through longer recursive call paths.

Boundary placement does not replace type and lifetime contracts. Replacement
control, memory and value are kept during projection rewiring; the old call is
unlinked; fresh nodes are queued; CFG and function-size caches are invalidated.
An old result type may be retained because equivalent specialization preserves
the original call's established semantic guarantee, not because a Cast can make
an arbitrary replacement correct. Newly exposed calls must not widen an already
specialized callee's parameters in pessimistic iteration; the existing linking
guard retains those calls until optimistic analysis can link them safely.

## Facts and validation

Fact rescans compare the actual flags, owner/key memberships and per-load target
sets. Equal counts are not convergence. Each individual analysis completes;
the outer three-round limit is an optional precision budget, not a declaration
that the combined analyses reached a fixed point.

Regression tests cover lattice algebra, identity through Phi/Cast/Unbox, initial
versus incoming memory, property creation, conditional creation, unknown effects,
and 24 worklist orders with the exhaustive fixpoint checker. Native tests cover
inherited getters/setters, property presence, exceptions and mutation through
calls. Performance and graph-size gates remain separate from semantic tests.
