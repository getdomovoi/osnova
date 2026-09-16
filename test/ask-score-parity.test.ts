import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { askDetailed } from "../src/query/ask.js";
import { scopedAsk } from "../src/query/scoped.js";

const EXPECTED_ASK: Record<string, Array<[string, number]>> = {
  "retry timer": [
    ["src/app.ts#run.timer", 1.983204276559982],
    ["src/util.ts#RetryTimer", 0.987721934840439],
    ["src/util.ts#RetryTimer.tick", 0.9802560027150304],
    ["src/app.ts#describeRetry", 0.9746271018822708],
    ["src/util.ts#formatRetry", 0.9742055207610051],
    ["src/util.ts#RetryOptions", 0.9740007941046132],
    ["src/app.ts#run.computed", 0.9425660319431513],
    ["src/app.ts", 0.8574024407730798],
  ],
  "compute helper": [
    ["src/breadth/util.c#compute", 1.9790490952318653],
    ["src/util.ts#compute", 1.9786578093864584],
    ["src/breadth/greeter.rb#Util.helper", 1.968961522097514],
    ["src/breadth/util.c#helper", 1.9683480378574267],
    ["src/server.py#helper", 1.9681946925890048],
    ["src/util.ts#internalHelper", 0.9678315475690024],
    ["src/app.ts#run.computed", 0.9457173540823378],
    ["src/pyhelpers/__init__.py", 0.7433406770341315],
    ["src/pyrelative.py", 0.7433406770341315],
    ["src/app.ts", 0.7325290726336846],
    ["src/pyclient.py", 0.7248149818955774],
    ["src/pyhelpers/helper.py", 0.7023946763101125],
    ["src/pyhelpers/helper.py#double", 0.7023946763101125],
    ["src/pyclient.py#apply", 0.6943539815222006],
    ["src/server.py#main", 0.6514246214509662],
  ],
  "server start listen": [
    ["src/main.go#Server.Start", 1.986276407430495],
    ["src/server.py#Server.start", 1.984856146877827],
    ["src/App.java#App.start", 1.9756500115052433],
    ["src/Program.cs#Program.Start", 1.9755311484344258],
    ["src/server.py#Server", 1.9722027846032173],
    ["src/main.go#Server", 1.9694869667565305],
    ["src/server.py#Server._listen", 0.986689121503138],
    ["src/main.go#buildServer", 0.9701489832882134],
    ["src/server.py#Server.__init__", 0.9563966997921086],
    ["src/server.py#main", 0.8919017770471671],
    ["src/main.go#main", 0.8140334537744582],
    ["src/server.py", 0.7090584070810386],
    ["src/server.py#MAX_CONNECTIONS", 0.7090584070810386],
    ["src/server.py#helper", 0.7090584070810386],
  ],
  "greet format": [
    ["src/breadth/greeter.sh#greet", 1.971190065900319],
    ["src/breadth/greeter.ex#Greeter.greet", 1.9702388625874012],
    ["src/breadth/greeter.ml#Greeter.greet", 1.9702388625874012],
    ["src/breadth/Greeter.kt#Greeter.greet", 1.9697969417611023],
    ["src/breadth/Greeter.scala#Greeter.greet", 1.9697969417611023],
    ["src/breadth/Greeter.swift#Greeter.greet", 1.9696138700202122],
    ["src/breadth/greeter.php#Greeter.greet", 1.9694505946349437],
    ["src/breadth/greeter.zig#Greeter.greet", 1.9691718422759839],
    ["src/breadth/greeter.dart#Greeter.greet", 1.962398355446501],
    ["src/breadth/greeter.rb#Greeting.Greeter.greet", 1.962072984972004],
    ["src/breadth/greeter.sh#format", 1.9574569892593932],
    ["src/breadth/greeter.ex#Greeter.format", 1.9562381684110055],
    ["src/breadth/greeter.dart#Greeter.format", 1.956028818144071],
    ["src/breadth/greeter.ml#Greeter.format", 1.956028818144071],
    ["src/breadth/Greeter.kt#Greeter.format", 1.9558441300767098],
    ["src/breadth/Greeter.swift#Greeter.format", 1.9558441300767098],
    ["src/breadth/Greeter.scala#Greeter.format", 1.9556799886797496],
    ["src/breadth/greeter.php#Greeter.format", 1.9556799886797496],
    ["src/breadth/greeter.zig#Greeter.format", 1.9556799886797496],
    ["src/breadth/greeter.ex#Greeter.greet_safe", 0.9694505946349437],
    ["src/breadth/greeter.rb#Greeting.Greeter.format_name", 0.956028818144071],
    ["src/util.ts#formatRetry", 0.954683936337844],
    ["src/breadth/greeter.ml#run", 0.9045455726963959],
    ["src/breadth/Greeter.kt#run", 0.9030559036636835],
    ["src/breadth/Greeter.swift#run", 0.9017429093855673],
    ["src/breadth/greeter.php#run", 0.900576918909464],
    ["src/breadth/Greeter.scala#Runner.run", 0.8995345530315956],
    ["src/breadth/greeter.zig#run", 0.8995345530315956],
    ["src/breadth/Greeter.scala#Runner", 0.8809143484572417],
    ["src/breadth/greeter.dart#run", 0.6752072183536223],
    ["src/breadth/greeter.ex#Greeter.run", 0.6572884804131894],
    ["src/breadth/greeter.sh", 0.6572884804131894],
    ["src/breadth/greeter.rb#run", 0.6241603799511805],
    ["src/more.rs#with_display", 0.6021909921072099],
    ["src/app.ts", 0.5716927204575372],
    ["src/lib.rs#Config.describe", 0.5716927204575372],
    ["src/app.ts#describeRetry", 0.5313286058289471],
  ],
};

const EXPECTED_SCOPED: Array<[string, string, number]> = [
  ["", "src/app.ts#run.timer", 1.983204276559982],
  ["", "src/util.ts#RetryTimer", 0.987721934840439],
  ["", "src/util.ts#RetryTimer.tick", 0.9802560027150304],
  ["", "src/app.ts#describeRetry", 0.9746271018822708],
  ["", "src/util.ts#formatRetry", 0.9742055207610051],
  ["", "src/util.ts#RetryOptions", 0.9740007941046132],
  ["", "src/app.ts#run.computed", 0.9425660319431513],
  ["", "src/app.ts", 0.8574024407730798],
];

describe("ask score parity with pre-task-5 baseline (52a568b)", () => {
  it("reproduces askDetailed scores on the sample repo for pinned queries", async () => {
    const dir = path.join(import.meta.dirname, "fixtures", "sample-repo");
    const index = await buildIndex(dir);
    for (const [question, expected] of Object.entries(EXPECTED_ASK)) {
      const result = askDetailed(index, question, { limit: Number.MAX_SAFE_INTEGER });
      const actual = result.hits.map((hit) => [hit.symbol?.qualifiedName ?? hit.file, hit.score]);
      expect(actual, `askDetailed("${question}")`).toEqual(expected);
    }
  });

  it("reproduces scopedAsk scores on the sample repo's single root scope", async () => {
    const dir = path.join(import.meta.dirname, "fixtures", "sample-repo");
    const index = await buildIndex(dir);
    const result = scopedAsk(index, "retry timer", { limit: 8 });
    const actual = result.hits.map((hit) => [hit.scope, hit.symbol?.qualifiedName ?? hit.file, hit.score]);
    expect(actual).toEqual(EXPECTED_SCOPED);
  });
});
