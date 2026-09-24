---
name: osnova
description: Use available osnova_* tools for code exploration, caller analysis, change impact, test discovery, and unused-code candidates.
---

# Osnova

Await graph results before dependent reads/searches. Reuse supplied source, relationships and tests; read only missing spans. Query again for a specific evidence gap.

- Start cross-file work with `osnova_footing`; use `osnova_ground` for definitions (`lean: true` for locations), `osnova_outline` for file shape.
- Fill gaps with `osnova_warp` (callers/callees), `osnova_thread` (text matches), or `osnova_tests` (test leads). Prefer `path/file.ext#Class.method`.
- Caller lists include direct test calls. Verify claims with `osnova_plumb` at the claimed depth; address missing sites. Forwarded parameters do not prove valid inputs or unchanged caller behavior.
- After edits, run relevant tests and `osnova_settle({"baseRef":"HEAD"})`; check dependents. This includes indexed untracked files. Inline `diff` only for supplied patches; another ref selects another baseline. Read-only work needs no settle.
- Before deleting `osnova_unreferenced` candidates, check unresolved leads, mentions and tests. Follow omissions when completeness matters. Structural evidence is not runtime/type proof; absence from the index is not proof of absence; test references are not coverage.

## Hook denials

Grants cover named files until edits/new prompts; await queries before using grants. Known test/config paths and operational commands need no discovery. Unindexed paths need no source grant. Repository ls/find/glob/directory reads are discovery; never retry denied discovery through another tool or interpreter, or edit/disable hooks to evade it.

Read the exact denial and follow its scoped guidance. Split mixed operational/source commands. If a permitted operation fails, report its exact command/reason and continue unblocked work. MCP reconnect does not repair a separate hook runtime.
