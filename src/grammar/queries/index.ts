import { createHash } from "node:crypto";
import type { LanguageId } from "../../types.js";
import { c } from "./c.js";
import { cpp } from "./cpp.js";
import { objc } from "./objc.js";
import { ruby } from "./ruby.js";
import { php } from "./php.js";
import { kotlin } from "./kotlin.js";
import { swift } from "./swift.js";
import { scala } from "./scala.js";
import { dart } from "./dart.js";
import { elixir } from "./elixir.js";
import { ocaml } from "./ocaml.js";
import { zig } from "./zig.js";
import { bash } from "./bash.js";

const queries: Readonly<Partial<Record<LanguageId, string>>> = { c, cpp, objc, ruby, php, kotlin, swift, scala, dart, elixir, ocaml, zig, bash };

export function queryFor(language: LanguageId): string | undefined {
  return queries[language];
}

export const queriesFingerprint = createHash("sha256")
  .update((Object.keys(queries) as LanguageId[]).sort().map((language) => `${language}\n${queries[language] ?? ""}\n`).join(""))
  .digest("hex").slice(0, 16);
