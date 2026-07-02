import { test, expect } from "./fixtures";
import { fakeRunner } from "./fakeRunner";

/**
 * Spec: "workflows-capabilities"
 *
 * Characterizes the Workflows/Capabilities view of the Hub SPA:
 *  - the #workflows list renders a card per seeded capability (hello, research,
 *    implement, …) with a launch/run affordance;
 *  - opening a capability renders its detail (description, input schema via the
 *    run form + contract JSON, and recent runs);
 *  - the Code tab fetches GET /api/capabilities/:id/source and renders
 *    syntax-highlighted code (an hljs <code> block);
 *  - the launch/run affordance reveals the inline run form.
 *
 * All run state is driven through the fake-runner HTTP lifecycle (no real
 * smithers). Live (no-reload) update assertions exercise the workflow Runs-tab
 * progress-strip poll.
 */

/** Log into the SPA with the admin token and wait for the app shell. */
async function login(page: import("@playwright/test").Page, hub: { baseURL: string; adminToken: string }) {
  await page.goto(`${hub.baseURL}/app`);
  await page.waitForSelector("#login:not(.hidden)", { timeout: 10_000 });
  await page.fill("#token", hub.adminToken);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#app:not(.hidden)", { timeout: 10_000 });
}

test("workflows list shows seeded capabilities with a run affordance", async ({ hub, page }) => {
  await login(page, hub);

  await page.goto(`${hub.baseURL}/app#workflows`);

  // The grid renders one workflow-card per seeded capability.
  await expect(page.locator("article.workflow-card").first()).toBeVisible({ timeout: 10_000 });

  // The known seed capabilities each have a card keyed by slug.
  for (const slug of ["hello", "research", "implement"]) {
    const card = page.locator(`article.workflow-card#workflow-${slug}`);
    await expect(card).toBeVisible();
    // Launch/run affordance is present on every card.
    await expect(card.getByRole("button", { name: /Run$/ })).toBeVisible();
    // And the title links into the detail view.
    await expect(card.locator(`h3 a[href="#workflows/${slug}"]`)).toBeVisible();
  }

  // Sanity: the seed set is non-trivial (more than the three we assert by name).
  const cardCount = await page.locator("article.workflow-card").count();
  expect(cardCount).toBeGreaterThanOrEqual(3);
});

test("opening a capability shows its detail: description, input schema, recent runs", async ({ hub, page }) => {
  // Seed one completed run so the detail's "recent runs" surfaces a real run.
  const created = await hub.api("POST", "/api/capabilities/hello/run", {
    input: { topic: "detail view" },
  });
  expect(created.status).toBe(202);
  const runId: string = created.body.run.id;
  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
  await runner.claimAndRun(runId, {
    output: { smithersRunId: "run-detail", outputs: { hello: { answer: "hi" } } },
  });
  const settled = await hub.api("GET", `/api/runs/${runId}`);
  expect(settled.body.run.status).toBe("succeeded");

  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#workflows/hello`);

  // Detail header + description.
  await expect(page.locator("nav.tabs.workflow-tabs")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("p.workflow-detail-desc")).toContainText("Smithers");

  // Recent runs surface on the overview side rail (Latest runs). Our completed
  // run id is linked from the runs list.
  await expect(page.locator(`#panel-wf-side a[href="#runs/${runId}"]`).first()).toBeVisible();

  // Input schema is exposed via the "Workflow contract (JSON)" details. The
  // hello schema requires a "topic" string property.
  const contract = page.locator('#panel-wf-detail details.advanced');
  await contract.locator("summary").click();
  await expect(contract).toContainText("inputSchema");
  await expect(contract).toContainText("topic");

  // The Code/Run tabs exist (deep-linkable workflow sections).
  await expect(page.locator('a.tab[data-wf-tab="code"]')).toBeVisible();
  await expect(page.locator("#wf-run")).toBeVisible();
});

test("viewing a capability source renders syntax-highlighted code", async ({ hub, page }) => {
  // Confirm the source endpoint actually ships code for hello.
  const source = await hub.api("GET", "/api/capabilities/hello/source");
  expect(source.status).toBe(200);
  expect(source.body.available).toBe(true);
  expect(typeof source.body.code).toBe("string");
  expect(source.body.code.length).toBeGreaterThan(0);

  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#workflows/hello/code`);

  // The Code tab fetches /api/capabilities/hello/source and renders a
  // <pre class="workflow-code"><code class="hljs ..."> block.
  const codeBlock = page.locator("#wf-code-host pre.workflow-code code");
  await expect(codeBlock).toBeVisible({ timeout: 10_000 });
  // hljs class is applied (highlight target), and the source text rendered.
  await expect(codeBlock).toHaveClass(/hljs/);
  await expect(codeBlock).not.toBeEmpty();

  // The path/meta line reflects the loaded source file.
  await expect(page.locator("#wf-code-path")).toContainText(".tsx", { timeout: 10_000 });

  // Syntax highlighting produces inner token spans once highlight.js runs.
  await expect
    .poll(async () => codeBlock.locator("span.hljs-keyword, span[class^='hljs-']").count(), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
});

test("launch affordance on a capability reveals the inline run form", async ({ hub, page }) => {
  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#workflows`);

  const card = page.locator("article.workflow-card#workflow-hello");
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Click the card's run button -> routes to #workflows/hello/run -> showRunForm.
  await card.getByRole("button", { name: /Run$/ }).click();
  await expect(page).toHaveURL(/#workflows\/hello\/run$/);

  // The inline run form appears with the schema-driven "topic" field.
  await expect(page.locator("#run-form")).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator("#run-form label").filter({ hasText: "topic" }).locator("input, textarea, select").first(),
  ).toBeVisible();
  await expect(page.locator('#run-form button[type="submit"]')).toBeVisible();
});

test("workflow runs tab live-updates a run's progress strip without a reload", async ({ hub, page }) => {
  // Create a hello run but DO NOT drive it yet; it stays queued (active).
  const created = await hub.api("POST", "/api/capabilities/hello/run", {
    input: { topic: "live strip" },
  });
  expect(created.status).toBe(202);
  const runId: string = created.body.run.id;
  expect(created.body.run.status).toBe("queued");

  await login(page, hub);
  await page.goto(`${hub.baseURL}/app#workflows/hello/runs`);

  // The active run's progress strip is present on the runs tab.
  const strip = page.locator(`[data-run-progress="${runId}"]`);
  await expect(strip).toBeVisible({ timeout: 10_000 });

  // While the page sits on the runs tab (4s pollActiveRunProgress), drive the
  // run server-side through to success via the fake runner.
  const runner = await fakeRunner(hub, { tags: ["smithers", "local"] });
  await runner.claimAndRun(runId, {
    output: { smithersRunId: "run-live", outputs: { hello: { answer: "done" } } },
  });

  // WITHOUT page.reload(): the strip's outcome phase flips to a terminal "ok"
  // state once the 4s poll swaps the strip in place (node.replaceWith).
  // We assert the polling-driven DOM change directly.
  await expect(
    page.locator(`[data-run-progress="${runId}"] .run-progress-phase[data-phase="outcome"].phase-ok`),
  ).toHaveClass(/phase-ok/, { timeout: 20_000 });
});
