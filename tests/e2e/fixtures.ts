import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo>/tests/e2e/fixtures.ts. The repo is ESM
// ("type":"module"), so derive the directory from import.meta.url rather than
// relying on __dirname.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/**
 * The known bootstrap admin token. On a fresh DB the server seeds the FIRST
 * access token from SMITHERS_HUB_BOOTSTRAP_TOKEN with scopes
 * admin+api+runner+mcp (see src/db.js ensureBootstrapToken), so this single
 * token can do everything: create runs, drive the runner lifecycle, approve.
 */
export const ADMIN_TOKEN = "shub_e2e_admin_token_pick_anything";

/** A known non-dev session secret so the production guard never fires under http. */
const SESSION_SECRET = "e2e-test-secret-not-the-dev-default-0123456789";

export type ApiResult<T = any> = { status: number; ok: boolean; body: T };

export interface Hub {
  /** e.g. http://127.0.0.1:54321 */
  baseURL: string;
  /** The admin bootstrap token (scopes: admin,api,runner,mcp). */
  adminToken: string;
  /** The temp data dir this server is rooted at. */
  dataDir: string;
  /**
   * Make a JSON API call. Defaults to the admin bearer token.
   * Returns { status, ok, body } where body is the parsed JSON (or text fallback).
   */
  api<T = any>(
    method: string,
    apiPath: string,
    body?: unknown,
    token?: string | null,
  ): Promise<ApiResult<T>>;
  /** Mint a fresh runner-scoped access token via POST /api/tokens (admin). */
  mintRunnerToken(name?: string): Promise<string>;
}

/** Pick a free TCP port by binding to :0, reading the assigned port, then closing. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine free port")));
      }
    });
  });
}

async function waitForReady(baseURL: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/readyz`);
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `Hub did not become ready at ${baseURL}/readyz within ${timeoutMs}ms` +
      (lastErr ? ` (last error: ${String(lastErr)})` : ""),
  );
}

function makeApi(baseURL: string, defaultToken: string) {
  return async function api<T = any>(
    method: string,
    apiPath: string,
    body?: unknown,
    token: string | null = defaultToken,
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${baseURL}${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: any;
    const text = await res.text();
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, ok: res.ok, body: parsed as T };
  };
}

export const test = base.extend<{ hub: Hub }>({
  hub: async ({}, use) => {
    const port = await getFreePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "runyard-e2e-"));

    const child: ChildProcess = spawn(
      process.execPath,
      ["--experimental-sqlite", "src/server.js"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          SMITHERS_HUB_DATA_DIR: dataDir,
          PORT: String(port),
          HOST: "127.0.0.1",
          SMITHERS_HUB_BOOTSTRAP_TOKEN: ADMIN_TOKEN,
          SMITHERS_HUB_SESSION_SECRET: SESSION_SECRET,
          // Keep base url http so cookies are not marked Secure and the
          // production session-secret guard does not fire.
          BASE_URL: baseURL,
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const logs: string[] = [];
    child.stdout?.on("data", (d) => logs.push(`[out] ${d}`));
    child.stderr?.on("data", (d) => logs.push(`[err] ${d}`));

    let exited = false;
    let exitInfo = "";
    child.on("exit", (code, signal) => {
      exited = true;
      exitInfo = `code=${code} signal=${signal}`;
    });

    try {
      await waitForReady(baseURL);
    } catch (err) {
      if (exited) {
        throw new Error(
          `Hub process exited before becoming ready (${exitInfo}).\n` +
            logs.join(""),
        );
      }
      throw new Error(`${String(err)}\n--- server logs ---\n${logs.join("")}`);
    }

    const api = makeApi(baseURL, ADMIN_TOKEN);

    const hub: Hub = {
      baseURL,
      adminToken: ADMIN_TOKEN,
      dataDir,
      api,
      async mintRunnerToken(name = `e2e-runner-token-${Date.now()}`) {
        const res = await api<{ token: { token: string; secret?: string } }>(
          "POST",
          "/api/tokens",
          { name, scopes: ["runner"] },
        );
        if (!res.ok) {
          throw new Error(
            `mintRunnerToken failed: ${res.status} ${JSON.stringify(res.body)}`,
          );
        }
        // POST /api/tokens returns the freshly-minted secret token value.
        const tok =
          (res.body as any)?.token?.token ??
          (res.body as any)?.token?.secret ??
          (res.body as any)?.secret ??
          (res.body as any)?.token;
        if (typeof tok !== "string") {
          throw new Error(
            `mintRunnerToken: could not find token in response ${JSON.stringify(res.body)}`,
          );
        }
        return tok;
      },
    };

    try {
      await use(hub);
    } finally {
      if (!exited && child.pid != null) {
        child.kill("SIGKILL");
      }
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  },
});

export { expect };
