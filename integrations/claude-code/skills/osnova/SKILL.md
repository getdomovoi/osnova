---
name: osnova
description: Use when the osnova_* tools are available and the task asks how code works, who calls a symbol, what a change affects, or whether a list of call sites is complete. Answers relationship questions from the indexed call graph instead of chains of grep and file reads; plain text search stays with rg.
---

# Osnova

The `osnova_*` tools are a deterministic call graph with exact `file:line` and no type inference; the tool list is in the server instructions. What they return was resolved from syntax; what they do not return is unknown, not absent. Edges are calls, references, imports, declared heritage and framework routes; `osnova_ground` answers a verb and path such as `GET /users` with the registration and its handler.

## Order of work

1. `osnova_footing` first (question or `symbols`, plus `task`); read source only where the excerpt is not enough.
2. `osnova_ground` when footing found no seed; narrow with `in`.
3. `osnova_warp` for every caller or callee: a `resolved` edge is a fact, an `unresolved` edge a lead whose `nameMatches` are candidates, not relationships.
4. `osnova_plumb` on every list of call sites before acting on it, at the `depth` the claim was made.
5. `osnova_tests` with `symbols` before editing to find the tests to run, or with `file` to see what one test reaches; a listed test is not coverage.
6. `osnova_unreferenced` (narrow with `scope`) when asked what may be unused; every row is a candidate to check by hand through its same-name leads, mentions and tests, never a deletion verdict.
7. `osnova_settle` with `git diff HEAD` before finishing; read or test each dependent.

## Rules

- Do not re-read what a tool quoted with `file:line`.
- No indexed callers is not proof of absence: reflection, dynamic dispatch and unindexed code are invisible. Say so when it matters.
- Prefer a qualified name (`path/file.ext#Class.method`) once known.
- Output is bounded and counts what was omitted; ask again with `in`, `limit` or a narrower symbol.
