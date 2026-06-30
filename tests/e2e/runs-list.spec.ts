import { test, expect } from "./fixtures";
import { fakeRunner } from "./fakeRunner";

/**
 * runs-list: characterization net for the Runs list (home) view.
 *
 * Seeds runs over HTTP (create via POST /api/capabilities/hello/run, drive to
 * terminal states with the fake runner), then asserts the runs list renders
 * cards with status badges + detail links, reflects the different statuses,
 * supports the status filter the UI exposes, and reflects a live status
 * transition WITHOUT a page reload (the 4s strip poll).
 *
 * Selectors come from public/app.js:
 *   - run cards:        article.run-card  (id #run-<id>, classes include run.status)
 *   - status badge:     article.run-card .run-card-status .status
 *   - detail link:      article.run-card .run-card-title a[href="#runs/<id>"]
 *   - progress strip:   [data-run-progress="<id>"]  (the node the poll replaces)
 *   - outcome phase:    .run-progress-phase[data-phase="outcome"]
 *   - status filter:    #runs?status=<value> (home filter; renderHome fetches
 *                       /api/runs?status=<value>)
 */

const HELLO_INPUT = { topic: "runs-list e2e" };

/** Create a 'hello' run (no approval) and return its id. Lands status=queued. */
async function createHelloRun(hub: { api: any }): Promise<string> {
  const created = await hub.api("POST", "/api/capabilities/hello/run", {
    input: HELLO_INPUT,
  });
  expect(created.status).toBe(202);
  expect(created.body.run.status).toBe("queued");
  return created.body.run.id as string;
}

/**
 * Claim a *specific* run deterministically and fail it.
 *
 * NOTE (characterization finding): claimNextRun scans the queued list
 * NEWEST-first and greedily claims the first match, so if several runs are
 * queued at once the fake runner can assign the *other* runs while polling for
 * its target — leaving them stuck in `assigned`. To stay deterministic, callers
 * must ensure the target is the only queued run when they claim it (create +
 * drive to terminal one at a time).
 */
async function claimAndFail(
  runner: any,
  runId: string,
  reason = "e2e forced failure",
) {
  let claimed = false;
  for (let i = 0; i < 20 && !claimed; i++) {
    await runner.heartbeat(runId);
    const next = await runner.claimNextRun();
    if (next?.run?.id === runId) claimed = true;
    else await new Promise((r) => setTimeout(r, 100));
  }
  if (!claimed) throw new Error(`could not claim ${runId} to fail it`);
  await runner.start(runId);
  await runner.fail(runId, reason);
}

/** Log into the SPA with the admin token and wait for the app shell. */
async function login(page: any, hub: { baseURL: string; adminToken: string }) {
  await page.goto(`${hub.baseURL}/app`);
  await page.waitForSelector("#login:not(.hidden)", { timeout: 10_000 });
  await page.fill("#token", hub.adminToken);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#app:not(.hidden)", { timeout: 10_000 });
}

test("runs list renders cards with status badges + detail links and reflects different statuses", async ({
  hub,
  page,
}) => {
  // Seed three runs that end in three distinct statuses. We create + drive them
  // ONE AT A TIME so each is the only queued run when the runner claims it
  // (claimNextRun greedily assigns whatever is queued — see claimAndFail note).
  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });

  // #1 -> succeeded
  const succeededId = await createHelloRun(hub);
  await runner.claimAndRun(succeededId, {
    output: { smithersRunId: "ok", outputs: { hello: { answer: "hi" } } },
  });

  // #2 -> failed
  const failedId = await createHelloRun(hub);
  await claimAndFail(runner, failedId);

  // #3 -> left queued (no further claims)
  const queuedId = await createHelloRun(hub);

  // Confirm terminal states via the API before asserting the UI.
  await expect
    .poll(async () => (await hub.api("GET", `/api/runs/${succeededId}`)).body.run.status)
    .toBe("succeeded");
  await expect
    .poll(async () => (await hub.api("GET", `/api/runs/${failedId}`)).body.run.status)
    .toBe("failed");

  expect((await hub.api("GET", `/api/runs/${queuedId}`)).body.run.status).toBe("queued");

  // Log in and land explicitly on the runs list (avoids the onboarding redirect).
  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#runs`);

  // Cards render for all three runs, each with a status badge + a detail link.
  for (const id of [succeededId, failedId, queuedId]) {
    const card = page.locator(`article.run-card#run-${id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".run-card-status .status")).toBeVisible();
    await expect(card.locator(`.run-card-title a[href="#runs/${id}"]`)).toBeVisible();
  }

  // The list reflects the three distinct statuses: the run-card root carries the
  // status as a class, and the badge text shows the status word.
  await expect(page.locator(`article.run-card#run-${succeededId}.succeeded`)).toBeVisible();
  await expect(page.locator(`article.run-card#run-${failedId}.failed`)).toBeVisible();
  await expect(page.locator(`article.run-card#run-${queuedId}.queued`)).toBeVisible();

  await expect(
    page.locator(`article.run-card#run-${succeededId} .run-card-status .status`),
  ).toContainText("succeeded");
  await expect(
    page.locator(`article.run-card#run-${failedId} .run-card-status .status`),
  ).toContainText("failed");
  await expect(
    page.locator(`article.run-card#run-${queuedId} .run-card-status .status`),
  ).toContainText("queued");

  // The detail link actually navigates into the run detail view.
  await page.locator(`article.run-card#run-${succeededId} .run-card-title a`).click();
  await expect(
    page.locator('header.run-banner[data-status="succeeded"]'),
  ).toBeVisible({ timeout: 10_000 });
});

test("status filter narrows the runs list to a single status", async ({ hub, page }) => {
  // One succeeded, one failed — driven one at a time (see claimAndFail note).
  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });

  const succeededId = await createHelloRun(hub);
  await runner.claimAndRun(succeededId, {
    output: { smithersRunId: "ok", outputs: { hello: { answer: "hi" } } },
  });

  const failedId = await createHelloRun(hub);
  await claimAndFail(runner, failedId);

  await expect
    .poll(async () => (await hub.api("GET", `/api/runs/${succeededId}`)).body.run.status)
    .toBe("succeeded");
  await expect
    .poll(async () => (await hub.api("GET", `/api/runs/${failedId}`)).body.run.status)
    .toBe("failed");

  await login(page, hub);

  // Filter to succeeded only via the route the UI exposes (renderHome fetches
  // /api/runs?status=succeeded). The succeeded card shows; the failed one does not.
  await page.goto(`${hub.baseURL}/app#runs?status=succeeded`);
  await expect(page.locator(`article.run-card#run-${succeededId}`)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(`article.run-card#run-${failedId}`)).toHaveCount(0);
  // The active-filter chip confirms the status filter is in effect.
  await expect(page.locator('[data-filter-chip="status"]')).toContainText("succeeded");

  // Flip the filter to failed: now only the failed card is present.
  await page.goto(`${hub.baseURL}/app#runs?status=failed`);
  await expect(page.locator(`article.run-card#run-${failedId}`)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(`article.run-card#run-${succeededId}`)).toHaveCount(0);

  // And clearing the filter (plain #runs) shows both again.
  await page.goto(`${hub.baseURL}/app#runs`);
  await expect(page.locator(`article.run-card#run-${succeededId}`)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(`article.run-card#run-${failedId}`)).toBeVisible();
});

test("?limit caps how many runs the list requests/renders", async ({ hub, page }) => {
  // Seed three runs; assert the API honors ?limit and the UI uses it.
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(await createHelloRun(hub));

  // API contract: ?limit=1 returns at most one run.
  const limited = await hub.api("GET", "/api/runs?limit=1");
  expect(limited.status).toBe(200);
  expect(limited.body.runs.length).toBe(1);
  expect(limited.body.total).toBeGreaterThanOrEqual(3);

  // The UI exposes a limit via filters (filtersActive -> limit=30). Without
  // filters the home view requests limit=100, so all three queued cards render.
  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#runs`);
  for (const id of ids) {
    await expect(page.locator(`article.run-card#run-${id}`)).toBeVisible({
      timeout: 10_000,
    });
  }
});

test("runs list reflects a status transition live, without a page reload", async ({
  hub,
  page,
}) => {
  // Seed a run and leave it queued so its card mounts with an active progress
  // strip and the home view starts the 4s pollActiveRunProgress loop.
  const runId = await createHelloRun(hub);

  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#runs`);

  // The queued run's card is active and its outcome phase is still pending.
  const card = page.locator(`article.run-card#run-${runId}`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  const strip = page.locator(`[data-run-progress="${runId}"]`);
  await expect(strip).toBeVisible();
  await expect(
    strip.locator('.run-progress-phase[data-phase="outcome"]'),
  ).toHaveClass(/phase-pending/);

  // Now drive the run to succeeded on the server AFTER the page is rendered.
  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
  await runner.claimAndRun(runId, {
    output: { smithersRunId: "ok", outputs: { hello: { answer: "hi" } } },
  });
  await expect
    .poll(async () => (await hub.api("GET", `/api/runs/${runId}`)).body.run.status)
    .toBe("succeeded");

  // LIVE ASSERTION (no page.reload(), no re-navigation): the 4s strip poll
  // (pollActiveRunProgress, app.js:1280-1317) GETs /api/runs/<id>, rebuilds the
  // strip, and replaces the [data-run-progress] <ol> in place. So the outcome
  // phase flips from phase-pending to phase-ok purely from the polling-driven
  // DOM update. We wait past the 4s cadence for the swap.
  await expect(
    page.locator(`[data-run-progress="${runId}"] .run-progress-phase[data-phase="outcome"]`),
  ).toHaveClass(/phase-ok/, { timeout: 15_000 });
  await expect(
    page.locator(`[data-run-progress="${runId}"] .run-progress-phase[data-phase="outcome"]`),
  ).not.toHaveClass(/phase-pending/);
});
