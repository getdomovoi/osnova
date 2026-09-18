---
name: osnova
description: Use when the osnova_* tools are available and the task asks how code works, who calls a symbol, what a change affects, or whether a list of call sites is complete. Puts the indexed call graph before grep and file reads.
---

# Osnova

Osnova is a deterministic call graph of this repository with exact `file:line`: no type inference, no model. Every relationship it returns was resolved from syntax and carries its basis. It never guesses, so what it does not return is unknown, not absent.

## Order of work

1. **Start with `osnova_footing`.** Pass the question, or `symbols` when the task names them, and `task` (`understand`, `change` or `review`). It returns the definitions, callers and candidate tests around the seeds. Read those lines in the source only when the excerpt is not enough.
2. **Locate with `osnova_ground`** when footing found no seed: symbol and text search ranked by definition evidence. Narrow with `in`.
3. **Enumerate with `osnova_warp`** for every caller or callee of one symbol (`direction`, `depth`). Treat each `resolved` edge as a fact with a stated basis. Treat each `unresolved` edge as a lead: its `nameMatches` are candidates to read, not relationships.
4. **Check every list of call sites with `osnova_plumb`** before you act on it, whether you wrote it, a text search produced it, or a comment claims it. Pass the same `depth` the claim was made at.
5. **Before you finish a change, run `osnova_settle`** with the unified diff (`git diff HEAD`). It lists the indexed dependents of every changed symbol. Read or test each one the change could break.

## Rules

- Do not re-read a file to confirm what a tool already quoted with `file:line`. The line numbers are exact for the indexed revision.
- `osnova_outline` replaces reading a whole file to learn its shape; `osnova_thread` replaces recursive grep when every occurrence matters, grouped by enclosing symbol.
- "No indexed callers" is not proof of absence. Reflection, dynamic dispatch, string-built names and code outside the index are invisible to it. Say so when it matters.
- Prefer a qualified name (`path/file.ext#Class.method`) over a bare name once you know it; bare names can be ambiguous, and the tool then lists the candidates instead of choosing one.
- The output is bounded and says how much was omitted. Ask again with `in`, `limit` or a narrower symbol rather than assuming the rest is empty.
