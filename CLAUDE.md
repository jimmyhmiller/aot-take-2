# aot-take-2

An ahead-of-time TypeScript/JavaScript compiler on a sea-of-nodes IR, written in Coil.

---

# THE ONE ABSOLUTE RULE: NEVER LOOK AT TAKE-1

**You must NEVER read, open, search, grep, `cat`, `find`, copy from, port from, cite, summarize,
or in any way consult the previous attempt at this project.**

It lives at:

```
~/Documents/Code/projects/aot-kit-gradual
```

Also known as: "take 1", "aot-kit", "aot-kit-gradual", "the previous attempt", "the old project".

This prohibition covers **every file in and under that directory**, without exception:

- its source (`src/**`, `lib/**`, `native/**`, `tools/**`)
- its documentation (`docs/**`, `README.md`, `HANDOFF.md`, `AGENTS.md`, `project.md`)
- its tests, benchmarks, results, repros, scratchpad, and build output
- any worktree, branch, stash, or git history belonging to it
- any copy of it that appears anywhere else on this machine under any name

It also covers **derived knowledge**: do not reconstruct its decisions from memory, do not
paraphrase its documents, do not reintroduce its module names, and do not repeat "the thing take-1
learned" as if it were established here. If a fact about the compiler is true, it must be
re-derived here, in this repository, from Simple and from first principles — and written down here.

**This is a clean-room rebuild. Take-1 does not exist.**

If you find yourself about to consult it — because a problem looks familiar, because you want to
check how something was done, because a document there would answer a question quickly — **stop and
ask the user instead.** Speed is not a reason. There is no exception for "just to check", "just the
docs", "just the file list", or "just to avoid repeating a mistake".

If you have already looked at it by accident, say so plainly and immediately.

### The single exception: `jsl/` in THIS repository

`jsl/` — the JavaScript runtime library and its `index` — was placed in this repository
deliberately, by the user, as the **one and only** thing that carries forward. It is ours. Read it,
edit it, compile toward it, treat it as first-class source of this project.

The exception is exactly that directory as it stands here, and nothing else. It does not license
looking at where it came from, at anything beside it there, or at any document describing it. If you
want to know what a `.jsl` form means, read `jsl/` and `docs/JSL.md` — both of which live here.

---

# THE SECOND RULE: WE WRITE COIL AND JSL. NOTHING ELSE.

**Every line of this project that is authored by a human or by you is Coil (`.coil`) or JSL
(`.jsl`).** There is no third language.

Explicitly forbidden as authored source, with no exceptions:

- **No C.** No runtime shim, no `native/` directory, no `.c`/`.h` glue, no `[cc] sources` in
  `Coil.toml`. Calling libc through `(extern … :cc c …)` is Coil declaring a C symbol and is fine;
  *writing* C is not.
- **No JSON.** No `spec/*.json`, no manifests, no side-car data files with a generator that reads
  them. Data that the compiler needs is Coil source or a JSL declaration, where the type checker
  and the reader can see it. `jsl/intrinsics.jsl` and `jsl/object-layouts.jsl` exist precisely
  because they replaced generated JSON — do not recreate what they removed.
- **No shell, Python, JavaScript, Go, or Make as tooling.** Build, test and inspect with `coil
  build`, `coil test`, `coil run`, `coil check`. A tool goes in `tools/*.coil` and is a Coil
  program. If something cannot be done that way, that is a finding to raise, not a reason to
  reach for a script.
- **No YAML, TOML or INI config we author**, beyond `Coil.toml` itself, which is the Coil
  compiler's own manifest.

**JavaScript and TypeScript appear only as input.** `.ts` and `.js` files are programs we compile
and test fixtures we compile — never implementation. A `.js` file that *does* something in this
repository is a bug.

**Emitting is not authoring.** The compiler prints Graphviz, disassembly, textual IR, Mach-O and
ELF bytes. Producing bytes in some format is the compiler doing its job. The rule is about what we
*write by hand*.

**The consequence to plan around: the runtime is Coil.** Whatever a compiled program needs at
runtime — allocation, the collector, string primitives, host I/O — is Coil compiled into the
binary or machine code we emit. `cc` is used as a linker, never as a compiler for our code. Nothing
in this design gets to fall back on "just write that bit in C".

---

## The one reference you MAY read

```
~/Documents/Code/open-source/Simple
```

Cliff Click's SeaOfNodes/Simple. This is the reference implementation and the structural model for
this project. Read it freely: source, docs, chapter READMEs, tests. We follow it closely.

Simple is a compiler for a small, strongly-typed, C-like language. Where JavaScript forces a
divergence, the divergence is designed here and written down in `docs/DESIGN.md` — never inherited.

### Write down how Simple does it, in the file that does it

This is about FIDELITY, not paperwork. The failure mode of this project is inventing something
plausible where Simple already had an answer — and the answer is usually better, because it was
arrived at by building the thing.

So a module implementing an algorithm Simple has carries, in its header comment, an account of how
Simple performs it: the rules in the order Simple applies them, the guards and what each one
prevents, and the traps. `src/node/call.coil` and `src/codegen/gcm.coil` are the model.

Read Simple's source before writing that header. Not memory — the source. Where we then diverge,
that is a decision to record, and having Simple's version on the same screen is what makes the
divergence visible as a decision instead of a drift.

Licensing is handled once, at the project level, in `NOTICE` and `licenses/Apache-2.0.txt`. It is
not a per-file concern.

---

## What we are building

A **complete** AOT compiler for TypeScript and JavaScript:

- **JavaScript is the semantics.** Every value is dynamic; every operation is an ECMA-262 abstract
  operation, defined in `jsl/` and lowered into the same ideal graph the frontend produces.
- **TypeScript is the evidence.** An annotation is a claim the compiler *discharges*, not a hint it
  trusts. TypeScript is deliberately unsound, so an unproven annotation keeps its guard.
- **Strictly AOT.** No `eval`, no `new Function`, no dynamic `import()` of unknown code. That closed
  world is what makes an annotation provable. There is no deoptimisation machinery in the design: a
  failed guard is ordinary control flow into a generic version compiled into the same binary.

## We are building the FINISHED compiler, not a chapter sequence

Simple is organized as 25 teaching chapters, each a self-contained subset. **We are not doing
that.** The architecture in `docs/LAYOUT.md` is the end state — Simple's chapter-25 architecture,
extended for JavaScript — and it is the *only* architecture this project ever has.

There is no "add calls later", no "start without memory", no simplified intermediate design that
gets replaced. Every module is written against the final interfaces from the first line. Work is
sequenced by *filling in* that fixed architecture, never by evolving it.

When you read a Simple chapter, read it for the *idea*. Take the code from the final chapter.

## Stubs

Per the global rule: a stub MUST hard-error with a clear message naming itself. Never return a
placeholder value. In Coil:

```clojure
(defn gcm-schedule-early [(n (dyn NodeOps))] (-> i64)
  (panic "UNIMPLEMENTED: gcm-schedule-early — global code motion, see docs/LAYOUT.md §backend"))
```

A stub that returns `-1`, `0`, `null`, or an empty collection is forbidden. It makes the failure
appear somewhere else, hours later.

## THE LINT MUST BE CLEAN. ALWAYS. ZERO WARNINGS.

**`coil lint --fix` is part of every change, and the project carries ZERO lint warnings at all
times.** This is a hard requirement, not a preference and not a cleanup task for later.

```sh
coil lint --fix     # run it; then re-run until it reports nothing
coil check          # must exit 0
coil test           # must be green
```

Never leave a warning behind "for now" and never silence one to make the count go to zero. If a
rule is genuinely wrong for this codebase, that is a conversation to have and a decision to record
in `docs/DECISIONS.md` — not something to work around quietly.

**Check the tree after `--fix` runs**, because it rewrites your code: follow every `--fix` with
`coil check` and `coil test`. A `--fix` that ends in an error is a signal to inspect the tree, not
to move on — a failed run has once been observed leaving files modified while reporting
`all changes reverted` (filed in the `coil-bugs` pad, 2026-08-29; the rewrite that triggered it has
since been fixed, and the leak itself was never minimized).

When a `--fix` suggestion looks wrong, check it rather than accepting it. Report it to the
`coil-bugs` pad with a minimal reproduction and keep the correct code.

## Working here

- `coil test` is the gate. Green is the contract; nothing is committed red.
- `coil check FILE` typechecks a single file; `coil namespace coil.X` is how you learn a stdlib API.
  Never guess a stdlib signature — ask the compiler.
- Read `docs/LAYOUT.md` before adding a file. If a file exists with no row in that table, either add
  the row or delete the file.
- `docs/DESIGN.md` is the architecture. `docs/DECISIONS.md` is law — code contradicting it is a bug
  in the code or an amendment to the file, never a silent divergence.
- Ask open questions with the AskUserQuestion tool, with real options. Not as prose, not as a
  bullet in a document.

## Coil hazards specific to this codebase

- Never name a `defn` `call` or `block` — both are reserved. `node/call.coil` exports `call-make!`,
  `call-fun`, and so on.
- Never use `type` as a struct field name. The node header field is `ty`.
- `case` keys are named constants, never literal numbers.
- `if` requires both branches with the same type; effect-only is `(if c (do … 0) 0)`.
- No top-level mutable state: the `CODE` singleton is `alloc/static` inside a zero-arg accessor.
- Never call `alloc/stack` inside a loop.
