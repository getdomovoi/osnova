import { createHash } from "node:crypto";

// SHA-256 of every earlier shipped version of each integration file setup installs, line endings normalized to LF.
// An installed file that matches one was written by an earlier osnova and never edited, so setup may replace it
// with the current one; any other differing file was edited by its owner and is kept. When a shipped file changes,
// add the hash of its previous version here; test/shipped-history.test.ts checks this list against git history.
export const earlierShippedFiles: Readonly<Record<string, readonly string[]>> = {
  "claude-code/skills/osnova/SKILL.md": [
    "06f8dc9530af8210b6cdb0d9c7ecbf8cfe8ea570f3c2804c2d0c1c5edd862ffc",
    "0b34d44062d5b188e2caea3966cbe619720c3e7d6df5b299eaf4e1ae91a65424",
    "7eda4162239b5686839943cb930137f65367309f92e31641d00f89704f31ce78",
    "b92841331dcfd292d685d42d1dcc7fd9deaba9d5f44ba5e255a1f8aaebe15b00",
    "c858f28f9e482a712c775022c3fde6e2c5b954d20c37302d6e778413f4d63786",
    "f72d5b41e4ab74304b8a102fe456218889a7995b525935e643694eb37faa77a2",
  ],
  "opencode/osnova.js": [
    "3b7c0e8328724ddc15fa2eb8f0dd7c7f5ecea86078afc7865ca02afdea40d69f",
    "3de2315a24a369f2d3fec228678c475f9d8f69607d8567af0cf8caa32e99b6a3",
    "49cf61cf5a3cf43baf195c0291928bdc571ef376d3eeda9494c83736cd05a176",
    "4f76dfbf2e6796e37d4653306818be9cb038623c4c5fe32fc6dbaff41d208a99",
    "a8cb60bfab19660f8702b0b2a49efc97987ea649d0129859e986180459b8ef8b",
    "c21fa9404e52b977119d729dbdb5da86472a4f92513ec6179986d703146a08eb",
    "fb8e34f467d62abedf93483483b38c4358cb559c0e6115ea616d60c5c3c3428c",
  ],
  "opencode/osnova-gate.js": [],
  "pi/osnova.ts": [
    "243885bbea5f8724ad8402c9fd197396deb445e530a1f4fc8f5ad4205055a185",
    "67c234d485f1d07acdbc18332234066f5c866afa7bcce49a0b09720401f1ceea",
    "6827db12b743b503c7eb1778833670cf8446c2f331100d9c22804a3591c30f23",
    "8ef82d9342fcc0a511cfe003093161eba362fda68d5560c74bd54350cb782bec",
    "e386c7803cf0e15f596761f5e77ea4aae764448e3afbe15a2b38518c88c917b8",
  ],
  "pi/osnova-gate.ts": [
    "7bb635a4f88df7df4907f4432970bd95aa2cf1915172eb0eedec59b67a9bc9d1",
  ],
};

export function shippedHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

export function isEarlierShipped(file: string, text: string): boolean {
  return earlierShippedFiles[file]?.includes(shippedHash(text)) === true;
}
