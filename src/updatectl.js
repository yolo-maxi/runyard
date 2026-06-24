#!/usr/bin/env node
// runyard update — DB/logic helper invoked by scripts/runyard-update.sh.
//
// The shell script owns the dangerous, swap-sensitive side effects (git checkout,
// pnpm install, systemctl restart) because bash re-exec'd from /tmp is robust to
// the working tree changing underneath it. This helper owns the parts that need
// the DB and the tested logic in src/selfUpdate.js: draining runners, recording
// the last-known-good marker, and writing the update outcome alert. Each
// subcommand is a short-lived process — load, do one thing, exit with a code the
// shell branches on. It never performs git/systemctl itself.
//
// Subcommands (all best-effort-safe; see exit codes):
//   drain   --grace-ms N --interval-ms M [--target TAG] [--by WHO]
//   clear-drain
//   record-last-good --tag T --commit C
//   last-good [--field tag|commit]
//   running-count
//   active-count
//   alert   --status STATUS --message MSG [--level L] [--from V] [--to V] [--title T]
//
// Exit codes: 0 ok / drained, 3 drain timed out (caller aborts), 1 usage/error.
import { env } from "./env.js";
import { countActiveRuns, countRunningRuns, recordAlert } from "./db.js";
import { drainRunners, writeLastGood, readLastGood } from "./selfUpdate.js";
import { setDrain, clearDrain } from "./drain.js";
import { createUpdateChecker } from "./updateCheck.js";
import { getVersionInfo } from "./version.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postWebhook(payload) {
  const url = env.updateNotifyWebhook;
  if (!url) return;
  if (typeof globalThis.fetch !== "function") return;
  try {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
    await globalThis.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller?.signal
    });
    if (timer) clearTimeout(timer);
  } catch {
    // Operator's own webhook being down must never fail the update.
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case "drain": {
      const graceMs = Number(args["grace-ms"] || env.drainGraceMs);
      const intervalMs = Number(args["interval-ms"] || 5000);
      const result = await drainRunners({
        getActiveCount: () => countActiveRuns(),
        setDrain: () =>
          setDrain(env.dataDir, {
            reason: "update",
            targetTag: args.target || "",
            setBy: args.by || "runyard-update"
          }),
        clearDrain: () => clearDrain(env.dataDir),
        graceMs,
        intervalMs,
        sleep,
        log: (msg) => console.log(msg)
      });
      if (result.drained) {
        console.log("drained");
        process.exit(0);
      }
      console.error(`drain timed out: ${result.active} active run(s) after ${graceMs}ms (flag cleared)`);
      process.exit(3);
      break;
    }

    case "clear-drain": {
      clearDrain(env.dataDir);
      console.log("drain flag cleared");
      process.exit(0);
      break;
    }

    case "record-last-good": {
      const record = writeLastGood(env.dataDir, { tag: args.tag || "", commit: args.commit || "" });
      console.log(JSON.stringify(record));
      process.exit(0);
      break;
    }

    case "last-good": {
      const record = readLastGood(env.dataDir);
      if (!record) process.exit(2);
      if (args.field === "tag") console.log(record.tag || "");
      else if (args.field === "commit") console.log(record.commit || "");
      else console.log(JSON.stringify(record));
      process.exit(0);
      break;
    }

    case "running-count": {
      console.log(String(countRunningRuns()));
      process.exit(0);
      break;
    }

    case "active-count": {
      console.log(String(countActiveRuns()));
      process.exit(0);
      break;
    }

    case "check": {
      // Passive CHECK only (used by the installer's update-check timer). Outbound
      // GitHub Releases read; prints the result to stdout/journal and exits.
      // Never installs anything. Disabled => exits 0 with a note.
      if (!env.updateCheckEnabled) {
        console.log(JSON.stringify({ status: "disabled" }));
        process.exit(0);
      }
      const checker = createUpdateChecker({
        repo: env.githubRepo,
        currentVersion: getVersionInfo().version
      });
      const result = await checker.check(true);
      console.log(
        JSON.stringify({
          current: result.current,
          latest: result.latest,
          updateAvailable: result.updateAvailable,
          status: result.status,
          repo: result.repo
        })
      );
      process.exit(0);
      break;
    }

    case "alert": {
      const status = String(args.status || "info");
      const level = String(args.level || (status === "success" ? "success" : status === "failed" ? "error" : "info"));
      const from = args.from || "";
      const to = args.to || "";
      const message = String(args.message || "");
      const title = String(args.title || (status === "success" ? "Update applied" : status === "failed" ? "Update failed" : "Update"));
      try {
        recordAlert({ kind: "update", level, title, message, data: { status, from, to } });
      } catch (error) {
        console.error(`alert not recorded (db): ${error.message}`);
      }
      await postWebhook({ source: "runyard", kind: "update", status, title, message, from, to, host: env.hostname });
      console.log("alert recorded");
      process.exit(0);
      break;
    }

    default:
      console.error(`usage: updatectl <drain|clear-drain|record-last-good|last-good|running-count|active-count|alert> [...flags]`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
