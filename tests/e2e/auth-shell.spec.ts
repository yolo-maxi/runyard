import { test, expect, ADMIN_TOKEN } from "./fixtures";
import { fakeRunner } from "./fakeRunner";

/**
 * auth-shell spec — characterizes the Hub's auth gate, app shell reveal, the
 * primary hash-routed navigation, and logout.
 *
 * Auth model (see public/app.js boot/bootAuthenticated/showAuthFallback):
 *   - boot() GETs /api/me. Unauthenticated => AuthGate renders #login and does
 *     not mount #app.
 *   - Submitting #login-form POSTs /api/auth/token-login {token}; on success
 *     /api/me is invalidated and AuthGate swaps #login for #app.
 *   - A bad token => the POST rejects => a "Login failed" toast, #login stays.
 *   - #logout POSTs /api/auth/logout then location.reload() => back to #login.
 *
 * Nav: the sidebar (index.html:51-55) has data-view buttons home/workflows/agents
 *   wired to setView() (app.js:865-867) which sets location.hash and renders.
 *   Approvals has NO sidebar button — it is reached via the mobile-primary-nav
 *   link, the admin menu, or a direct #approvals hash (app.js render() :951).
 */

const APP_URL = (baseURL: string) => `${baseURL}/app`;

test("admin token const matches the fixture's bootstrap token", async ({ hub }) => {
  // Guards the harness contract: ADMIN_TOKEN === hub.adminToken.
  expect(hub.adminToken).toBe(ADMIN_TOKEN);
});

test("unauthenticated /app shows #login and hides the app shell", async ({ hub, page }) => {
  await page.goto(APP_URL(hub.baseURL));

  // App is not mounted until login: #login visible, #app absent.
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#login")).not.toHaveClass(/hidden/);
  await expect(page.locator("#app")).toHaveCount(0);

  // The token field is present and is a password input (index.html:45).
  await expect(page.locator("#token")).toHaveAttribute("type", "password");
});

test("logging in with a bad token is rejected and the app stays hidden", async ({ hub, page }) => {
  await page.goto(APP_URL(hub.baseURL));
  await expect(page.locator("#login")).toBeVisible();

  await page.fill("#token", "shub_definitely_not_a_real_token");
  await page.click('#login-form button[type="submit"]');

  // Bad token => toast error, #login stays / #app remains unmounted.
  await expect(page.locator(".toast.error")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#login")).not.toHaveClass(/hidden/);
  await expect(page.locator("#app")).toHaveCount(0);
});

test("logging in with the admin token reveals the app shell and the runs view", async ({ hub, page }) => {
  // Seed one completed run so the Runs view has a concrete run-card to anchor on.
  const created = await hub.api("POST", "/api/capabilities/hello/run", {
    input: { topic: "auth-shell runs view" },
  });
  expect(created.status).toBe(202);
  const runId: string = created.body.run.id;
  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
  await runner.claimAndRun(runId, {
    output: { smithersRunId: "run-auth", outputs: { hello: { answer: "hi" } } },
  });

  await page.goto(APP_URL(hub.baseURL));
  await expect(page.locator("#login")).toBeVisible();

  await page.fill("#token", hub.adminToken);
  await page.click('#login-form button[type="submit"]');

  // Login does a full location.reload(); the app shell becomes visible.
  await page.waitForSelector("#app:not(.hidden)", { timeout: 10_000 });
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#login")).toHaveCount(0);

  // Default landing view is Runs (home). The filter bar and sidebar Runs button
  // are active.
  await expect(page.locator("#runs-filter-bar")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.sidebar button[data-view="home"]')).toHaveClass(/active/);
  // The completed run renders as a row in the runs history.
  await expect(page.locator(`article#run-${runId}`)).toBeVisible({ timeout: 10_000 });
});

test("primary nav routes via hash and shows the right view", async ({ hub, page }) => {
  // Log in first.
  await page.goto(APP_URL(hub.baseURL));
  await expect(page.locator("#login")).toBeVisible();
  await page.fill("#token", hub.adminToken);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#app:not(.hidden)", { timeout: 10_000 });

  // --- Runs (home) ---
  // A fresh tenant (zero runners AND zero runs) auto-redirects to #onboarding
  // once per session unless the hash is exactly #runs/#home (app.js:1640-1643).
  // Click the Runs sidebar button to land deterministically on the runs view.
  await page.click('.sidebar button[data-view="home"]');
  await expect(page).toHaveURL(/#(runs|home)$/);
  await expect(page.locator("#runs-filter-bar")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.sidebar button[data-view="home"]')).toHaveClass(/active/);

  // --- Workflows ---
  await page.click('.sidebar button[data-view="workflows"]');
  await expect(page).toHaveURL(/#workflows$/);
  await expect(page.locator(".toolbar h1")).toContainText("Workflows");
  await expect(page.locator('.sidebar button[data-view="workflows"]')).toHaveClass(/active/);
  // Seeded capabilities render as workflow cards.
  await expect(page.locator("article.workflow-card").first()).toBeVisible({ timeout: 10_000 });

  // --- Agents ---
  await page.click('.sidebar button[data-view="agents"]');
  await expect(page).toHaveURL(/#agents$/);
  await expect(page.locator(".toolbar h1")).toContainText("Agents");
  await expect(page.locator('.sidebar button[data-view="agents"]')).toHaveClass(/active/);
  await expect(page.locator("nav.tabs .tab.active")).toContainText("Agents");

  // --- Approvals (no sidebar button — route via direct hash) ---
  await page.evaluate(() => { location.hash = "#approvals"; });
  await expect(page).toHaveURL(/#approvals$/);
  await expect(page.locator(".toolbar h1")).toContainText("Approvals");
  // No seeded approvals => empty-state copy, but the Approvals toolbar proves
  // we routed to renderApprovals() (app.js:3552 / approvalList :3532).
  await expect(page.locator("#content")).toContainText("No pending approvals", {
    timeout: 10_000,
  });

  // --- Back to Runs to prove round-trip routing ---
  await page.click('.sidebar button[data-view="home"]');
  await expect(page).toHaveURL(/#(runs|home)$/);
  await expect(page.locator("#runs-filter-bar")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.sidebar button[data-view="home"]')).toHaveClass(/active/);
});

test("logout returns to the login screen", async ({ hub, page }) => {
  await page.goto(APP_URL(hub.baseURL));
  await expect(page.locator("#login")).toBeVisible();
  await page.fill("#token", hub.adminToken);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#app:not(.hidden)", { timeout: 10_000 });
  await expect(page.locator("#app")).toBeVisible();

  // Logout POSTs /api/auth/logout then location.reload() (app.js:873-876).
  await page.click("#logout");

  // After reload, /api/me is unauthenticated => showAuthFallback() => #login.
  await page.waitForSelector("#login:not(.hidden)", { timeout: 10_000 });
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#app")).toHaveCount(0);

  // The session cookie is gone — a fresh /app load still lands on #login.
  await page.goto(APP_URL(hub.baseURL));
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#app")).toHaveCount(0);
});
