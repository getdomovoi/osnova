import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { askDetailed } from "../src/query/ask.js";
import { scopedAsk } from "../src/query/scoped.js";

const EXPECTED_ASK: Record<string, Array<[string, number]>> = {
  "retry timer": [
    ["src/util.ts#RetryTimer", 0.9877463886665317],
    ["src/app.ts#run.timer", 0.9832357285767304],
    ["src/util.ts#RetryTimer.tick", 0.9802993722720452],
    ["src/app.ts#describeRetry", 0.9746791039978703],
    ["src/util.ts#formatRetry", 0.9742583715028299],
    ["src/util.ts#RetryOptions", 0.9740547746626992],
    ["src/app.ts#run.computed", 0.9426513211957197],
    ["src/app.ts", 0.8572910392413851],
  ],
  "compute helper": [
    ["src/breadth/util.c#compute", 0.9790836633188321],
    ["src/util.ts#compute", 0.978692810039862],
    ["src/breadth/greeter.rb#Util.helper", 0.9690446927165675],
    ["src/breadth/util.c#helper", 0.9684314052250558],
    ["src/server.py#helper", 0.9682783106392107],
    ["src/util.ts#internalHelper", 0.9679160800592387],
    ["src/app.ts#run.computed", 0.9457918840559574],
    ["src/pyhelpers/__init__.py", 0.7435341602485056],
    ["src/pyrelative.py", 0.7435341602485056],
    ["src/app.ts", 0.7321904743367031],
    ["src/pyclient.py", 0.7248186712000704],
    ["src/pyhelpers/helper.py", 0.7030106065001417],
    ["src/pyhelpers/helper.py#double", 0.7030106065001417],
    ["src/pyclient.py#apply", 0.6943361764032263],
    ["src/server.py#main", 0.6512447737845914],
  ],
  "server start listen": [
    ["src/server.py#Server._listen", 0.9867139877861179],
    ["src/main.go#Server.Start", 0.9863071770978091],
    ["src/server.py#Server.start", 0.9848874643119937],
    ["src/App.java#App.start", 0.9756981228886081],
    ["src/Program.cs#Program.Start", 0.9755793802183609],
    ["src/server.py#Server", 0.9722762443811912],
    ["src/main.go#buildServer", 0.9702248074847255],
    ["src/main.go#Server", 0.9695649363735673],
    ["src/server.py#Server.__init__", 0.9565156170916116],
    ["src/server.py#main", 0.8919673456899592],
    ["src/main.go#main", 0.8138483564488753],
    ["src/server.py", 0.7096470905642535],
    ["src/server.py#MAX_CONNECTIONS", 0.7096470905642535],
    ["src/server.py#helper", 0.7096470905642535],
  ],
  "greet format": [
    ["src/breadth/greeter.sh#greet", 0.9712922297864913],
    ["src/breadth/greeter.ex#Greeter.greet", 0.9703412045750285],
    ["src/breadth/greeter.ml#Greeter.greet", 0.9703412045750285],
    ["src/breadth/Greeter.kt#Greeter.greet", 0.9699001392245704],
    ["src/breadth/Greeter.scala#Greeter.greet", 0.9699001392245704],
    ["src/breadth/Greeter.swift#Greeter.greet", 0.9697175652040453],
    ["src/breadth/greeter.ex#Greeter.greet_safe", 0.9695548044864226],
    ["src/breadth/greeter.php#Greeter.greet", 0.9695548044864226],
    ["src/breadth/greeter.zig#Greeter.greet", 0.9692770848701485],
    ["src/breadth/greeter.dart#Greeter.greet", 0.9625205366169646],
    ["src/breadth/greeter.rb#Greeting.Greeter.greet", 0.9621957763189847],
    ["src/breadth/greeter.sh#format", 0.9576188898015355],
    ["src/breadth/greeter.ex#Greeter.format", 0.9564011068069685],
    ["src/breadth/greeter.dart#Greeter.format", 0.9561923094058379],
    ["src/breadth/greeter.ml#Greeter.format", 0.9561923094058379],
    ["src/breadth/greeter.rb#Greeting.Greeter.format_name", 0.9561923094058379],
    ["src/breadth/Greeter.kt#Greeter.format", 0.9560082000684633],
    ["src/breadth/Greeter.swift#Greeter.format", 0.9560082000684633],
    ["src/breadth/Greeter.scala#Greeter.format", 0.9558446445594574],
    ["src/breadth/greeter.php#Greeter.format", 0.9558446445594574],
    ["src/breadth/greeter.zig#Greeter.format", 0.9558446445594574],
    ["src/util.ts#formatRetry", 0.9548535890249247],
    ["src/breadth/greeter.ml#run", 0.9048252608208164],
    ["src/breadth/Greeter.kt#run", 0.9033357875071185],
    ["src/breadth/Greeter.swift#run", 0.9020237512879484],
    ["src/breadth/greeter.php#run", 0.9008592281186193],
    ["src/breadth/Greeter.scala#Runner.run", 0.8998186645854267],
    ["src/breadth/greeter.zig#run", 0.8998186645854267],
    ["src/breadth/Greeter.scala#Runner", 0.8813083423411502],
    ["src/breadth/greeter.dart#run", 0.6755140669989608],
    ["src/breadth/greeter.ex#Greeter.run", 0.6575223145054023],
    ["src/breadth/greeter.sh", 0.6575223145054023],
    ["src/breadth/greeter.rb#run", 0.6242685713940925],
    ["src/more.rs#with_display", 0.6023887463272426],
    ["src/app.ts", 0.5717870500465069],
    ["src/lib.rs#Config.describe", 0.5717870500465069],
    ["src/app.ts#describeRetry", 0.5313014213812286],
  ],
};

const EXPECTED_SCOPED: Array<[string, string, number]> = [
  ["", "src/util.ts#RetryTimer", 0.9877463886665317],
  ["", "src/app.ts#run.timer", 0.9832357285767304],
  ["", "src/util.ts#RetryTimer.tick", 0.9802993722720452],
  ["", "src/app.ts#describeRetry", 0.9746791039978703],
  ["", "src/util.ts#formatRetry", 0.9742583715028299],
  ["", "src/util.ts#RetryOptions", 0.9740547746626992],
  ["", "src/app.ts#run.computed", 0.9426513211957197],
  ["", "src/app.ts", 0.8572910392413851],
];

describe("ask score parity with the identifier-tier baseline", () => {
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
