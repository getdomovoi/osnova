import { expect, it } from "vitest";
import type { OsnovaMcpStatus, RequestedSymbol } from "../src/index.js";

it("exports the types of footing's requested statuses and the MCP server status", () => {
  const requested: RequestedSymbol = { name: "a.ts#one", status: "returned" };
  const status: OsnovaMcpStatus = { watching: false, refreshes: 0, pendingChanges: false, warm: "off" };
  expect([requested.status, status.warm]).toEqual(["returned", "off"]);
});
