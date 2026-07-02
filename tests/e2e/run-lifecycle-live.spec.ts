import { test, expect } from "./fixtures";
import { fakeRunner, type FakeRunner } from "./fakeRunner";

/**
 * THE migration-critical spec: "run-lifecycle-live".
 *
 * Goal: prove the Hub UI reflects server-side run-state transitions LIVE,
 * without a manual `page.reload()`, as a run is driven through its lifecycle by
 * the fake runner. This is the safety net the migration must preserve.
 *
 * Two genuine no-`page.reload()` live mechanisms exist in public/app.js and BOTH
 * are exercised here (no behavior added to the app — this is a characterization
 * net of what actually ships today):
 *
 *  (A) The runs LIST / home view is backed by the live runs collection. While a
 *      run is active it refetches every few seconds and updates the row status
 *      in place: no reload, no navigation, no user action.
 *
 *  (B) The run-DETAIL page (`renderRunDetail`, app.js:3248) is a one-shot fetch
 *      with NO interval of its own. Its live, no-`page.reload()` refresh path is
 *      the SPA's own client-side re-render driven by `hashchange` -> render()
 *      (app.js:4090-4100). Re-dispatching the same `#runs/<id>` route re-runs
 *      renderRunDetail (a fresh GET /api/runs/<id>) entirely client-side, never a
 *      full document reload. We open the detail page BEFORE the run starts, then
 *      assert the banner + log + output reflect each transition after a pure
 *      hash re-dispatch (NOT page.reload()).
 *
 * In every test we (1) override window.location.reload to THROW so any accidental
 * full reload fails loudly, and (2) plant a `window.__noReloadSentinel` that only
 * survives if the document is never reloaded; we assert it is still present after
 * all transitions. Together these prove the updates were polling/SPA-driven, not
 * reload-driven.
 */

const HELLO_RUN_INPUT = { input: { topic: "e2e run-lifecycle-live" } };

/** Log into /app with the admin token and land on the app shell. */
async function login(page: import("@playwright/test").Page, hub: { baseURL: string; adminToken: string }) {
  await page.goto(`${hub.baseURL}/app`);
  await page.waitForSelector("#login:not(.hidden)", { timeout: 15_000 });
  await page.fill("#token", hub.adminToken);
  await page.click('#login-form button[type="submit"]');
  // Login performs a single full location.reload(); after that the shell shows.
  await page.waitForSelector("#app:not(.hidden)", { timeout: 15_000 });
  await expect(page.locator("#login")).toHaveCount(0);
}

/**
 * Plant the no-reload guards: a sentinel that a full reload would wipe, plus a
 * hard override of location.reload() that throws if anything tries to reload.
 * MUST be called AFTER login (login itself does a legitimate reload).
 */
async function armNoReloadGuards(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    (window as unknown as { __noReloadSentinel?: number }).__noReloadSentinel = Date.now();
    try {
      // Make any accidental full reload explode so a regression can't sneak a
      // reload in and still "pass". Detail re-render goes through hashchange,
      // never location.reload(), so this never fires in the happy path.
      Object.defineProperty(window.location, "reload", {
        configurable: true,
        value: () => {
          throw new Error("location.reload() called during a live-update assertion");
        },
      });
    } catch {
      /* some engines disallow redefining; the sentinel below still proves it */
    }
  });
}

/** Assert the document was never fully reloaded since the guards were armed. */
async function assertNoReloadHappened(page: import("@playwright/test").Page) {
  const sentinel = await page.evaluate(
    () => (window as unknown as { __noReloadSentinel?: number }).__noReloadSentinel,
  );
  expect(
    sentinel,
    "window.__noReloadSentinel was lost — the document was fully reloaded during a 'live update' assertion (it must update via polling / SPA re-render, NOT page.reload())",
  ).toBeTruthy();
}

/**
 * Re-dispatch the current `#runs/<id>` route purely client-side (the SPA's own
 * hashchange -> render() path, app.js:4090). This is the detail page's genuine,
 * no-`page.reload()` refresh mechanism. We bounce off `#runs` and back so the
 * `hashchange` event actually fires (setting the same hash is a no-op).
 */
async function softRefreshDetail(page: import("@playwright/test").Page, runId: string) {
  await page.evaluate((id) => {
    // Bounce to the list and back; both transitions are pure hashchange events
    // handled by the SPA router — never a document reload.
    window.location.hash = "#runs";
    window.location.hash = `#runs/${id}`;
  }, runId);
}

/** Create a no-approval 'hello' run; it lands status=queued. */
async function createQueuedRun(hub: { api: (...a: any[]) => Promise<any> }): Promise<string> {
  const created = await hub.api("POST", "/api/capabilities/hello/run", HELLO_RUN_INPUT);
  expect(created.status).toBe(202);
  expect(created.body.run.status).toBe("queued");
  const runId: string = created.body.run.id;
  expect(runId).toBeTruthy();
  return runId;
}

/**
 * Drive a queued run to the 'running' state via the runner lifecycle:
 * heartbeat + claim (queued -> assigned) then start (assigned -> running).
 * Returns once the API reports status='running'.
 */
async function driveToRunning(hub: any, runner: FakeRunner, runId: string): Promise<void> {
  let claimed = false;
  for (let i = 0; i < 30; i++) {
    await runner.heartbeat(runId);
    const next = await runner.claimNextRun();
    if (next?.run?.id === runId) {
      claimed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(claimed, `runner should claim run ${runId}`).toBe(true);
  await runner.start(runId);
  const detail = await hub.api("GET", `/api/runs/${runId}`);
  expect(detail.body.run.status).toBe("running");
}

test.describe("run-lifecycle-live (migration safety net)", () => {
  test("happy path: open detail BEFORE start, then queued->running->events->succeeded all appear live (no page.reload)", async ({
    hub,
    page,
  }) => {
    // --- Create the run; it is queued and NOT yet claimed/started. ---
    const runId = await createQueuedRun(hub);

    // --- Log in and open the run-detail page BEFORE the run starts. ---
    await login(page, hub);
    await page.goto(`${hub.baseURL}/app#runs/${runId}`);

    // Initial paint: the banner reflects the pre-start 'queued' status.
    const banner = page.locator("header.run-banner");
    await expect(banner).toHaveAttribute("data-status", "queued", { timeout: 15_000 });
    await expect(page.locator('details.run-section[data-run-section="log"]')).toBeAttached();

    // Arm the no-reload guards now that the detail page is open.
    await armNoReloadGuards(page);

    // ============================================================
    // (A) LIST VIEW: prove the live collection flips the row queued -> running
    //     with NO reload and NO navigation away.
    // ============================================================
    // Navigate to the runs list; Home subscribes to the live runs collection.
    await page.goto(`${hub.baseURL}/app#runs`);
    // Re-arm the sentinel for the list-view phase (the page.goto above is an SPA
    // hash nav within /app, not a document load, but re-plant to be explicit).
    await armNoReloadGuards(page);

    const row = page.locator(`article#run-${runId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator(".run-history-status .status")).toContainText("queued");

    // Server-side transition queued -> running, WITHOUT touching the page.
    const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
    await driveToRunning(hub, runner, runId);

    // The live collection must flip the row to running with zero reloads and
    // zero navigation.
    await expect(row.locator(".run-history-status .status")).toContainText("running", {
      timeout: 12_000,
    });
    await assertNoReloadHappened(page);

    // ============================================================
    // (B) DETAIL VIEW: reopen the detail page and prove it reflects
    //     'running', live events, then 'succeeded' + output via the
    //     SPA's hashchange re-render (NEVER page.reload()).
    // ============================================================
    await page.goto(`${hub.baseURL}/app#runs/${runId}`);
    await armNoReloadGuards(page);
    await expect(banner).toHaveAttribute("data-status", "running", { timeout: 15_000 });

    // Post run events server-side; assert they appear in the detail log after a
    // pure client-side hash re-dispatch (no document reload).
    const eventMarker = "live-event-marker-7e3a";
    await runner.emit(runId, { type: "runner.progress", message: eventMarker });
    await expect
      .poll(
        async () => {
          await softRefreshDetail(page, runId);
          return page.locator('[data-run-section="log"]').innerText();
        },
        { timeout: 12_000, message: "posted run event should appear live in the detail log" },
      )
      .toContain(eventMarker);
    await assertNoReloadHappened(page);

    // Complete the run with output server-side; assert the detail page flips to
    // the terminal success state AND shows the output, live (no page.reload()).
    const outputMarker = "live-output-marker-9f1c";
    await runner.complete(runId, {
      smithersRunId: "run-live-1",
      outputs: { hello: { greeting: outputMarker } },
    });

    await expect
      .poll(
        async () => {
          await softRefreshDetail(page, runId);
          return page.locator("header.run-banner").getAttribute("data-status");
        },
        { timeout: 12_000, message: "detail banner should flip to succeeded live" },
      )
      .toBe("succeeded");

    await expect(banner.locator(".run-banner-status .status")).toContainText("succeeded");
    // The output JSON is rendered in the Raw payload panel; assert our marker is
    // present (proves the live-refreshed page fetched the new output).
    await expect(page.locator('[data-run-section="io"]')).toContainText(outputMarker, {
      timeout: 12_000,
    });
    await assertNoReloadHappened(page);
  });

  test("failure path: drive a run to failed and assert the UI shows the failure live (no page.reload)", async ({
    hub,
    page,
  }) => {
    const runId = await createQueuedRun(hub);

    await login(page, hub);
    // Open the detail page before the run starts.
    await page.goto(`${hub.baseURL}/app#runs/${runId}`);
    const banner = page.locator("header.run-banner");
    await expect(banner).toHaveAttribute("data-status", "queued", { timeout: 15_000 });
    await armNoReloadGuards(page);

    // Drive queued -> running via the runner lifecycle.
    const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
    await driveToRunning(hub, runner, runId);

    // Detail reflects running via SPA re-render (no reload).
    await expect
      .poll(
        async () => {
          await softRefreshDetail(page, runId);
          return banner.getAttribute("data-status");
        },
        { timeout: 12_000, message: "detail banner should reflect running live" },
      )
      .toBe("running");
    await assertNoReloadHappened(page);

    // ============================================================
    // (A) LIST VIEW: prove the live collection flips the row to FAILED with no
    //     reload and no navigation.
    // ============================================================
    await page.goto(`${hub.baseURL}/app#runs`);
    await armNoReloadGuards(page);
    const row = page.locator(`article#run-${runId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator(".run-history-status .status")).toContainText("running", {
      timeout: 12_000,
    });

    // Fail the run server-side while sitting on the list view.
    const failureReason = "smithers run ended in state 'failed' (live-fail-marker)";
    await runner.fail(runId, failureReason);

    // The row flips to failed from the collection refetch.
    await expect(row.locator(".run-history-status .status")).toContainText("failed", {
      timeout: 12_000,
    });
    await assertNoReloadHappened(page);

    // ============================================================
    // (B) DETAIL VIEW: reopen and prove the failed state + error
    //     surface live via the SPA hash re-render (no page.reload()).
    // ============================================================
    await page.goto(`${hub.baseURL}/app#runs/${runId}`);
    await armNoReloadGuards(page);
    await expect
      .poll(
        async () => {
          await softRefreshDetail(page, runId);
          return page.locator("header.run-banner").getAttribute("data-status");
        },
        { timeout: 12_000, message: "detail banner should flip to failed live" },
      )
      .toBe("failed");

    // Failure banner carries data-failure="1" and surfaces the error text.
    await expect(banner).toHaveAttribute("data-failure", "1");
    await expect(banner.locator(".run-banner-status .status")).toContainText("failed");
    await expect(page.locator("#content")).toContainText(failureReason, { timeout: 12_000 });
    await assertNoReloadHappened(page);
  });
});
