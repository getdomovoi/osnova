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
// A line that calls one name more than once (`a.get(b.get())`) has one checker entry per call under one site key;
// each claimed edge there stands for at most one of those calls, paired so that as many claims as possible hold.
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export function scoreSites(oracle, claimed, { tolerance = 1 } = {}) {
  const key = (file, line, name) => `${file}:${line}:${name}`;
  // The decided checker entries at each site key, one per call.
  const byKey = new Map();
  for (const entry of oracle.entries) {
    if (entry.verdict === "undecided") continue;
    const k = key(entry.file, entry.line, entry.name);
    if (byKey.has(k)) byKey.get(k).push(entry);
    else byKey.set(k, [entry]);
  }
  const lookup = (file, line, name) => {
    for (let d = 0; d <= tolerance; d += 1) {
      for (const candidate of d === 0 ? [line] : [line - d, line + d]) {
        const k = key(file, candidate, name);
        if (byKey.has(k)) return k;
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
  // The claimed edges at each site key, in input order.
  const claimsAt = new Map();
  for (const site of claimed.sites) {
    if (site.line === undefined || site.line === null) { noLine += 1; undecided += 1; continue; }
    const k = lookup(site.callerFile, site.line, site.calleeName);
    if (k === undefined) { undecided += 1; continue; }
    if (claimsAt.has(k)) claimsAt.get(k).push(site);
    else claimsAt.set(k, [site]);
  }
  for (const [k, sites] of claimsAt) {
    const entries = byKey.get(k);
    // The calls each claim's target span holds, in call order, found by declaration file and line.
    const declared = new Map();
    entries.forEach((entry, call) => {
      if (entry.verdict !== "in-repo") return;
      for (const def of entry.defs) {
        if (!declared.has(def.file)) declared.set(def.file, []);
        declared.get(def.file).push([def.line, call]);
      }
    });
    for (const lines of declared.values()) lines.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const fits = sites.map((site) => {
      const lines = declared.get(site.targetFile);
      if (lines === undefined || site.targetStartLine === undefined || site.targetStartLine === null) return [];
      const end = site.targetEndLine ?? site.targetStartLine;
      let low = 0, high = lines.length;
      while (low < high) { const mid = (low + high) >> 1; if (lines[mid][0] < site.targetStartLine) low = mid + 1; else high = mid; }
      const calls = new Set();
      for (let at = low; at < lines.length && lines[at][0] <= end; at += 1) calls.add(lines[at][1]);
      return [...calls].sort((a, b) => a - b);
    });
    // Pair claims with those calls, as many as possible: a greedy pass, then an augmenting path for each claim left,
    // searched with an explicit stack so a line of thousands of calls cannot exhaust the call stack.
    const pairedTo = new Array(entries.length).fill(-1);
    const paired = new Set();
    sites.forEach((_, claim) => {
      const free = fits[claim].find((call) => pairedTo[call] === -1);
      if (free !== undefined) { pairedTo[free] = claim; paired.add(claim); }
    });
    for (let start = 0; start < sites.length; start += 1) {
      if (paired.has(start)) continue;
      const seen = new Set();
      // Each frame is a claim, the next of its calls to try, and the call its parent frame reached it through.
      const stack = [{ claim: start, next: 0, via: -1 }];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.next >= fits[frame.claim].length) { stack.pop(); continue; }
        const call = fits[frame.claim][frame.next++];
        if (seen.has(call)) continue;
        seen.add(call);
        if (pairedTo[call] !== -1) { stack.push({ claim: pairedTo[call], next: 0, via: call }); continue; }
        // A free call ends the path: each claim on it takes the call that leads to the next one.
        pairedTo[call] = frame.claim;
        for (let at = stack.length - 1; at > 0; at -= 1) pairedTo[stack[at].via] = stack[at - 1].claim;
        paired.add(start);
        break;
      }
    }
    sites.forEach((site, claim) => {
      if (paired.has(claim)) {
        truePositive += 1;
        covered.add(k);
        if (toolFiles.has(entries[0].file)) coveredInToolFiles.add(k);
        return;
      }
      falsePositive += 1;
      if (falseSamples.length < 40) falseSamples.push({
        site: `${site.callerFile}:${site.line} ${site.calleeName}`,
        claimedTarget: `${site.targetFile}#${site.targetName} (${site.targetStartLine}-${site.targetEndLine})`,
        oracleVerdict: [...new Set(entries.map((entry) => entry.verdict))].join("|"),
        oracleDefs: entries.flatMap((entry) => entry.defs.map((d) => `${d.file}:${d.line}`)),
      });
    });
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
