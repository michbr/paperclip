import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManagedCursorMcpServers,
  ensureApproveMcpsArg,
  mergeManagedCursorMcpGateways,
  restoreManagedCursorMcpConfig,
  writeManagedCursorMcpConfig,
} from "./managed-mcp.js";

describe("managed cursor mcp config", () => {
  it("merges gateways by name without duplicates", () => {
    const merged = mergeManagedCursorMcpGateways(
      [{ name: "paperclip-assigned", endpointPath: "/mcp/a", bearerToken: "t1" }],
      [
        { name: "paperclip-assigned", endpointPath: "/mcp/a", bearerToken: "t1" },
        { name: "named", endpointPath: "/mcp/b", bearerToken: "t2" },
      ],
    );
    expect(merged).toEqual([
      { name: "paperclip-assigned", endpointPath: "/mcp/a", bearerToken: "t1" },
      { name: "named", endpointPath: "/mcp/b", bearerToken: "t2" },
    ]);
  });

  it("builds http MCP entries with bearer headers", () => {
    const { servers, names, warnings } = buildManagedCursorMcpServers({
      gateways: [{ name: "paperclip-assigned", endpointPath: "/mcp/gateways/abc", bearerToken: "secret" }],
      apiBaseUrl: "http://127.0.0.1:3100",
      existingNames: new Set(),
    });
    expect(names).toEqual(["paperclip-assigned"]);
    expect(warnings).toEqual([]);
    expect(servers["paperclip-assigned"]).toEqual({
      url: "http://127.0.0.1:3100/mcp/gateways/abc",
      headers: { Authorization: "Bearer secret" },
    });
  });

  it("renames on overlap with existing unmanaged servers", () => {
    const { servers, names, warnings } = buildManagedCursorMcpServers({
      gateways: [{ name: "jira", endpointPath: "https://example.test/mcp", bearerToken: "tok" }],
      apiBaseUrl: "http://127.0.0.1:3100",
      existingNames: new Set(["jira"]),
    });
    expect(names).toEqual(["paperclip-jira"]);
    expect(servers["paperclip-jira"]?.url).toBe("https://example.test/mcp");
    expect(warnings[0]).toContain("overlapping");
  });

  it("writes and restores home mcp.json locally", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-mcp-"));
    try {
      const existingPath = path.join(root, ".cursor", "mcp.json");
      await fs.mkdir(path.dirname(existingPath), { recursive: true });
      await fs.writeFile(
        existingPath,
        `${JSON.stringify({ mcpServers: { local: { command: "echo" } } }, null, 2)}\n`,
        "utf8",
      );

      const snapshot = await writeManagedCursorMcpConfig({
        cursorHome: root,
        apiBaseUrl: "http://127.0.0.1:3100",
        gateways: [{ name: "paperclip-assigned", endpointPath: "/mcp/gateways/x", bearerToken: "run-token" }],
        executionTarget: null,
        runId: "run-1",
        cwd: root,
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      });

      expect(snapshot).not.toBeNull();
      const written = JSON.parse(await fs.readFile(existingPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(written.mcpServers.local).toEqual({ command: "echo" });
      expect(written.mcpServers["paperclip-assigned"]).toEqual({
        url: "http://127.0.0.1:3100/mcp/gateways/x",
        headers: { Authorization: "Bearer run-token" },
      });

      await restoreManagedCursorMcpConfig({
        snapshot,
        executionTarget: null,
        runId: "run-1",
        cwd: root,
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      });

      const restored = JSON.parse(await fs.readFile(existingPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(restored.mcpServers).toEqual({ local: { command: "echo" } });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes mcp.json on restore when Paperclip created the file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-mcp-"));
    try {
      const snapshot = await writeManagedCursorMcpConfig({
        cursorHome: root,
        apiBaseUrl: "http://127.0.0.1:3100",
        gateways: [{ name: "gw", endpointPath: "/mcp/g", bearerToken: "t" }],
        executionTarget: null,
        runId: "run-2",
        cwd: root,
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      });
      const configPath = path.join(root, ".cursor", "mcp.json");
      await expect(fs.access(configPath)).resolves.toBeUndefined();

      await restoreManagedCursorMcpConfig({
        snapshot,
        executionTarget: null,
        runId: "run-2",
        cwd: root,
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      });
      await expect(fs.access(configPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("adds --approve-mcps when managed gateways are present", () => {
    expect(ensureApproveMcpsArg(["--trust"], true)).toEqual(["--trust", "--approve-mcps"]);
    expect(ensureApproveMcpsArg(["--approve-mcps"], true)).toEqual(["--approve-mcps"]);
    expect(ensureApproveMcpsArg(["--trust"], false)).toEqual(["--trust"]);
  });
});
