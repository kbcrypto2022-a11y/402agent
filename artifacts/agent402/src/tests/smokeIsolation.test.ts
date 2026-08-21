import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const wrapperPath = join(packageRoot, "scripts/run-with-smoke.sh");

type RunningProcess = {
  child: ChildProcess;
  output: () => string;
};

const activeProcesses: RunningProcess[] = [];
const activeServers: Server[] = [];

afterEach(async () => {
  for (const process of activeProcesses.splice(0)) {
    if (process.child.exitCode === null && process.child.signalCode === null) {
      process.child.kill("SIGTERM");
    }
    await waitForExit(process.child).catch(() => undefined);
  }
  for (const server of activeServers.splice(0)) {
    if (server.listening) {
      await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
    }
  }
});

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    child.once("exit", () => resolveExit());
    child.once("error", rejectExit);
  });
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  activeServers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  activeServers.splice(activeServers.indexOf(server), 1);
  return port;
}

async function createFixtureScripts(directory: string): Promise<{
  serverScript: string;
  smokeScript: string;
  binDirectory: string;
}> {
  const serverScript = join(directory, "fixture-server.mjs");
  const smokeScript = join(directory, "fixture-smoke.sh");
  const binDirectory = join(directory, "bin");
  await mkdir(binDirectory, { recursive: true });

  await writeFile(
    serverScript,
    `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const server = createServer((req, res) => {
  if (req.url === "/agent402/in-flight") {
    writeFileSync(process.env.INFLIGHT_STARTED_FILE, "started");
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ completed: true }));
    }, 350);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok", payment_mode: "testnet" }));
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  writeFileSync(process.env.SERVER_READY_FILE, String(process.pid));
  writeFileSync(process.env.SERVER_PID_FILE, String(process.pid));
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`,
    "utf8",
  );
  await writeFile(
    smokeScript,
    `#!/usr/bin/env bash
set -u
for _ in $(seq 1 200); do
  if [ -f "$INFLIGHT_STARTED_FILE" ]; then
    break
  fi
  sleep 0.01
done
if [ ! -f "$INFLIGHT_STARTED_FILE" ]; then
  echo "in-flight request never started" >&2
  exit 99
fi
echo "invalid_exact_evm_transaction_failed: nonce too low" >&2
echo "failed" > "$SMOKE_DONE_FILE"
exit 23
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(binDirectory, "node"),
    `#!/usr/bin/env bash
exec "$REAL_NODE" "$FIXTURE_SERVER_SCRIPT"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(binDirectory, "pnpm"),
    `#!/usr/bin/env bash
exec bash "$FIXTURE_SMOKE_SCRIPT"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(binDirectory, "curl"),
    `#!/usr/bin/env bash
exit 0
`,
    { mode: 0o755 },
  );
  return { serverScript, smokeScript, binDirectory };
}

function startWrapper(
  directory: string,
  binDirectory: string,
  port: number,
  files: { serverReady: string; serverPid: string; smokeDone: string; inFlightStarted: string },
): RunningProcess {
  const child = spawn("bash", [wrapperPath], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      REAL_NODE: process.execPath,
      FIXTURE_SERVER_SCRIPT: join(directory, "fixture-server.mjs"),
      FIXTURE_SMOKE_SCRIPT: join(directory, "fixture-smoke.sh"),
      PORT: String(port),
      AGENT402_URL: `http://127.0.0.1:${port}/agent402`,
      SERVER_READY_FILE: files.serverReady,
      SERVER_PID_FILE: files.serverPid,
      SMOKE_DONE_FILE: files.smokeDone,
      INFLIGHT_STARTED_FILE: files.inFlightStarted,
      MAX_WAIT_SECONDS: "5",
      SMOKE_POLL_INTERVAL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const running = { child, output: () => output };
  activeProcesses.push(running);
  return running;
}

describe("production smoke process isolation", () => {
  it("keeps the server and an in-flight request alive after a stale nonce smoke failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent402-smoke-isolation-"));
    const files = {
      serverReady: join(directory, "server-ready"),
      serverPid: join(directory, "server-pid"),
      smokeDone: join(directory, "smoke-done"),
      inFlightStarted: join(directory, "in-flight-started"),
    };
    const { binDirectory } = await createFixtureScripts(directory);
    const port = await getFreePort();
    const wrapper = startWrapper(directory, binDirectory, port, files);

    await waitForFile(files.serverReady);
    const inFlight = fetch(`http://127.0.0.1:${port}/agent402/in-flight`);
    await waitForFile(files.inFlightStarted);
    await waitForFile(files.smokeDone);

    expect(wrapper.child.exitCode).toBeNull();
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: true });
    expect(wrapper.output()).toContain("nonce too low");
    expect(wrapper.output()).toContain("Smoke test failed (exit 23)");
    expect(wrapper.output()).toContain("production server remains running");

    const serverPid = Number(await readFile(files.serverPid, "utf8"));
    expect(() => process.kill(serverPid, 0)).not.toThrow();

    process.kill(serverPid, "SIGTERM");
    await waitForExit(wrapper.child);
    await rm(directory, { recursive: true, force: true });
  }, 10_000);

  it("runs smoke failure and alert reporting in its own process", async () => {
    const target = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("fixture health failure");
    });
    activeServers.push(target);
    const webhookBodies: string[] = [];
    const webhook = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        webhookBodies.push(body);
        res.writeHead(204);
        res.end();
      });
    });
    activeServers.push(webhook);
    await Promise.all([
      new Promise<void>((resolveListen) => target.listen(0, "127.0.0.1", () => resolveListen())),
      new Promise<void>((resolveListen) => webhook.listen(0, "127.0.0.1", () => resolveListen())),
    ]);
    const targetPort = (target.address() as { port: number }).port;
    const webhookPort = (webhook.address() as { port: number }).port;

    const smoke = spawn(
      "pnpm",
      ["--filter", "@workspace/agent402", "run", "smoke"],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          AGENT402_URL: `http://127.0.0.1:${targetPort}/agent402`,
          PAYER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
          SMOKE_ALERT_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}/alert`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    smoke.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    smoke.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    activeProcesses.push({ child: smoke, output: () => output });

    await waitForExit(smoke);
    expect(smoke.exitCode).not.toBe(0);
    expect(output).toContain("✗ Health returned 503");
    expect(output).toContain("Failure notification sent");
    expect(output).toContain("Health returned 503");
    expect(webhookBodies).toHaveLength(1);
    expect(webhookBodies[0]).toContain("Health returned 503");
  }, 10_000);
});