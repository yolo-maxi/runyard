export function isAuthError(error) {
  return error && (error.status === 401 || error.status === 403);
}

export function createClaimAuthTracker({ baseUrl = "", log = console } = {}) {
  let ok = true;
  let errorText = "";
  let faults = 0;

  function record(success, error = null) {
    if (success) {
      if (!ok) log.log?.(`Hub auth recovered against ${baseUrl}.`);
      ok = true;
      errorText = "";
      faults = 0;
      return;
    }
    faults += 1;
    ok = false;
    errorText = error ? `HTTP ${error.status}: ${error.message}` : "unauthorized";
    if (faults === 1 || faults % 20 === 0) {
      log.error?.(
        `\n*** RUNNER HUB AUTH FAILURE (x${faults}) ***\n` +
          `Hub ${baseUrl} rejected this runner's token (${errorText}).\n` +
          "The runner is registered/online but CANNOT claim work. " +
          "Check RUNYARD_HUB_TOKEN / SMITHERS_HUB_URL in runner.env, then restart.\n"
      );
    }
  }

  function health() {
    return ok ? { ok: true } : { ok: false, error: errorText || "unauthorized" };
  }

  return { health, record };
}
