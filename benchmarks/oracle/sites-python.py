"""Enumerate every Python call site in a corpus for truth-python.mjs.

For each ast.Call the callee identifier is located (Name -> itself, Attribute -> the attribute
name token) and emitted with a 0-based line/character position suitable for LSP. Attribute
positions are recovered by scanning the source line for the attribute name after the value's
end, because ast does not record the attribute token position. Columns are converted to UTF-16 code units, which
is what LSP positions count; ast reports UTF-8 byte offsets.
usage: python3 sites-python.py <checkout> <sites.json>
"""
import ast
import json
import os
import sys

root = sys.argv[1]
out = sys.argv[2]

sites = []
files = 0
unparsed = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "node_modules"]
    for name in sorted(filenames):
        if not name.endswith(".py"):
            continue
        full = os.path.join(dirpath, name)
        relative = os.path.relpath(full, root)
        try:
            source = open(full, "r", encoding="utf-8").read()
            tree = ast.parse(source)
        except Exception as exc:  # noqa: BLE001
            unparsed.append({"file": relative, "error": str(exc)})
            continue
        files += 1
        lines = source.split("\n")

        def utf16(line_number, byte_offset):
            text = lines[line_number - 1].encode("utf-8")[:byte_offset].decode("utf-8", "replace")
            return len(text.encode("utf-16-le")) // 2
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if isinstance(func, ast.Name):
                sites.append({"file": relative, "line": func.lineno, "character": utf16(func.lineno, func.col_offset), "name": func.id})
            elif isinstance(func, ast.Attribute):
                start_line = getattr(func.value, "end_lineno", func.lineno)
                start_col = getattr(func.value, "end_col_offset", func.col_offset)
                found = None
                for offset in range(0, 4):
                    index = start_line - 1 + offset
                    if index >= len(lines):
                        break
                    text = lines[index]
                    search_from = start_col if offset == 0 else 0
                    position = text.find(func.attr, len(text.encode("utf-8")[:search_from].decode("utf-8", "replace")) if offset == 0 else 0)
                    if position >= 0:
                        found = (index + 1, len(text[:position].encode("utf-16-le")) // 2)
                        break
                if found is not None:
                    sites.append({"file": relative, "line": found[0], "character": found[1], "name": func.attr})

json.dump({"files": files, "sites": sites, "unparsed": unparsed}, open(out, "w"))
print(json.dumps({"files": files, "sites": len(sites), "unparsed": len(unparsed)}))
