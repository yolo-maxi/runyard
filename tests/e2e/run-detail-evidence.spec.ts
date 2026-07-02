import { test, expect } from "./fixtures";
import { fakeRunner, type RunEvent } from "./fakeRunner";

/**
 * Spec key: "run-detail-evidence".
 *
 * Drives runs to completion via the fake-runner HTTP lifecycle (no real
 * smithers) and asserts the run-detail page renders its "evidence" sections:
 *   - events / timeline (the full run-log timeline list)
 *   - log summary (the structured totals: events/errors/warnings/highlights)
 *   - diagnostics (the failure diagnostics panel — only emitted for non-success
 *     statuses, so exercised on a deliberately failed run)
 *   - artifacts (the uploaded artifact listed, with a working download link)
 *   - meta fields (status banner, capability link, Started/Ended/Duration)
 *
 * It also proves the runs-LIST live-update safety net: a queued run that
 * transitions to succeeded server-side updates the in-place progress strip
 * WITHOUT a page reload (the 4s pollActiveRunProgress swap).
 */

/** Log into the SPA at /app with the admin token (full reload after token-login). */
async function login(page: import("@playwright/test").Page, hub: { baseURL: string; adminToken: string }) {
  await page.goto(`${hub.baseURL}/app`);
  await page.waitForSelector("#login:not(.hidden)", { timeout: 10_000 });
  await page.fill("#token", hub.adminToken);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#app:not(.hidden)", { timeout: 10_000 });
}

// A realistic-looking event sequence a smithers runner emits over a run's life.
const HAPPY_EVENTS: RunEvent[] = [
  { type: "runner.started", message: "Executing workflow" },
  { type: "workflow.step", message: "planning", data: { node: "plan" } },
  { type: "agent.summary", message: "Drafted approach", data: { node: "plan" } },
  { type: "workflow.step", message: "implementing", data: { node: "build" } },
  { type: "runner.progress", message: "Working on the change" },
  { type: "workflow.step", message: "verifying", data: { node: "verify" } },
  { type: "runner.completed", message: "Workflow finished" },
];

test("succeeded run detail renders timeline, log summary, artifact (with download), and meta", async ({
  hub,
  page,
}) => {
  // --- Create a no-approval 'hello' run -> lands queued. ---
  const created = await hub.api("POST", "/api/capabilities/hello/run", {
    input: { topic: "run-detail-evidence" },
  });
  expect(created.status).toBe(202);
  const runId: string = created.body.run.id;
  expect(runId).toBeTruthy();

  // --- Drive it queued -> assigned -> running via the fake runner. ---
  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
  let claimed = false;
  for (let i = 0; i < 20; i++) {
    await runner.heartbeat(runId);
    const next = await runner.claimNextRun();
    if (next?.run?.id === runId) {
      claimed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(claimed).toBe(true);
  await runner.start(runId);
  await runner.emitMany(runId, HAPPY_EVENTS);

  // --- Upload an artifact (POST /api/runs/:id/artifacts is supported). ---
  const artifactName = "smithers-output.json";
  const artifactBody = JSON.stringify({ ok: true, greeting: "hi there" });
  const uploaded = await hub.api("POST", `/api/runs/${runId}/artifacts`, {
    name: artifactName,
    mimeType: "application/json",
    content: artifactBody,
  });
  expect(uploaded.status).toBe(200);
  const artifactId: string = uploaded.body.artifact.id;
  expect(artifactId).toBeTruthy();
  expect(uploaded.body.artifact.sizeBytes).toBe(artifactBody.length);

  // --- Complete the run -> succeeded. ---
  await runner.complete(runId, {
    smithersRunId: "run-evidence",
    outputs: { hello: { greeting: "hi there" } },
  });

  const detail = await hub.api("GET", `/api/runs/${runId}`);
  expect(detail.status).toBe(200);
  expect(detail.body.run.status).toBe("succeeded");
  // Sanity: the GET /api/runs/:id evidence payload is fully populated.
  expect((detail.body.events || []).length).toBeGreaterThan(0);
  expect(detail.body.logSummary).toBeTruthy();
  expect((detail.body.artifacts || []).some((a: any) => a.id === artifactId)).toBe(true);

  // --- UI: open the run detail. ---
  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#runs/${runId}`);

  // META: status banner reflects success, capability link present.
  const banner = page.locator('header.run-banner[data-status="succeeded"]');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner.locator(".run-banner-status .status")).toContainText("succeeded");
  await expect(banner.locator("a.run-cap-link")).toBeVisible();
  // META: the timing strip (Started/Ended/Duration) renders above the fold.
  const metaStrip = page.locator("ul.run-meta-strip");
  await expect(metaStrip).toBeVisible();
  await expect(metaStrip).toContainText("Started");
  await expect(metaStrip).toContainText("Ended");
  await expect(metaStrip).toContainText("Duration");

  // EVENTS / TIMELINE: the full timeline lists the emitted events.
  const logPanel = page.locator('details.run-section[data-run-section="log"]');
  await expect(logPanel).toBeAttached();
  // The log section may render collapsed depending on stored prefs/status — open
  // it so its body (timeline + totals) is reliably visible.
  await logPanel.evaluate((el) => ((el as HTMLDetailsElement).open = true));
  const timeline = logPanel.locator(".run-log-list");
  await expect(timeline).toBeVisible();
  const timelineRows = timeline.locator("li.run-log-event");
  // We emitted HAPPY_EVENTS plus the runner adds lifecycle events; assert the
  // ones we know are ours surface in the timeline.
  await expect(timelineRows.first()).toBeVisible();
  expect(await timelineRows.count()).toBeGreaterThanOrEqual(HAPPY_EVENTS.length);
  await expect(timeline.locator("code.run-log-type", { hasText: "runner.started" }).first()).toBeVisible();
  await expect(timeline.locator("code.run-log-type", { hasText: "runner.completed" }).first()).toBeVisible();

  // LOG SUMMARY: the structured totals (events/errors/warnings/highlights).
  const totals = logPanel.locator("dl.run-log-totals");
  await expect(totals).toBeVisible();
  await expect(totals).toContainText("events");
  await expect(totals).toContainText("highlights");

  // ARTIFACTS: the uploaded artifact is listed with a working download link.
  const artifactsPanel = page.locator('details.run-section[data-run-section="artifacts"]');
  await expect(artifactsPanel).toBeAttached();
  // The section may render collapsed depending on stored prefs — open it so the
  // body (and its links) are reliably visible.
  await artifactsPanel.evaluate((el) => ((el as HTMLDetailsElement).open = true));
  const artifactRow = artifactsPanel.locator(`li.artifact-row#artifact-${artifactId}`);
  await expect(artifactRow).toBeVisible();
  await expect(artifactRow.locator(".artifact-row-name")).toContainText(artifactName);
  const downloadLink = artifactRow.locator(`a[href="/api/artifacts/${artifactId}/download"]`).first();
  await expect(downloadLink).toBeVisible();

  // Verify the download link actually serves the artifact content (authn via
  // the session cookie the SPA already set on login).
  const dl = await page.request.get(`${hub.baseURL}/api/artifacts/${artifactId}/download`);
  expect(dl.status()).toBe(200);
  expect(await dl.text()).toBe(artifactBody);
});

test("failed run detail renders the diagnostics panel with a failure timeline", async ({ hub, page }) => {
  const created = await hub.api("POST", "/api/capabilities/hello/run", {
    input: { topic: "run-detail-evidence-failure" },
  });
  expect(created.status).toBe(202);
  const runId: string = created.body.run.id;

  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
  let claimed = false;
  for (let i = 0; i < 20; i++) {
    await runner.heartbeat(runId);
    const next = await runner.claimNextRun();
    if (next?.run?.id === runId) {
      claimed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(claimed).toBe(true);
  await runner.start(runId);
  await runner.emitMany(runId, [
    { type: "runner.started", message: "Executing workflow" },
    { type: "workflow.step", message: "implementing", data: { node: "build" } },
    { type: "error", message: "Build failed: type error in src/foo.ts" },
  ]);
  await runner.fail(runId, "smithers run ended in state 'failed'");

  const detail = await hub.api("GET", `/api/runs/${runId}`);
  expect(detail.body.run.status).toBe("failed");
  // Diagnostics are only emitted for non-success statuses; confirm the API
  // populated the diagnostics object before asserting the UI panel.
  expect(detail.body.diagnostics).toBeTruthy();

  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#runs/${runId}`);

  // META: banner reflects the failure.
  const banner = page.locator('header.run-banner[data-status="failed"]');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toHaveAttribute("data-failure", "1");

  // DIAGNOSTICS: the dedicated diagnostics panel renders with a timeline of the
  // events leading up to the failure.
  const diagPanel = page.locator("section.diagnostics-panel");
  await expect(diagPanel).toBeVisible();
  const diagTimeline = diagPanel.locator("ol.diagnostics-event-list");
  await expect(diagTimeline).toBeVisible();
  await expect(diagTimeline.locator("li").first()).toBeVisible();
  // The failure reason surfaces in the panel.
  await expect(diagPanel).toContainText(/failed/i);
});

test("runs list row updates to succeeded WITHOUT a page reload (live poll)", async ({
  hub,
  page,
}) => {
  // Create a run and leave it queued so the list paints it as still-pending.
  const created = await hub.api("POST", "/api/capabilities/hello/run", {
    input: { topic: "run-detail-evidence-live" },
  });
  expect(created.status).toBe(202);
  const runId: string = created.body.run.id;

  // Register (and heartbeat) a runner so it is online and claimable, but do NOT
  // drive the run yet — we want the list to first render the active strip.
  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
  await runner.heartbeat(null);

  await login(page, hub);
  // Navigate explicitly to the runs list (avoids the fresh-tenant onboarding
  // redirect; there is already a run so it won't trigger anyway).
  await page.goto(`${hub.baseURL}/app#runs`);

  // The queued run renders in the live runs list.
  const row = page.locator(`article#run-${runId}`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.locator(".run-history-status .status")).toContainText("queued");

  // Drive the run to terminal success server-side (no page interaction).
  let claimed = false;
  for (let i = 0; i < 20; i++) {
    await runner.heartbeat(runId);
    const next = await runner.claimNextRun();
    if (next?.run?.id === runId) {
      claimed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(claimed).toBe(true);
  await runner.start(runId);
  await runner.emitMany(runId, HAPPY_EVENTS);
  await runner.complete(runId, { ok: true });

  // LIVE-UPDATE ASSERTION (no page.reload()): the runs collection refetches and
  // the row flips from queued to succeeded on its own.
  await expect(row.locator(".run-history-status .status")).toContainText("succeeded", {
    timeout: 15_000,
  });
});
