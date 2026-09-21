import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { askDetailed } from "../src/query/ask.js";
import { scopedAsk } from "../src/query/scoped.js";

const EXPECTED_ASK: Record<string, Array<[string, number]>> = {
  "retry timer": [
    ["src/util.ts#RetryTimer", 0.9880696286761012],
    ["src/app.ts#run.timer", 0.9836742632258907],
    ["src/util.ts#RetryTimer.tick", 0.9807841922022621],
    ["src/app.ts#describeRetry", 0.9753756465635778],
    ["src/util.ts#formatRetry", 0.9749663720165747],
    ["src/util.ts#RetryOptions", 0.9747630617599387],
    ["src/app.ts#run.computed", 0.9441629058598844],
    ["src/app.ts", 0.8631525039829328],
  ],
  "compute helper": [
    ["src/breadth/util.c#compute", 0.9795572066224549],
    ["src/util.ts#compute", 0.979182219472187],
    ["src/breadth/greeter.rb#Util.helper", 0.9683304528130943],
    ["src/breadth/greeter.m#helper", 0.9678910979333452],
    ["src/breadth/util.c#helper", 0.9677142102358448],
    ["src/server.py#helper", 0.9675588920483813],
    ["src/util.ts#internalHelper", 0.9671890024577344],
    ["src/app.ts#run.computed", 0.9471559743281041],
    ["src/app.ts", 0.741895976346004],
    ["src/pyhelpers/__init__.py", 0.7414606581112945],
    ["src/pyrelative.py", 0.7414606581112945],
    ["src/pyclient.py", 0.7241072045058455],
    ["src/pyhelpers/helper.py", 0.6977953551631473],
    ["src/pyhelpers/helper.py#double", 0.6977953551631473],
    ["src/pyclient.py#apply", 0.693738838194479],
    ["src/server.py#main", 0.6517884897930052],
    ["src/breadth/greeter.m#run", 0.6265309618521704],
  ],
  "server start listen": [
    ["src/server.py#Server._listen", 0.9870314401829458],
    ["src/main.go#Server.Start", 0.9867087706585241],
    ["src/server.py#Server.start", 0.9853254489819739],
    ["src/App.java#App.start", 0.9763338116890975],
    ["src/Program.cs#Program.Start", 0.9762189410502377],
    ["src/server.py#Server", 0.9731571170403427],
    ["src/main.go#buildServer", 0.9711895705231898],
    ["src/main.go#Server", 0.9705468901799817],
    ["src/server.py#Server.__init__", 0.9578364113133763],
    ["src/server.py#main", 0.8962067709924143],
    ["src/main.go#main", 0.8221434166511853],
    ["src/server.py", 0.7162418105214599],
    ["src/server.py#MAX_CONNECTIONS", 0.7162418105214599],
    ["src/server.py#helper", 0.7162418105214599],
  ],
  "greet format": [
    ["src/breadth/greeter.sh#greet", 0.9707040037757363],
    ["src/breadth/greeter.ex#Greeter.greet", 0.969755225045429],
    ["src/breadth/greeter.ml#Greeter.greet", 0.969755225045429],
    ["src/breadth/Greeter.kt#Greeter.greet", 0.9693094930568448],
    ["src/breadth/Greeter.scala#Greeter.greet", 0.9693094930568448],
    ["src/breadth/Greeter.swift#Greeter.greet", 0.9691239131908415],
    ["src/breadth/greeter.ex#Greeter.greet_safe", 0.9689579386809646],
    ["src/breadth/greeter.php#Greeter.greet", 0.9689579386809646],
    ["src/breadth/greeter.zig#Greeter.greet", 0.9686735660315786],
    ["src/breadth/greeter.dart#Greeter.greet", 0.9617514495254277],
    ["src/breadth/greeter.rb#Greeting.Greeter.greet", 0.9614219891195951],
    ["src/breadth/greeter.m#Greeter.greet", 0.9600361392861196],
    ["src/breadth/greeter.sh#format", 0.9569993722081227],
    ["src/breadth/greeter.ex#Greeter.format", 0.9557902434045947],
    ["src/breadth/greeter.dart#Greeter.format", 0.9555801953058336],
    ["src/breadth/greeter.ml#Greeter.format", 0.9555801953058336],
    ["src/breadth/greeter.rb#Greeting.Greeter.format_name", 0.9555801953058336],
    ["src/breadth/Greeter.kt#Greeter.format", 0.9553943091587568],
    ["src/breadth/Greeter.swift#Greeter.format", 0.9553943091587568],
    ["src/breadth/greeter.m#Greeter.formatName", 0.9553017033710672],
    ["src/breadth/Greeter.scala#Greeter.format", 0.9552286426615052],
    ["src/breadth/greeter.php#Greeter.format", 0.9552286426615052],
    ["src/breadth/greeter.zig#Greeter.format", 0.9552286426615052],
    ["src/util.ts#formatRetry", 0.9542139447205],
    ["src/breadth/greeter.ml#run", 0.9030162064729541],
    ["src/breadth/Greeter.kt#run", 0.9015297495048197],
    ["src/breadth/Greeter.swift#run", 0.9002146252648353],
    ["src/breadth/greeter.php#run", 0.8990428255460742],
    ["src/breadth/Greeter.scala#Runner.run", 0.8979921314434903],
    ["src/breadth/greeter.zig#run", 0.8979921314434903],
    ["src/breadth/Greeter.scala#Runner", 0.8787101094793014],
    ["src/breadth/greeter.dart#run", 0.6738730782251678],
    ["src/breadth/greeter.ex#Greeter.run", 0.6564330932250373],
    ["src/breadth/greeter.sh", 0.6564330932250373],
    ["src/breadth/greeter.rb#run", 0.6241279530126662],
    ["src/more.rs#with_display", 0.6042569080816201],
    ["src/app.ts", 0.5744897899421121],
    ["src/lib.rs#Config.describe", 0.5744897899421121],
    ["src/breadth/greeter.m#run", 0.5682019386580082],
    ["src/breadth/greeter.m", 0.5411984474801765],
    ["src/app.ts#describeRetry", 0.5349597262594331],
  ],
};

const EXPECTED_SCOPED: Array<[string, string, number]> = [
  ["", "src/util.ts#RetryTimer", 0.9880696286761012],
  ["", "src/app.ts#run.timer", 0.9836742632258907],
  ["", "src/util.ts#RetryTimer.tick", 0.9807841922022621],
  ["", "src/app.ts#describeRetry", 0.9753756465635778],
  ["", "src/util.ts#formatRetry", 0.9749663720165747],
  ["", "src/util.ts#RetryOptions", 0.9747630617599387],
  ["", "src/app.ts#run.computed", 0.9441629058598844],
  ["", "src/app.ts", 0.8631525039829328],
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
