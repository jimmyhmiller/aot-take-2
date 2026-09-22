# Refactoring with metaprograms

The second rule of this project is that tooling is Coil. That includes the tools that reorganize
the source: they are Coil metaprograms — checkers the compiler runs over the whole program — and
they live in `tools/`. Nothing here is a script, and nothing matches source text with a regular
expression: every tool works from the forms and symbols the compiler's own reader produced, with
the reader's own line and column for each.

All of them are inert until named. A module under `tools/` that registers a checker does nothing
during `coil build`, `coil check` or `coil test`; it runs when `coil lint` is told to `--use` it,
or when `Coil.toml` lists it under `[lint] rules`.

| Tool | Namespace | Runs | What it does |
|---|---|---|---|
| Unused imports | `aot.lint.unused-imports` | every `coil lint` | reports an import the module does not use; `--fix` removes or narrows it |
| Layout | `aot.lint.layout` | every `coil lint` | every source file has a row in `docs/LAYOUT.md` §6, and every row a file |
| Cond | `aot.lint.cond` | every `coil lint` | a staircase of three or more nested `if`s; `--fix` rewrites it as a `cond`, arms byte-for-byte |
| Constructor | `aot.lint.ctor` | every `coil lint` | a struct zeroed and filled field by field with `set!`; `--fix` writes its named constructor, unset fields as explicit zeros |
| Size | `aot.lint.size` | on request | long functions, plus a file threshold only when explicitly supplied — an advisory report, never a gate |
| Split | `aot.refactor.split` | on request | moves top-level forms into other modules; the source re-exports them |
| Rename | `aot.refactor.rename` | on request | respells a definition everywhere it is mentioned, atomically across files |
| Methods | `aot.refactor.methods` | on request | gathers a module's functions into an `impl` block |

Each file's header comment is its manual: parameters, guarantees, and what it refuses. This
document is the workflow that ties them together.

## Why the refactoring tools edit files themselves

`coil lint --fix` can only replace or delete a node inside the file it came from, applies fixes
one FILE at a time, and recompiles between files, reverting a round that does not compile. That is
the right design for a lint fix and the wrong one for a refactoring:

- it cannot create a module, so a split cannot be a fix;
- a rename that spans two files is never compilable at the point where only one has been rewritten,
  so the driver reverts it.

So `split`, `rename` and `methods` compute their edits from the program the compiler hands them and
write the files in one step, behind an explicit `…apply=1` parameter. Without it they only report.
`unused-imports` is a real lint fix — each import is independently removable — and goes through
`--fix` like any bundled rule.

## Splitting a module

A module that has outgrown one screenful of concerns is split into a directory named after it. The
original module keeps its entry points and its account of Simple's algorithm, and re-exports the
parts, so no importer changes:

```
src/codegen/regalloc.coil          (module aot.codegen.regalloc)   driver + (import … :reexport)
src/codegen/regalloc/lrg.coil      (module aot.codegen.regalloc.lrg)
src/codegen/regalloc/ifg.coil      (module aot.codegen.regalloc.ifg)
```

Parts import each other directly. Module cycles are legal in Coil, which is what lets a mutually
recursive family — expression and statement lowering, say — live in separate files.

1. **Index** the module: `first-line length head name` for every form.

   ```sh
   coil lint --use aot.refactor.split \
     --lint-param aot.split.source=aot.codegen.gcm --lint-param aot.split.index=1
   ```

2. **Plan** targets and selectors (`name:`, `lines:A-B`, `prefix:`), and run without `apply` to see
   what each target would receive.

3. **Apply**, then let the import rule narrow what each new module was handed:

   ```sh
   coil lint --use aot.refactor.split … --lint-param aot.split.apply=1
   coil check                 # a cycle or an ambiguity shows here, before anything is pruned
   coil lint --fix            # aot.lint.unused-imports narrows every new module's imports
   coil check && coil lint    # zero errors, zero warnings
   ```

4. **Add the rows** to `docs/LAYOUT.md`. `coil lint` reports each new file until you do.

**Moving a definition a second time** — out of a facade that parts already import by name — leaves
those parts seeing it twice: from `(import FACADE :use [name])` and from the new owner's `:use *`.
`coil check` says so by name (`'name' is ambiguous — exported by :use'd modules A and B`); delete
the name from the facade list in each part. The import rule deliberately does not do this for you:
importing a name through a facade is exactly what every module OUTSIDE the family should do, and a
rule cannot tell a part from a client.

A split moves text; it changes no function body. The gate after a split is therefore the ordinary
one, and a red test after a split means the split moved something it should not have — a duplicate
`extern`, for instance, which one file tolerated by shadowing and two files do not.

## Renaming

```sh
coil lint --use aot.refactor.rename --lint-param "aot.rename.map=mask-test=has-reg?,mask-or=union"
coil lint --use aot.refactor.rename --lint-param "aot.rename.map=…" --lint-param aot.rename.apply=1
coil check
```

The tool refuses, by name, an old name with several definitions, an old name that is also bound
locally, and a new name that is already defined. It does NOT detect a new name that collides with a
local where the definition is called — `word` was the example: a method named `word` called inside
a function whose parameter is also `word`. The type checker reports exactly that as an error at the
call, so the rename is never silently wrong; pick a different name and rename again.

Short names are a cost, not only a benefit. `mask-test` cannot collide with anything and finds
itself in a search; `test` does neither. Drop a prefix when the receiver makes the meaning obvious
at the call site (`(union a b)` on two masks) and keep it otherwise.

## Methods

```sh
coil lint --use aot.refactor.methods \
  --lint-param aot.methods.module=aot.codegen.regmask --lint-param aot.methods.impl=RegMask \
  --lint-param "aot.methods.names=RegMask::new,has-reg?,union" --lint-param aot.methods.apply=1
coil fmt --write src/codegen/regmask.coil
coil check
```

Rename a receiverless constructor to `Type::name` FIRST: that is how it is called once it is a
method, so after the rename its call sites are already right.

See `docs/LAYOUT.md` §5 for when a family of functions should become an `impl`, and when it should
not.
