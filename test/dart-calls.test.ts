import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import type { OsnovaIndex } from "../src/types.js";

const SOURCE = `int helper(int x) => x + 1;

class Greeter {
  String name;
  Greeter(this.name);
  String greet() {
    return format(name);
  }
  String format(String value) => value.toUpperCase();
  void run() {
    helper(2);
    this.greet();
    list?.add(3);
    Greeter.make();
    new Greeter("b");
  }
}

void main() {
  final g = Greeter("a");
  print(helper(3));
  g.greet().trim();
}
`;

let root: string;
let index: OsnovaIndex;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-dart-"));
  fs.writeFileSync(path.join(root, "greeter.dart"), SOURCE);
  index = await buildIndex(root, { cacheDir: path.join(root, ".cache") });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const calls = (from: string): string[] => index.outgoing(`greeter.dart#${from}`).filter((edge) => edge.kind === "calls").map((edge) => `${edge.toName}:${edge.line}`).sort();

describe("dart call edges", () => {
  it("records bare, member, constructor and nested calls, each from the function whose body holds it", () => {
    expect(calls("Greeter.greet")).toEqual(["format:7"]);
    expect(calls("Greeter.format")).toEqual(["toUpperCase:9"]);
    expect(calls("Greeter.run")).toEqual(["Greeter:15", "add:13", "greet:12", "helper:11", "make:14"]);
    expect(calls("main")).toEqual(["Greeter:20", "greet:22", "helper:21", "print:21", "trim:22"]);
  });

  it("keeps the definitions it already extracted", () => {
    const symbols = (index.files.get("greeter.dart")?.symbols ?? []).map((symbol) => `${symbol.kind}:${symbol.qualifiedName}`);
    expect(symbols).toEqual([
      "function:greeter.dart#helper",
      "class:greeter.dart#Greeter",
      "method:greeter.dart#Greeter.greet",
      "method:greeter.dart#Greeter.format",
      "method:greeter.dart#Greeter.run",
      "function:greeter.dart#main",
    ]);
  });
});
