import { execFileSync } from "node:child_process";

// extractionVersion is the only thing that stops a cache written by one build of the extractor from
// being read by another. Its query half is a content hash and moves by itself; the rest is typed by
// hand, so an extraction change that forgets the bump serves stale cached answers whose hashes all
// still verify. This fails a change set that touches extraction inputs without moving the version.
//
// Usage: node scripts/extraction-version-guard.mjs <base-ref>

const base = process.argv[2];
if (base === undefined || base.length === 0) {
  process.stderr.write("usage: node scripts/extraction-version-guard.mjs <base-ref>\n");
  process.exit(2);
}

const git = (args) => execFileSync("git", args, { encoding: "utf8" });
const versionFile = "src/index/serialize.ts";

// The grammar queries are excluded: queriesFingerprint already hashes their text into the version.
const extractionInput = (file) =>
  (file.startsWith("src/extract/") || file.startsWith("src/grammar/") || file === "src/index/scan.ts") &&
  !file.startsWith("src/grammar/queries/");

function versionAt(commit) {
  const source = git(["show", `${commit}:${versionFile}`]);
  const line = source.split("\n").find((text) => text.startsWith("export const extractionVersion ="));
  if (line === undefined) throw new Error(`osnova: no extractionVersion line in ${versionFile} at ${commit}`);
  return line;
}

const mergeBase = git(["merge-base", base, "HEAD"]).trim();
const changed = git(["diff", "--name-only", mergeBase, "HEAD"]).split("\n").filter(Boolean);
const inputs = changed.filter(extractionInput);

if (inputs.length === 0) {
  process.stdout.write("osnova: no extraction input changed; extractionVersion may stay\n");
  process.exit(0);
}
if (versionAt(mergeBase) !== versionAt("HEAD")) {
  process.stdout.write(`osnova: ${inputs.length} extraction input(s) changed and extractionVersion moved\n`);
  process.exit(0);
}
process.stderr.write(
  `osnova: extraction inputs changed but extractionVersion is unchanged in ${versionFile}:\n` +
  inputs.map((file) => `  ${file}\n`).join("") +
  "Bump the structural or scan part of extractionVersion so caches written by the previous extractor are rebuilt.\n",
);
process.exit(1);
