import { readFileSync } from "node:fs";

const banned = [
  /^co-authored-by:/im,
  /^claude-session:/im,
  /^signed-off-by:.*\b(claude|codex|kilo|copilot)\b/im,
  /generated with\b/i,
  /claude\.ai\/code/i,
  /\bsession_01[a-z0-9]{20,}/i,
  /\u{1F916}/u,
];

const file = process.argv[2];
if (!file) {
  process.stderr.write("commit-msg guard: no message file given\n");
  process.exit(2);
}
const message = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .join("\n");
const hit = banned.find((pattern) => pattern.test(message));
if (hit) {
  process.stderr.write(
    `commit-msg guard: message contains an attribution trailer or session link (${hit}); remove it and retry\n`,
  );
  process.exit(1);
}
