import { test, expect } from "./fixtures";
import { fakeRunner } from "./fakeRunner";
import type { Page } from "@playwright/test";

async function login(page: Page, hub: { baseURL: string; adminToken: string }) {
  await page.goto(`${hub.baseURL}/app`);
  await page.waitForSelector("#login:not(.hidden)", { timeout: 10_000 });
  await page.fill("#token", hub.adminToken);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#app:not(.hidden)", { timeout: 10_000 });
  await expect(page.locator("#login")).toHaveCount(0);
}

test("connect page creates, reveals, revokes a token, and audit records both mutations", async ({
  hub,
  page,
}) => {
  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#connect`);

  await expect(page.locator(".toolbar h1")).toContainText("Connect & Tokens", {
    timeout: 10_000,
  });

  const tokenPanel = page.locator(".panel").filter({ hasText: "Create Token" }).last();
  await tokenPanel.getByLabel("Name").fill("e2e browser token");
  await tokenPanel.locator('input.token-scope[value="runner"]').check();
  await tokenPanel.getByRole("button", { name: "Create Token" }).click();

  const createdSecret = tokenPanel.locator("#token-value");
  await expect(createdSecret).toBeVisible({ timeout: 10_000 });
  await expect(createdSecret).toHaveAttribute("type", "password");
  await tokenPanel.getByRole("button", { name: "Show" }).click();
  await expect(createdSecret).toHaveAttribute("type", "text");
  await expect(createdSecret).toHaveValue(/^shub_/);

  const tokenRow = page.locator("tbody tr").filter({ hasText: "e2e browser token" });
  await expect(tokenRow).toBeVisible({ timeout: 10_000 });
  await expect(tokenRow).toContainText("api, mcp, runner");

  page.once("dialog", (dialog) => dialog.accept());
  await tokenRow.getByRole("button", { name: "Revoke" }).click();
  await expect(tokenRow).toContainText("revoked", { timeout: 10_000 });

  await page.goto(`${hub.baseURL}/app#audit`);
  await expect(page.locator(".toolbar h1")).toContainText("Audit Log", {
    timeout: 10_000,
  });
  await expect(page.locator("tbody tr").filter({ hasText: "token.created" })).toBeVisible();
  await expect(page.locator("tbody tr").filter({ hasText: "token.revoked" })).toBeVisible();
});

test("schedules UI creates, previews, toggles, runs now, and deletes a schedule", async ({
  hub,
  page,
}) => {
  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#schedules`);

  await expect(page.locator(".toolbar h1")).toContainText("Schedules", {
    timeout: 10_000,
  });
  await page.locator("#new-schedule").click();
  await expect(page.locator("#editor")).toBeVisible();

  await page.fill("#sched-name", "E2E hourly hello");
  await page.fill("#sched-description", "Created and exercised from Playwright");
  await page.selectOption("#sched-cap", "hello");
  await page.fill("#sched-cron", "0 * * * *");
  await page.fill("#sched-timezone", "UTC");
  await page.fill("#sched-input", JSON.stringify({ topic: "scheduled e2e" }, null, 2));
  await expect(page.locator("#schedule-preview.valid")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#schedule-preview")).toContainText("Hourly");
  await page.getByRole("button", { name: "Create schedule" }).click();

  const card = page.locator("article.schedule-card").filter({ hasText: "E2E hourly hello" });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("hello");
  await expect(card).toContainText("enabled");

  const schedules = await hub.api("GET", "/api/schedules");
  expect(schedules.status).toBe(200);
  const schedule = (schedules.body.schedules || []).find(
    (entry: any) => entry.name === "E2E hourly hello",
  );
  expect(schedule, "expected saved schedule").toBeTruthy();
  const scheduleId: string = schedule.id;

  await page.goto(`${hub.baseURL}/app#schedules/${scheduleId}`);
  await expect(page.locator(".toolbar h1")).toContainText("E2E hourly hello", {
    timeout: 10_000,
  });
  await expect(page.locator(".schedule-facts")).toContainText("Enabled");

  await page.locator(`[data-toggle-schedule="${scheduleId}"]`).click();
  await expect(page.locator(".schedule-facts")).toContainText("Disabled", {
    timeout: 10_000,
  });
  await page.locator(`[data-toggle-schedule="${scheduleId}"]`).click();
  await expect(page.locator(".schedule-facts")).toContainText("Enabled", {
    timeout: 10_000,
  });

  await page.locator(`[data-run-schedule="${scheduleId}"]`).click();
  await expect(page).toHaveURL(/#runs\/run_/, { timeout: 10_000 });
  await expect(page.locator('header.run-banner[data-status="queued"]')).toBeVisible({
    timeout: 10_000,
  });

  await page.goto(`${hub.baseURL}/app#schedules/${scheduleId}`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(`[data-delete-schedule="${scheduleId}"]`).click();
  await expect(page).toHaveURL(/#schedules$/, { timeout: 10_000 });
  await expect(page.locator("article.schedule-card").filter({ hasText: "E2E hourly hello" })).toHaveCount(0);
});

test("runners view shows live runner capacity, heartbeat freshness, and details", async ({
  hub,
  page,
}) => {
  const runner = await fakeRunner(hub, {
    name: "e2e-ui-runner",
    tags: ["smithers", "local", "reauth"],
  });
  await runner.heartbeat();

  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#runners`);

  await expect(page.locator(".toolbar h1")).toContainText("Runners", {
    timeout: 10_000,
  });
  await expect(page.locator(".runner-pool-summary")).toContainText("queue empty");

  const row = page.locator(`#runner-row-${runner.id}`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("e2e-ui-runner");
  await expect(row).toContainText("online");
  await expect(row.locator(".runner-capacity-count")).toContainText("0 / 4");
  await expect(row.locator(".hb-cell")).toContainText(/just now|<1m|ago/);

  await row.getByRole("button", { name: "Details" }).click();
  const detail = page.locator(".runner-detail-row");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(runner.id);
  await expect(detail).toContainText("e2e-host");
  await expect(detail).toContainText("smithers, local, reauth");
});

test("settings and secrets UI saves, edits, and deletes write-only secrets", async ({
  hub,
  page,
}) => {
  const runner = await fakeRunner(hub, {
    name: "e2e-auth-runner",
    tags: ["smithers", "local", "reauth"],
  });
  await runner.heartbeat();

  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#settings`);

  await expect(page.locator(".toolbar h1")).toContainText("Settings & Secrets", {
    timeout: 10_000,
  });
  await expect(page.locator(".secret-runner-card").filter({ hasText: "e2e-auth-runner" })).toBeVisible({
    timeout: 10_000,
  });

  await page.fill("#secret-key", "E2E_SECRET");
  await page.fill("#secret-desc", "Playwright managed secret");
  await page.fill("#secret-value", "super-secret-value-1234");
  await page.getByRole("button", { name: "Save secret" }).click();

  const secretRow = page.locator("tbody tr").filter({ hasText: "E2E_SECRET" });
  await expect(secretRow).toBeVisible({ timeout: 10_000 });
  await expect(secretRow).toContainText("Playwright managed secret");
  await expect(page.locator("#secret-value")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("super-secret-value-1234");

  await secretRow.getByRole("button", { name: "Edit value" }).click();
  await expect(page.locator("#secret-key")).toHaveValue("E2E_SECRET");
  await expect(page.locator("#secret-desc")).toHaveValue("Playwright managed secret");
  await page.fill("#secret-desc", "Updated from Playwright");
  await page.fill("#secret-value", "rotated-secret-value-5678");
  await page.getByRole("button", { name: "Save secret" }).click();
  await expect(secretRow).toContainText("Updated from Playwright", {
    timeout: 10_000,
  });
  await expect(page.locator("body")).not.toContainText("rotated-secret-value-5678");

  page.once("dialog", (dialog) => dialog.accept());
  await secretRow.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("tbody tr").filter({ hasText: "E2E_SECRET" })).toHaveCount(0, {
    timeout: 10_000,
  });
});

test("agents area lists all tabs and edits an agent through the JSON editor", async ({
  hub,
  page,
}) => {
  expect(
    await hub.api("POST", "/api/skills", {
      slug: "e2e-skill",
      name: "E2E Skill",
      description: "Skill fixture for the agents tab",
      tags: ["e2e"],
    }),
  ).toMatchObject({ status: 200 });
  expect(
    await hub.api("POST", "/api/agents", {
      slug: "e2e-browser-agent",
      name: "E2E Browser Agent",
      description: "Created as an agent fixture",
      skillSlugs: ["e2e-skill"],
      tools: ["shell"],
      tags: ["e2e"],
    }),
  ).toMatchObject({ status: 200 });
  expect(
    await hub.api("POST", "/api/knowledge", {
      slug: "e2e-knowledge",
      title: "E2E Knowledge",
      body: "Knowledge fixture for the knowledge tab",
      tags: ["e2e"],
    }),
  ).toMatchObject({ status: 200 });

  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#agents/skills`);
  await expect(page.locator("nav.tabs .tab.active")).toContainText("Skills", {
    timeout: 10_000,
  });
  await expect(page.locator("#skills-e2e-skill")).toContainText("E2E Skill");

  await page.goto(`${hub.baseURL}/app#agents/knowledge`);
  await expect(page.locator("nav.tabs .tab.active")).toContainText("Knowledge", {
    timeout: 10_000,
  });
  await expect(page.locator("#knowledge-e2e-knowledge")).toContainText("E2E Knowledge");

  await page.goto(`${hub.baseURL}/app#agents/agents`);
  await expect(page.locator("nav.tabs .tab.active")).toContainText("Agents", {
    timeout: 10_000,
  });
  const agentCard = page.locator("#agents-e2e-browser-agent");
  await expect(agentCard).toBeVisible({ timeout: 10_000 });
  await expect(agentCard).toContainText("Created as an agent fixture");
  await expect(agentCard).toContainText("e2e-skill");

  await agentCard.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#editor")).toBeVisible();
  const current = JSON.parse(await page.locator("#item-json").inputValue());
  current.description = "Edited from the browser";
  current.tools.push("api");
  await page.fill("#item-json", JSON.stringify(current, null, 2));
  await page.getByRole("button", { name: "Save" }).click();

  await expect(agentCard).toContainText("Edited from the browser", {
    timeout: 10_000,
  });
  await expect(agentCard).toContainText("api");
});
