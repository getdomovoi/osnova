import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChanges, ask, buildIndex, resolutionCoverage } from "../src/index.js";
import { serializeArtifact, serializeSections } from "../src/index/serialize.js";
import { serializeEdges, deserializeEdges } from "../src/index/edgeStore.js";
import { formatCallersDetailed } from "../src/query/format.js";
import { callersDetailed } from "../src/query/callers.js";
import type { OsnovaIndex } from "../src/types.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-routes-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
});

afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function write(files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), text);
  }
}

const rows = (index: OsnovaIndex, file: string): string[] =>
  index.edges.filter((edge) => edge.kind === "routes" && edge.fromFile === file).map((edge) => {
    const resolution = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined;
    const basis = resolution?.status === "resolved" ? resolution.method : resolution?.status === "unresolved" ? `unresolved:${resolution.reason}` : String(resolution?.status);
    return `${edge.line}:${edge.route?.method} ${edge.route?.path ?? "(computed)"} -> ${edge.toName}=${edge.toSymbol ?? "-"}[${basis}]`;
  });

const expressApp = [
  'import express, { Router } from "express";',
  'import { listUsers } from "./users.js";',
  "export function handler(req: unknown, res: unknown): void { console.log(req, res); }",
  "export function wrap(fn: unknown): unknown { return fn; }",
  "export function other(): void {}",
  "export class Ctrl { list(): void {} static ping(): void {} }",
  "const ctrl = new Ctrl();",
  'const PREFIX = "/dyn";',
  "const app = express();",
  "const router = express.Router();",
  "const r2 = Router();",
  'app.get("/users", handler);',
  'app.get("/imported", listUsers);',
  'app.post("/users", (req, res) => { other(); });',
  'app.put("/wrapped", wrap(handler));',
  "app.delete(`/tpl/${PREFIX}`, handler);",
  "app.get(PREFIX, handler);",
  'app.all("/member", ctrl.list);',
  'app.get("/static", Ctrl.ping);',
  'app.use("/api", router);',
  "app.use(handler);",
  'app.get("view engine");',
  'router.get("/r", handler);',
  'r2.post("/r2", handler);',
  "const notApp = new Map<string, string>();",
  'notApp.get("/fake");',
  "export function build(): void { const router = Router(); app.use(\"/inner\", router); }",
  "app.use(wrap(handler), handler);",
  `app.get("/${"x".repeat(2100)}", handler);`,
  "",
].join("\n");

const nestController = [
  'import { Controller, Get, Post } from "@nestjs/common";',
  '@Controller("cats")',
  "export class CatsController {",
  "  @Get()",
  '  findAll(): string { return "x"; }',
  '  @Post(":id")',
  '  create(): string { return "y"; }',
  "  @Get(`dyn`)",
  '  dyn(): string { return "z"; }',
  "}",
  "",
].join("\n");

const flaskApp = [
  "from flask import Flask, Blueprint",
  "from fastapi import FastAPI, APIRouter",
  "app = Flask(__name__)",
  'bp = Blueprint("bp", __name__)',
  "api = FastAPI()",
  "router = APIRouter()",
  "",
  '@app.route("/users")',
  "def users():",
  '    return "x"',
  "",
  '@app.get("/items")',
  "def items():",
  '    return "y"',
  "",
  '@bp.post("/bp")',
  "def bp_post():",
  '    return "z"',
  "",
  '@router.get(f"/dyn/{app}")',
  "def dyn():",
  '    return "d"',
  "",
  "def plain():",
  '    return "p"',
  "",
  'app.add_url_rule("/plain", view_func=plain)',
  'app.add_url_rule("/third", "third", plain)',
  'app.register_blueprint(bp, url_prefix="/blue")',
  "app.register_blueprint(bp)",
  'api.include_router(router, prefix="/v1")',
  "",
].join("\n");

describe("route edges", () => {
  it("records express registrations whose receiver binds to the framework import", async () => {
    await write({ "src/app.ts": expressApp, "src/users.ts": "export function listUsers(): void {}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(rows(index, "src/app.ts")).toEqual([
      "12:GET /users -> handler=src/app.ts#handler[lexical-definition]",
      "13:GET /imported -> listUsers=src/users.ts#listUsers[import-binding]",
      "14:POST /users -> (inline)=-[unresolved:route-handler-inline]",
      "15:PUT /wrapped -> wrap=-[unresolved:route-handler-wrapped]",
      "16:DELETE (computed) -> handler=src/app.ts#handler[lexical-definition]",
      "17:GET (computed) -> handler=src/app.ts#handler[lexical-definition]",
      "18:ANY /member -> list=src/app.ts#Ctrl.list[receiver-hint]",
      "19:GET /static -> ping=src/app.ts#Ctrl.ping[receiver-hint]",
      "20:ANY /api -> router=src/app.ts#router[lexical-definition]",
      "23:GET /r -> handler=src/app.ts#handler[lexical-definition]",
      "24:POST /r2 -> handler=src/app.ts#handler[lexical-definition]",
      "27:ANY /inner -> router=src/app.ts#build.router[lexical-definition]",
      "29:GET (computed) -> handler=src/app.ts#handler[lexical-definition]",
    ]);
    const calls = index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === "src/app.ts" && edge.toName === "get");
    expect(calls.length).toBeGreaterThanOrEqual(7);
    expect(index.incoming("src/app.ts#handler").filter((edge) => edge.kind === "routes")).toHaveLength(6);
    const coverage = resolutionCoverage(index).total;
    expect([coverage.routes, coverage.routesResolved]).toEqual([13, 11]);
  });

  it("records nest decorators against the decorated method or class", async () => {
    await write({ "src/cats.controller.ts": nestController });
    const index = await buildIndex(workspace, { cacheDir });
    expect(rows(index, "src/cats.controller.ts")).toEqual([
      "2:ANY cats -> CatsController=src/cats.controller.ts#CatsController[lexical-definition]",
      "4:GET  -> findAll=src/cats.controller.ts#CatsController.findAll[lexical-definition]",
      "6:POST :id -> create=src/cats.controller.ts#CatsController.create[lexical-definition]",
      "8:GET (computed) -> dyn=src/cats.controller.ts#CatsController.dyn[lexical-definition]",
    ]);
  });

  it("records flask and fastapi decorators, url rules and mounts", async () => {
    await write({ "src/app.py": flaskApp });
    const index = await buildIndex(workspace, { cacheDir });
    expect(rows(index, "src/app.py")).toEqual([
      "8:ANY /users -> users=src/app.py#users[lexical-definition]",
      "12:GET /items -> items=src/app.py#items[lexical-definition]",
      "16:POST /bp -> bp_post=src/app.py#bp_post[lexical-definition]",
      "20:GET (computed) -> dyn=src/app.py#dyn[lexical-definition]",
      "27:ANY /plain -> plain=src/app.py#plain[lexical-definition]",
      "28:ANY /third -> plain=src/app.py#plain[lexical-definition]",
      "29:ANY /blue -> bp=-[unresolved:bound-symbol-missing]",
      "30:ANY (computed) -> bp=-[unresolved:bound-symbol-missing]",
      "31:ANY /v1 -> router=-[unresolved:bound-symbol-missing]",
    ]);
  });

  it("emits nothing for a verb on a receiver that is not a framework object", async () => {
    await write({ "src/map.ts": 'const m = new Map<string, () => void>();\nfunction h(): void {}\nm.get("/x");\nm.set("/y", h);\nconst app = { get(p: string, f: () => void): void { f(); } };\napp.get("/z", h);\n' });
    const index = await buildIndex(workspace, { cacheDir });
    expect(index.edges.filter((edge) => edge.kind === "routes")).toEqual([]);
  });

  it("ranks a route by verb and path in ground", async () => {
    await write({ "src/app.ts": expressApp, "src/users.ts": "export function listUsers(): void {}\n", "src/cats.controller.ts": nestController });
    const index = await buildIndex(workspace, { cacheDir });
    const users = ask(index, "GET /users").hits;
    expect(users[0]?.symbol?.qualifiedName).toBe("src/app.ts#handler");
    expect(users[0]?.line).toBe(12);
    const inline = ask(index, "POST /users").hits;
    expect(inline.map((hit) => `${hit.file}:${hit.line}:${hit.symbol?.qualifiedName ?? "-"}`).slice(0, 2)).toContain("src/app.ts:14:-");
    const imported = ask(index, "GET /imported").hits;
    expect(imported[0]?.file).toBe("src/app.ts");
    expect(imported[0]?.line).toBe(13);
    const cats = ask(index, "POST :id").hits;
    expect(cats[0]?.symbol?.qualifiedName).toBe("src/cats.controller.ts#CatsController.create");
    const composed = ask(index, "POST /cats/:id").hits;
    expect(composed[0]?.symbol?.qualifiedName).toBe("src/cats.controller.ts#CatsController.create");
    const listing = ask(index, "GET /cats").hits;
    expect(listing[0]?.symbol?.qualifiedName).toBe("src/cats.controller.ts#CatsController.findAll");
  });

  it("prints the route on warp rows", async () => {
    await write({ "src/app.ts": expressApp, "src/users.ts": "export function listUsers(): void {}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    const text = formatCallersDetailed(callersDetailed(index, "src/app.ts#handler"));
    expect(text).toContain("routes");
    expect(text).toContain("route: GET /users");
    expect(text).toContain("route: DELETE (computed path)");
  });

  it("round-trips route metadata through the edge store and keeps incremental equal to full", async () => {
    await write({ "src/app.ts": expressApp, "src/users.ts": "export function listUsers(): void {}\n", "src/app.py": flaskApp, "src/cats.controller.ts": nestController });
    const index = await buildIndex(workspace, { cacheDir });
    const { paths } = serializeSections(index);
    const layout = serializeEdges(index.edges, paths);
    expect(deserializeEdges(layout.bytes, paths, index.files)).toEqual(index.edges);
    expect(layout.bytes.toString("utf8").split("\n")[0]).toContain('"routes":[');

    await write({ "src/users.ts": "export function listUsers(): void {}\nexport function extra(): void {}\n" });
    const incremental = await applyChanges(index, workspace, ["src/users.ts"]);
    const full = await buildIndex(workspace, { cacheDir: path.join(temporary, "cache2") });
    expect(serializeArtifact(incremental).equals(serializeArtifact(full))).toBe(true);
    expect(serializeEdges(incremental.edges, paths).bytes.equals(serializeEdges(full.edges, paths).bytes)).toBe(true);
  });
});
