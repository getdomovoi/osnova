// Scores claimed call edges against a type-checker truth set, at call-site granularity, so how the caller is named
// cannot change the result. The claimed-sites input format is described in README.md.
//
// Verdicts per claimed edge:
//   true       the checker resolves the site inside the repository and the claimed target span holds one of its
//              declaration lines
//   false      the checker decided the site (inside or outside the repository) and no declaration falls in the span
//   undecided  the checker gave no verdict for the site, or did not enumerate it
// Recall is over the checker's in-repository sites: a site is covered when some claimed edge at it is true.
// `tolerance` lets a claimed call line sit up to that many lines from the checker's line for the same callee name.
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export function scoreSites(oracle, claimed, { tolerance = 1 } = {}) {
  const key = (file, line, name) => `${file}:${line}:${name}`;
  const byKey = new Map();
  for (const entry of oracle.entries) {
    if (entry.verdict === "undecided") continue;
    const k = key(entry.file, entry.line, entry.name);
    if (!byKey.has(k)) byKey.set(k, entry);
  }
  const lookup = (file, line, name) => {
    for (let d = 0; d <= tolerance; d += 1) {
      for (const candidate of d === 0 ? [line] : [line - d, line + d]) {
        const hit = byKey.get(key(file, candidate, name));
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const truth = new Set();
  for (const entry of oracle.entries) if (entry.verdict === "in-repo") truth.add(key(entry.file, entry.line, entry.name));
  const toolFiles = new Set(claimed.sites.map((s) => s.callerFile));
  let truthInToolFiles = 0;
  for (const entry of oracle.entries) if (entry.verdict === "in-repo" && toolFiles.has(entry.file)) truthInToolFiles += 1;
  const covered = new Set(), coveredInToolFiles = new Set();
  let truePositive = 0, falsePositive = 0, undecided = 0, noLine = 0;
  const falseSamples = [];
  for (const site of claimed.sites) {
    if (site.line === undefined || site.line === null) { noLine += 1; undecided += 1; continue; }
    const entry = lookup(site.callerFile, site.line, site.calleeName);
    if (entry === undefined) { undecided += 1; continue; }
    const hit = entry.verdict === "in-repo" && entry.defs.some((def) =>
      def.file === site.targetFile && site.targetStartLine !== undefined && site.targetStartLine !== null &&
      def.line >= site.targetStartLine && def.line <= (site.targetEndLine ?? site.targetStartLine));
    if (hit) {
      truePositive += 1;
      const k = key(entry.file, entry.line, entry.name);
      covered.add(k);
      if (toolFiles.has(entry.file)) coveredInToolFiles.add(k);
    } else {
      falsePositive += 1;
      if (falseSamples.length < 40) falseSamples.push({
        site: `${site.callerFile}:${site.line} ${site.calleeName}`,
        claimedTarget: `${site.targetFile}#${site.targetName} (${site.targetStartLine}-${site.targetEndLine})`,
        oracleVerdict: entry.verdict, oracleDefs: entry.defs.map((d) => `${d.file}:${d.line}`),
      });
    }
  }
  const decided = truePositive + falsePositive;
  return {
    oracle: oracle.oracle, oracleVersion: oracle.oracleVersion ?? null, lineTolerance: tolerance,
    claimedEdges: claimed.sites.length, decided, undecided, claimedEdgesWithoutLine: noLine, truePositive, falsePositive,
    precision: decided > 0 ? truePositive / decided : null, falseEdgeRate: decided > 0 ? falsePositive / decided : null,
    oracleInRepoSites: truth.size, coveredInRepoSites: covered.size, recall: truth.size > 0 ? covered.size / truth.size : null,
    oracleInRepoSitesInToolFiles: truthInToolFiles,
    recallWithinIndexedFiles: truthInToolFiles > 0 ? coveredInToolFiles.size / truthInToolFiles : null,
    falseSamples,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { oracle: { type: "string" }, sites: { type: "string" }, output: { type: "string" }, tolerance: { type: "string", default: "1" } } });
  const report = scoreSites(JSON.parse(await fs.readFile(values.oracle, "utf8")), JSON.parse(await fs.readFile(values.sites, "utf8")), { tolerance: Number(values.tolerance) });
  if (values.output) await fs.writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  const { falseSamples: _drop, ...summary } = report;
  console.log(JSON.stringify(summary));
}
