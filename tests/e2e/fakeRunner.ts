import type { Hub } from "./fixtures";

/**
 * A minimal, deterministic stand-in for src/smithers-runner.js that drives runs
 * through their lifecycle over HTTP without a real smithers/Claude CLI.
 *
 * It uses the EXACT runner-lifecycle endpoints:
 *   register  -> POST /api/runners/register
 *   heartbeat -> POST /api/runners/:id/heartbeat
 *   claim     -> GET  /api/runners/:id/next-run   (returns {} when nothing claimable)
 *   start     -> POST /api/runs/:id/start
 *   events    -> POST /api/runs/:id/events
 *   complete  -> POST /api/runs/:id/complete  { output }
 *   fail      -> POST /api/runs/:id/fail      { error }
 *
 * All calls use the hub's admin token by default (admin satisfies the `runner`
 * scope and bypasses run-ownership), so a single fake runner can drive any run.
 */

export interface FakeRunnerOptions {
  /** Runner tags. Must satisfy capability.requiredRunnerTags (seed caps need "smithers")
   *  and the run's execution intent (include "local"). Default: ["smithers", "local"]. */
  tags?: string[];
  name?: string;
  /** Token to authenticate as. Defaults to the admin token. */
  token?: string;
}

export interface RunEvent {
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface FakeRunner {
  /** The registered runner id (runner_...). */
  readonly id: string;
  readonly tags: string[];
  /** Send a heartbeat so the runner stays online (offline after ~30s without one). */
  heartbeat(currentRunId?: string | null): Promise<void>;
  /** Claim the next queued+matching run. Returns null when nothing is claimable. */
  claimNextRun(): Promise<{ run: any; capability: any } | null>;
  /** Transition assigned/queued -> running. */
  start(runId: string): Promise<void>;
  /** Post a run event (when type==='workflow.step' the message becomes current_step). */
  emit(runId: string, event: RunEvent): Promise<void>;
  /** Post several run events in order. */
  emitMany(runId: string, events: RunEvent[]): Promise<void>;
  /** Complete a run (running -> succeeded) with an output payload. */
  complete(runId: string, output?: Record<string, unknown>): Promise<void>;
  /** Fail a run (running -> failed) with an error string. */
  fail(runId: string, reason: string): Promise<void>;
  /**
   * Convenience: claim the run with id `runId` (polling /next-run), then drive it
   * start -> events -> complete. Throws if it cannot be claimed within `attempts`.
   */
  claimAndRun(
    runId: string,
    opts?: { events?: RunEvent[]; output?: Record<string, unknown>; attempts?: number },
  ): Promise<void>;
}

const DEFAULT_EVENTS: RunEvent[] = [
  { type: "runner.started", message: "Executing workflow" },
  { type: "workflow.step", message: "running" },
  { type: "runner.progress", message: "Working" },
];

/**
 * Register a fake runner against the hub and return helpers to drive runs.
 */
export async function fakeRunner(hub: Hub, options: FakeRunnerOptions = {}): Promise<FakeRunner> {
  const tags = options.tags ?? ["smithers", "local"];
  const token = options.token ?? hub.adminToken;
  const name = options.name ?? "fake-runner";

  const reg = await hub.api(
    "POST",
    "/api/runners/register",
    {
      name,
      hostname: "e2e-host",
      platform: "linux x",
      version: "0.2.0",
      tags,
      capacity: 4,
    },
    token,
  );
  if (!reg.ok || !reg.body?.runner?.id) {
    throw new Error(`runner register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  const id: string = reg.body.runner.id;

  async function call(method: string, path: string, body?: unknown) {
    const res = await hub.api(method, path, body, token);
    if (!res.ok) {
      throw new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body;
  }

  const runner: FakeRunner = {
    id,
    tags,
    async heartbeat(currentRunId: string | null = null) {
      await call("POST", `/api/runners/${id}/heartbeat`, {
        tags,
        capacity: 4,
        activeRuns: currentRunId ? 1 : 0,
        currentRunId,
      });
    },
    async claimNextRun() {
      const res = await hub.api("GET", `/api/runners/${id}/next-run`, undefined, token);
      if (!res.ok) {
        throw new Error(`next-run failed: ${res.status} ${JSON.stringify(res.body)}`);
      }
      if (!res.body?.run) return null;
      return { run: res.body.run, capability: res.body.capability };
    },
    async start(runId: string) {
      await call("POST", `/api/runs/${runId}/start`, {});
    },
    async emit(runId: string, event: RunEvent) {
      await call("POST", `/api/runs/${runId}/events`, {
        type: event.type,
        message: event.message ?? "",
        data: event.data ?? {},
      });
    },
    async emitMany(runId: string, events: RunEvent[]) {
      for (const ev of events) await runner.emit(runId, ev);
    },
    async complete(runId: string, output: Record<string, unknown> = { ok: true }) {
      await call("POST", `/api/runs/${runId}/complete`, { output });
    },
    async fail(runId: string, reason: string) {
      await call("POST", `/api/runs/${runId}/fail`, { error: reason });
    },
    async claimAndRun(runId, opts = {}) {
      const attempts = opts.attempts ?? 20;
      let claimed = false;
      for (let i = 0; i < attempts; i++) {
        await runner.heartbeat(runId);
        const next = await runner.claimNextRun();
        if (next?.run?.id === runId) {
          claimed = true;
          break;
        }
        // Some other run may have been claimed; if so, keep trying for ours.
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!claimed) {
        throw new Error(`fakeRunner could not claim run ${runId} within ${attempts} attempts`);
      }
      await runner.start(runId);
      await runner.emitMany(runId, opts.events ?? DEFAULT_EVENTS);
      await runner.complete(runId, opts.output ?? { ok: true, outputs: { hello: { answer: "hi" } } });
    },
  };

  return runner;
}
