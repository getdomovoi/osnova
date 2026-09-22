import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { hookSettingsObject } from "../src/cli/hook.js";

const root = path.resolve(import.meta.dirname, "..");
const read = <T>(relative: string): T => JSON.parse(readFileSync(path.join(root, relative), "utf8")) as T;

interface Versioned { version: string }
interface Package extends Versioned { name: string; mcpName: string }
interface Marketplace { plugins: [{ version: string; source: string }] }
interface Server extends Versioned { $schema: string; name: string; packages: [{ identifier: string; version: string }] }
interface Mcp { mcpServers: { osnova: unknown } }

describe("distribution manifests", () => {
  const pkg = read<Package>("package.json");

  it("pin the package version everywhere the release workflow does not check", () => {
    expect(read<Versioned>("integrations/claude-code/.claude-plugin/plugin.json").version).toBe(pkg.version);
    expect(read<Marketplace>(".claude-plugin/marketplace.json").plugins[0].version).toBe(pkg.version);
    const server = read<Server>("server.json");
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.name).toBe(pkg.mcpName);
  });

  it("validate server.json against the MCP registry schema it names", () => {
    const server = read<Server>("server.json");
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(read<object>("test/fixtures/schemas/mcp-server-2025-12-11.schema.json"));
    expect(validate(server), JSON.stringify(validate.errors)).toBe(true);
    const stale = structuredClone(server) as Server & { packages: [Record<string, unknown>] };
    stale.packages[0].registry_type = stale.packages[0].registryType;
    delete stale.packages[0].registryType;
    expect(validate(stale)).toBe(false);
  });

  it("wire the plugin hooks exactly as osnova setup would", () => {
    expect(read<unknown>("integrations/claude-code/hooks/hooks.json")).toEqual(hookSettingsObject(["npx", "-y", "@getdomovoi/osnova"], "claude-code"));
  });

  it("serve the plugin MCP entry through the same package", () => {
    expect(read<Mcp>("integrations/claude-code/.mcp.json").mcpServers.osnova).toEqual({ command: "npx", args: ["-y", "@getdomovoi/osnova", "mcp"] });
    expect(read<Marketplace>(".claude-plugin/marketplace.json").plugins[0].source).toBe("./integrations/claude-code");
  });
});
