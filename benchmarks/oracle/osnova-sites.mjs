// Writes Osnova's resolved call edges in the claimed-sites format that score.mjs reads (see README.md).
// usage: node benchmarks/oracle/osnova-sites.mjs --workspace <checkout> --output <sites.json> [--cache-dir <dir>]
// Run `pnpm build` first; the script loads the built package from dist/.
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

export function claimedSites(index) {
  // One claim per resolved call edge: two calls to the same function on one line are two claims, as they are two edges.
  const sites = [];
  for (const edge of index.edges) {
    if (edge.kind !== "calls" || edge.toSymbol === undefined) continue;
    const target = index.symbols.get(edge.toSymbol);
    if (target === undefined) continue;
    const resolution = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined;
    sites.push({
      callerFile: edge.fromFile, line: edge.line, calleeName: edge.toName,
      targetFile: target.file, targetName: target.name, targetStartLine: target.span.startLine, targetEndLine: target.span.endLine,
      basis: resolution?.status === "resolved" ? resolution.method : null,
    });
  }
  // Ordinal comparison, so the order does not depend on the machine's locale.
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  sites.sort((a, b) => cmp(a.callerFile, b.callerFile) || a.line - b.line || cmp(a.calleeName ?? "", b.calleeName ?? "") || cmp(a.targetFile, b.targetFile) || a.targetStartLine - b.targetStartLine);
  return { tool: "osnova", sites };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { workspace: { type: "string" }, output: { type: "string" }, "cache-dir": { type: "string" } } });
  if (!values.workspace || !values.output) throw new Error("usage: osnova-sites.mjs --workspace <checkout> --output <sites.json> [--cache-dir <dir>]");
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");
  const { buildIndex, OSNOVA_VERSION } = await import(pathToFileURL(dist).href);
  const index = await buildIndex(path.resolve(values.workspace), values["cache-dir"] ? { cacheDir: values["cache-dir"] } : {});
  const result = { ...claimedSites(index), toolVersion: OSNOVA_VERSION };
  await fs.writeFile(values.output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ tool: "osnova", toolVersion: result.toolVersion, sites: result.sites.length }));
}
