// Passive update CHECK — read-only, outbound-only, never installs anything.
//
// This module does two things and nothing else:
//   1. Compare semver strings (so we can tell "is the latest release newer?").
//   2. Poll the public GitHub Releases API for the latest tag, with caching and
//      total failure tolerance. A network error, rate-limit, or garbage payload
//      degrades to status:"unknown" / updateAvailable:false — it must NEVER throw
//      or crash the hub, and it must NEVER phone home to anything but GitHub.
//
// Everything here takes its dependencies (fetch, clock, repo, current version)
// by injection so it is unit-testable with a mock fetch and a fake clock — no
// live network call ever runs in the test suite.

// Parse "v1.2.3", "1.2.3", "1.2.3-rc.1", "1.2.3+build" into a structured form.
// Returns null for anything that isn't a recognizable major.minor.patch — the
// caller treats null as "can't compare", which fails safe (no update prompt).
export function parseSemver(input) {
  if (input == null) return null;
  const raw = String(input).trim().replace(/^v/i, "");
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || "",
    raw
  };
}

function comparePrerelease(a, b) {
  // SemVer §11: a version WITH a prerelease has LOWER precedence than the same
  // version without one (1.0.0-rc < 1.0.0). Two prereleases compare identifier
  // by identifier; numeric identifiers compare numerically, others lexically.
  if (a === b) return 0;
  if (!a) return 1; // a is a full release, b is a prerelease -> a is greater
  if (!b) return -1;
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1; // shorter prerelease set is lower
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// -1 if a<b, 0 if equal, 1 if a>b, or null if either side is unparseable.
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

// Is `latest` strictly newer than `current`? Unparseable input -> false, so a
// malformed tag from the API can never trigger a spurious "update available".
export function isNewerVersion(latest, current) {
  const cmp = compareSemver(latest, current);
  return cmp === 1;
}

// GitHub release objects sometimes carry a draft/prerelease flag; we ignore
// those by default and only consider the published `latest` release the API
// returns from /releases/latest (which already excludes drafts/prereleases).
export function tagFromRelease(release) {
  if (!release || typeof release !== "object") return "";
  return String(release.tag_name || release.name || "").trim();
}

const GITHUB_API = "https://api.github.com";

// Create a checker bound to a repo + the running version. `check()` returns a
// cached result object and only hits the network when the cache is older than
// ttlMs (or force=true). The returned shape is stable and safe to serialize to
// the admin UI. The only outbound call is GET api.github.com/.../releases/latest.
export function createUpdateChecker({
  repo,
  currentVersion,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = 60 * 60 * 1000,
  timeoutMs = 8000,
  userAgent = "runyard-update-check"
} = {}) {
  let cache = null;

  function snapshot(extra) {
    cache = {
      repo,
      current: currentVersion,
      latest: null,
      updateAvailable: false,
      status: "unknown",
      error: null,
      checkedAt: now(),
      ...extra
    };
    return cache;
  }

  async function check(force = false) {
    if (!force && cache && now() - cache.checkedAt < ttlMs) return cache;
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(String(repo))) {
      return snapshot({ status: "disabled", error: "no GITHUB_REPO configured", latest: cache?.latest ?? null });
    }
    if (typeof fetchImpl !== "function") {
      return snapshot({ status: "unknown", error: "fetch unavailable", latest: cache?.latest ?? null });
    }

    const url = `${GITHUB_API}/repos/${repo}/releases/latest`;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/vnd.github+json", "user-agent": userAgent },
        signal: controller?.signal
      });
      if (res && (res.status === 403 || res.status === 429)) {
        // Rate-limited: keep any previously known latest, surface the state, and
        // back off (the ttl gate prevents hammering). Never treat as an update.
        return snapshot({
          status: "rate_limited",
          error: "github api rate limit",
          latest: cache?.latest ?? null,
          updateAvailable: cache?.updateAvailable ?? false
        });
      }
      if (!res || !res.ok) {
        return snapshot({ status: "unknown", error: `http ${res ? res.status : "no-response"}`, latest: cache?.latest ?? null });
      }
      const body = await res.json();
      const tag = tagFromRelease(body);
      const latest = parseSemver(tag) ? tag.replace(/^v/i, "") : null;
      if (!latest) {
        return snapshot({ status: "unknown", error: "no parseable tag_name", latest: cache?.latest ?? null });
      }
      return snapshot({
        status: "ok",
        latest,
        latestTag: tag,
        updateAvailable: isNewerVersion(latest, currentVersion),
        error: null
      });
    } catch (error) {
      // Network failure / DNS / timeout / abort: degrade gracefully to unknown.
      return snapshot({
        status: "unknown",
        error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
        latest: cache?.latest ?? null,
        updateAvailable: cache?.updateAvailable ?? false
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    check,
    getCached: () => cache,
    get repo() {
      return repo;
    },
    get current() {
      return currentVersion;
    }
  };
}
