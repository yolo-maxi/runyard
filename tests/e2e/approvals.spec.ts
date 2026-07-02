import { test, expect } from "./fixtures";
import { fakeRunner } from "./fakeRunner";

/**
 * Approval-gated run lifecycle e2e.
 *
 * GOTCHA (load-bearing): every SEED capability uses approvalPolicy {required:true|false},
 * but the run-start gate (db.js approvalPolicyRequiresRunStartApproval) only fires on
 * runStartApproval/requireRunStartApproval/workflowStartApproval === true. So NO seed
 * capability (implement/improve/etc.) ever produces a waiting_approval run — they all go
 * straight to queued. To deterministically exercise the approval gate we first CREATE a
 * capability whose approvalPolicy has runStartApproval:true (admin scope), then run that.
 *
 * Approve path: create gated cap -> create run (waiting_approval) -> approval pending ->
 * approve -> run becomes queued -> fake runner claims & drives it to succeeded.
 * Reject path (request-changes): rejecting/requesting-changes cancels the run.
 */

/** Create a capability that gates at run start so a fresh run lands waiting_approval. */
async function createGatedCapability(hub: any, slug: string) {
  const res = await hub.api("POST", "/api/capabilities", {
    slug,
    name: `E2E Gated (${slug})`,
    description: "Approval-gated capability for e2e",
    requiredRunnerTags: ["smithers"],
    approvalPolicy: { runStartApproval: true, reason: "e2e gate" },
    // Opt OUT of supervision wrapping: a smithers-engine capability is otherwise
    // wrapped into a 'run-smithers' supervisor run (decideSupervision -> action
    // "wrap"), which has no run-start gate and lands queued — defeating the test.
    supervision: { default: false },
    workflow: { engine: "smithers", entry: ".smithers/workflows/hello.tsx" },
    inputSchema: { type: "object" },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.capability;
}

/** Log into the SPA at /app with the admin token and wait for the shell. */
async function login(page: any, hub: any) {
  await page.goto(`${hub.baseURL}/app`);
  await page.waitForSelector("#login:not(.hidden)", { timeout: 10_000 });
  await page.fill("#token", hub.adminToken);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#app:not(.hidden)", { timeout: 10_000 });
  await expect(page.locator("#login")).toHaveCount(0);
}

test("approval-gated run: pending approval surfaces, approve unblocks run -> runner drives to succeeded", async ({
  hub,
  page,
}) => {
  const slug = "e2e-gated-approve";
  await createGatedCapability(hub, slug);

  // Create a run for the gated capability -> lands waiting_approval (NOT queued).
  const created = await hub.api("POST", `/api/capabilities/${slug}/run`, { input: {} });
  expect(created.status).toBe(202);
  const runId: string = created.body.run.id;
  expect(runId).toBeTruthy();
  expect(created.body.run.status).toBe("waiting_approval");

  // A pending approval was created and linked to this run.
  const pending = await hub.api("GET", "/api/approvals?status=pending");
  expect(pending.status).toBe(200);
  const approval = (pending.body.approvals || []).find((a: any) => a.runId === runId);
  expect(approval, "expected a pending approval for the gated run").toBeTruthy();
  const approvalId: string = approval.id;

  // --- UI: log in ---
  await login(page, hub);

  // The approvals nav badge reflects the pending approval count. refreshSidebarBadges()
  // runs on boot (and every 30s) and toggles the hidden attr + textContent on the
  // mobile-primary-nav badge. Since the approval existed before login, the boot refresh
  // populates it. Assert it shows the pending count without any page.reload().
  const navBadge = page.locator('.mobile-primary-nav [data-badge="approvals"]');
  await expect(navBadge).toHaveText("1", { timeout: 10_000 });

  // --- UI: open the Approvals view (no sidebar button — navigate by hash) ---
  await page.goto(`${hub.baseURL}/app#approvals`);
  const card = page.locator(".approval-card").filter({ hasText: approval.title });
  await expect(card).toBeVisible({ timeout: 10_000 });
  // The card exposes its pending status + an inline Approve button.
  await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();

  // --- UI: open the approval detail and approve it ---
  await page.goto(`${hub.baseURL}/app#approvals/${approvalId}`);
  const approveBtn = page.getByRole("button", { name: "Approve" });
  await expect(approveBtn).toBeVisible({ timeout: 10_000 });
  await approveBtn.click();

  // Detail re-renders to the resolved state: the Approve button is gone and the
  // resolved banner reads "Approved".
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".approval-resolved")).toContainText(/approved/i, {
    timeout: 10_000,
  });

  // --- Server: approving moved the run waiting_approval -> queued ---
  await expect
    .poll(
      async () => (await hub.api("GET", `/api/runs/${runId}`)).body.run.status,
      { timeout: 10_000 },
    )
    .toBe("queued");

  // --- A fake runner now claims the (newly) queued run and drives it to succeeded ---
  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
  await runner.claimAndRun(runId, {
    output: { smithersRunId: "run-approved", outputs: { hello: { answer: "approved & done" } } },
  });

  // --- UI: the run detail now reflects the proceeded/terminal success state ---
  // (Run detail is a one-shot fetch on render — navigate to it fresh, do NOT reload.)
  await page.goto(`${hub.baseURL}/app#runs/${runId}`);
  const banner = page.locator('header.run-banner[data-status="succeeded"]');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner.locator(".run-banner-status .status")).toContainText("succeeded");
});

test("approval-gated run: reject (request changes) cancels the run", async ({ hub, page }) => {
  const slug = "e2e-gated-reject";
  await createGatedCapability(hub, slug);

  const created = await hub.api("POST", `/api/capabilities/${slug}/run`, { input: {} });
  expect(created.status).toBe(202);
  const runId: string = created.body.run.id;
  expect(created.body.run.status).toBe("waiting_approval");

  const pending = await hub.api("GET", "/api/approvals?status=pending");
  const approval = (pending.body.approvals || []).find((a: any) => a.runId === runId);
  expect(approval, "expected a pending approval for the gated run").toBeTruthy();
  const approvalId: string = approval.id;

  await login(page, hub);

  // Open the approval detail; the UI exposes a "Request changes" control alongside Reject.
  await page.goto(`${hub.baseURL}/app#approvals/${approvalId}`);
  const requestChanges = page.getByRole("button", { name: "Request changes" });
  await expect(requestChanges).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("Decision note").fill("Please adjust the inputs before running.");
  await requestChanges.click();

  // Detail re-renders resolved: decision controls gone, resolved banner present.
  await expect(page.getByRole("button", { name: "Request changes" })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".approval-resolved")).toBeVisible({ timeout: 10_000 });

  // --- Server: request-changes stores approval status 'rejected' and cancels the run ---
  await expect
    .poll(
      async () => (await hub.api("GET", `/api/runs/${runId}`)).body.run.status,
      { timeout: 10_000 },
    )
    .toBe("cancelled");

  const resolvedApproval = await hub.api("GET", `/api/approvals/${approvalId}`);
  expect(resolvedApproval.body.approval.status).toBe("rejected");
  expect(resolvedApproval.body.approval.decision).toBe("changes_requested");

  // --- UI: the run detail reflects the cancelled state (fresh navigation, no reload) ---
  await page.goto(`${hub.baseURL}/app#runs/${runId}`);
  const banner = page.locator('header.run-banner[data-status="cancelled"]');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner.locator(".run-banner-status .status")).toContainText("cancelled");
});
