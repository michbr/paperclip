import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetShellCommand } from "@paperclipai/adapter-utils/execution-target";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export type ManagedCursorMcpGateway = {
  name: string;
  endpointPath: string;
  bearerToken: string;
};

export type CursorMcpConfigFile = {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
};

export type ManagedCursorMcpSnapshot = {
  configPath: string;
  /** Raw prior file contents, or null when the file did not exist. */
  previousContents: string | null;
  serverNames: string[];
  warnings: string[];
};

function sanitizeMcpServerName(value: string, fallback: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

export function mergeManagedCursorMcpGateways(
  primary: ManagedCursorMcpGateway[],
  secondary: ManagedCursorMcpGateway[],
): ManagedCursorMcpGateway[] {
  const merged = [...primary];
  const names = new Set(primary.map((gateway) => gateway.name));
  for (const gateway of secondary) {
    if (names.has(gateway.name)) continue;
    merged.push(gateway);
    names.add(gateway.name);
  }
  return merged;
}

export function managedMcpGatewaysFromContext(context: Record<string, unknown>): ManagedCursorMcpGateway[] {
  const managedMcp = parseObject(context.paperclipManagedMcp);
  if (managedMcp.managedMcpOnly !== true) return [];
  const gateways = Array.isArray(managedMcp.gateways) ? managedMcp.gateways : [];
  return gateways
    .map((raw): ManagedCursorMcpGateway | null => {
      const gateway = parseObject(raw);
      const name = asString(gateway.name, "").trim();
      const endpointPath = asString(gateway.endpointPath, "").trim();
      const bearerToken = asString(gateway.bearerToken, "").trim();
      if (!name || !endpointPath || !bearerToken) return null;
      return { name, endpointPath, bearerToken };
    })
    .filter((gateway): gateway is ManagedCursorMcpGateway => Boolean(gateway));
}

function parseMcpConfig(raw: string): CursorMcpConfigFile {
  if (!raw.trim()) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { mcpServers: {} };
    }
    const obj = parsed as Record<string, unknown>;
    const servers =
      obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)
        ? (obj.mcpServers as Record<string, unknown>)
        : {};
    return { ...obj, mcpServers: { ...servers } };
  } catch {
    return { mcpServers: {} };
  }
}

export function buildManagedCursorMcpServers(input: {
  gateways: ManagedCursorMcpGateway[];
  apiBaseUrl: string;
  existingNames: Set<string>;
}): { servers: Record<string, { url: string; headers: Record<string, string> }>; warnings: string[]; names: string[] } {
  const warnings: string[] = [];
  const usedNames = new Set<string>();
  const servers: Record<string, { url: string; headers: Record<string, string> }> = {};
  const names: string[] = [];

  input.gateways.forEach((gateway, index) => {
    const baseName = sanitizeMcpServerName(gateway.name, `gateway-${index + 1}`);
    const directOverlap = input.existingNames.has(gateway.name) || input.existingNames.has(baseName);
    let managedName = directOverlap ? `paperclip-${baseName}` : baseName;
    let suffix = 2;
    while (usedNames.has(managedName) || input.existingNames.has(managedName)) {
      managedName = `paperclip-${baseName}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(managedName);
    names.push(managedName);
    if (directOverlap) {
      warnings.push(
        `Found unmanaged Cursor MCP server "${gateway.name}" overlapping a Paperclip-governed gateway; leaving the direct entry in place and adding managed gateway "${managedName}". Paperclip cannot enforce policies for that direct entry.`,
      );
    }
    const url = new URL(gateway.endpointPath, input.apiBaseUrl).toString();
    servers[managedName] = {
      url,
      headers: {
        Authorization: `Bearer ${gateway.bearerToken}`,
      },
    };
  });

  return { servers, warnings, names };
}

export function resolveCursorWorkspaceMcpConfigPath(workspaceCwd: string): string {
  return path.join(workspaceCwd, ".cursor", "mcp.json");
}

export function resolveCursorWorkspaceMcpConfigPathPosix(workspaceCwd: string): string {
  return path.posix.join(workspaceCwd.replace(/\\/g, "/"), ".cursor", "mcp.json");
}

async function readLocalTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeLocalTextFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

async function readRemoteTextFile(input: {
  runId: string;
  target: AdapterExecutionTarget;
  remotePath: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  const remotePathJson = JSON.stringify(input.remotePath);
  const result = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    `if [ -f ${remotePathJson} ]; then printf 'EXISTS\\n'; base64 ${remotePathJson}; else printf 'MISSING\\n'; fi`,
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
      graceSec: input.graceSec,
    },
  );
  const stdout = result.stdout ?? "";
  const lines = stdout.split(/\r?\n/);
  const marker = lines[0]?.trim();
  if (marker !== "EXISTS") return null;
  const b64 = lines.slice(1).join("").replace(/\s+/g, "");
  if (!b64) return "";
  return Buffer.from(b64, "base64").toString("utf8");
}

async function writeRemoteTextFile(input: {
  runId: string;
  target: AdapterExecutionTarget;
  remotePath: string;
  contents: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<void> {
  const remotePathJson = JSON.stringify(input.remotePath);
  const b64 = Buffer.from(input.contents, "utf8").toString("base64");
  const result = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    `mkdir -p ${JSON.stringify(path.posix.dirname(input.remotePath))} && printf '%s' ${JSON.stringify(b64)} | base64 -d > ${remotePathJson} && chmod 600 ${remotePathJson}`,
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
      graceSec: input.graceSec,
    },
  );
  if ((result.exitCode ?? 0) !== 0) {
    throw new Error(
      `Failed to write managed Cursor MCP config at ${input.remotePath}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
}

async function removeRemoteTextFile(input: {
  runId: string;
  target: AdapterExecutionTarget;
  remotePath: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    `rm -f ${JSON.stringify(input.remotePath)}`,
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
      graceSec: input.graceSec,
    },
  );
}

export async function writeManagedCursorMcpConfig(input: {
  workspaceCwd: string;
  apiBaseUrl: string;
  gateways: ManagedCursorMcpGateway[];
  executionTarget: AdapterExecutionTarget | null | undefined;
  runId: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<ManagedCursorMcpSnapshot | null> {
  if (input.gateways.length === 0) return null;

  const isRemote = input.executionTarget?.kind === "remote";
  const configPath = isRemote
    ? resolveCursorWorkspaceMcpConfigPathPosix(input.workspaceCwd)
    : resolveCursorWorkspaceMcpConfigPath(input.workspaceCwd);

  const previousContents = isRemote
    ? await readRemoteTextFile({
        runId: input.runId,
        target: input.executionTarget!,
        remotePath: configPath,
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
      })
    : await readLocalTextFile(configPath);

  const existing = parseMcpConfig(previousContents ?? "");
  const existingNames = new Set(Object.keys(existing.mcpServers));
  const { servers, warnings, names } = buildManagedCursorMcpServers({
    gateways: input.gateways,
    apiBaseUrl: input.apiBaseUrl,
    existingNames,
  });

  const next: CursorMcpConfigFile = {
    ...existing,
    mcpServers: {
      ...existing.mcpServers,
      ...servers,
    },
  };
  const nextContents = `${JSON.stringify(next, null, 2)}\n`;

  if (isRemote) {
    await writeRemoteTextFile({
      runId: input.runId,
      target: input.executionTarget!,
      remotePath: configPath,
      contents: nextContents,
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
      graceSec: input.graceSec,
    });
  } else {
    await writeLocalTextFile(configPath, nextContents);
  }

  return {
    configPath,
    previousContents,
    serverNames: names,
    warnings,
  };
}

export async function restoreManagedCursorMcpConfig(input: {
  snapshot: ManagedCursorMcpSnapshot | null;
  executionTarget: AdapterExecutionTarget | null | undefined;
  runId: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<void> {
  if (!input.snapshot) return;

  const isRemote = input.executionTarget?.kind === "remote";
  const { configPath, previousContents } = input.snapshot;

  if (previousContents == null) {
    if (isRemote) {
      await removeRemoteTextFile({
        runId: input.runId,
        target: input.executionTarget!,
        remotePath: configPath,
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
      });
    } else {
      await fs.rm(configPath, { force: true }).catch(() => undefined);
    }
    return;
  }

  if (isRemote) {
    await writeRemoteTextFile({
      runId: input.runId,
      target: input.executionTarget!,
      remotePath: configPath,
      contents: previousContents,
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
      graceSec: input.graceSec,
    });
  } else {
    await writeLocalTextFile(configPath, previousContents);
  }
}

export function ensureApproveMcpsArg(extraArgs: string[], hasManagedGateways: boolean): string[] {
  if (!hasManagedGateways) return extraArgs;
  if (extraArgs.includes("--approve-mcps")) return extraArgs;
  return [...extraArgs, "--approve-mcps"];
}
