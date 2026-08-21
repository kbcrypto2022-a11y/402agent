import { mkdtemp, readFile, writeFile, chmod, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { execPath } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const WORKSPACE = "/home/runner/workspace";
const WRAPPER = join(WORKSPACE, "artifacts/agent402/scripts/run-with-smoke.sh");

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a TCP port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

describe("production smoke process isolation", () => {
  it("keeps a delayed paid request alive after a relayer-nonce-like smoke failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent402-process-isolation-"));
    const binDir = join(dir, "bin");
    const serverScript = join(dir, "server.mjs");
    const requestScript = join(dir, "request.mjs");
    const startedFile = join(dir, "paid-request-started");
    const resultFile = join(dir, "paid-request-result");
    const helperPidFile = join(dir, "request-helper-pid");
    const realPnpm = join(dir, "real-pnpm");
    const fakeNode = join(binDir, "node");
    const fakePnpm = join(binDir, "pnpm");
    const port = await reserveFreePort();

    await mkdir(binDir);
    await writeFile(
      serverScript,
      `
        import { createServer } from "node:http";
        import { writeFileSync } from "node:fs";
        const server = createServer(async (req, res) => {
          if (req.url === "/agent402/api/v1/health") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }
          if (req.url === "/agent402/api/v1/paid") {
            writeFileSync(process.env.STARTED_FILE, "started");
            await new Promise((resolve) => setTimeout(resolve, 700));
            res.statusCode = 200;
            res.end("paid request completed");
            return;
          }
          res.statusCode = 404;
          res.end("not found");
        });
        server.listen(Number(process.env.PORT), "127.0.0.1");
      `,
    );
    await writeFile(
      requestScript,
      `
        const response = await fetch(process.env.PAID_URL);
        const body = await response.text();
        const { writeFileSync } = await import("node:fs");
        writeFileSync(process.env.RESULT_FILE, body);
      `,
    );
    await writeFile(
      fakeNode,
      `#!/usr/bin/env bash
exec "$REAL_NODE" "$SERVER_SCRIPT"
`,
    );
    await writeFile(
      fakePnpm,
      `#!/usr/bin/env bash
if [[ "$*" == *"run smoke"* ]]; then
  nohup "$REAL_NODE" "$REQUEST_SCRIPT" >/dev/null 2>&1 &
  echo $! > "$HELPER_PID_FILE"
  echo "simulated facilitator relayer nonce already used" >&2
  exit 17
fi
exec "$REAL_PNPM" "$@"
`,
    );
    await chmod(fakeNode, 0o755);
    await chmod(fakePnpm, 0o755);

    const child = spawn("bash", [WRAPPER], {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PORT: String(port),
        AGENT402_URL: `http://127.0.0.1:${port}/agent402`,
        MAX_WAIT_SECONDS: "5",
        SMOKE_POLL_INTERVAL: "1",
        REAL_NODE: execPath,
        REAL_PNPM: process.env.PNPM_HOME
          ? join(process.env.PNPM_HOME, "pnpm")
          : "pnpm",
        SERVER_SCRIPT: serverScript,
        REQUEST_SCRIPT: requestScript,
        PAID_URL: `http://127.0.0.1:${port}/agent402/api/v1/paid`,
        STARTED_FILE: startedFile,
        RESULT_FILE: resultFile,
        HELPER_PID_FILE: helperPidFile,
        NODE_ENV: "test",
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

    try {
      await waitForFile(startedFile);
      expect(await waitForFile(resultFile)).toBe("paid request completed");
      expect(output).toContain("relayer nonce already used");
      expect(output).toContain("Smoke test FAILED");
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await waitForExit(child);
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});