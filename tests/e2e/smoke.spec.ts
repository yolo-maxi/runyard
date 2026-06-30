import { test, expect } from "./fixtures";
import { fakeRunner } from "./fakeRunner";

test("hub boots, /api/setup responds, and login + full run lifecycle works", async ({ hub, page }) => {
  // --- API: /api/setup responds (unauth) ---
  const setup = await hub.api("GET", "/api/setup", undefined, null);
  expect(setup.status).toBe(200);
  expect(setup.body.auth).toBe("access-token");

  // --- Drive a full no-approval run lifecycle over HTTP ---
  // Create a 'hello' run (approvalPolicy.required=false -> lands status=queued).
  const created = await hub.api("POST", "/api/capabilities/hello/run", {
    input: { topic: "e2e smoke" },
  });
  expect(created.status).toBe(202);
  const runId: string = created.body.run.id;
  expect(runId).toBeTruthy();
  expect(created.body.run.status).toBe("queued");

  // Fake runner takes it queued -> assigned -> running -> succeeded.
  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
  await runner.claimAndRun(runId, {
    output: { smithersRunId: "run-1", outputs: { hello: { answer: "hi there" } } },
  });

  // Confirm terminal success via the API.
  const detail = await hub.api("GET", `/api/runs/${runId}`);
  expect(detail.status).toBe(200);
  expect(detail.body.run.status).toBe("succeeded");

  // --- UI: log into /app with the admin token ---
  await page.goto(`${hub.baseURL}/app`);
  await page.waitForSelector("#login:not(.hidden)", { timeout: 10_000 });
  await page.fill("#token", hub.adminToken);
  await page.click('#login-form button[type="submit"]');

  // Login does a full location.reload(); wait for the app shell to be visible.
  await page.waitForSelector("#app:not(.hidden)", { timeout: 10_000 });
  await expect(page.locator("#login")).toHaveClass(/hidden/);

  // --- UI: open the run detail and assert the terminal success state ---
  await page.goto(`${hub.baseURL}/app#runs/${runId}`);
  const banner = page.locator('header.run-banner[data-status="succeeded"]');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner.locator(".run-banner-status .status")).toContainText("succeeded");
  await expect(page.locator("#panel-logs")).toBeAttached();
});
