// Feature toggle for the Electric-backed read path.
//
// In this branch Electric is the default query layer. It can be turned off at
// runtime (falls back to the legacy REST polling collections) via:
//   localStorage.setItem("runyard.electric", "off")  — or  window.__RUNYARD_DISABLE_ELECTRIC__ = true
// This is the client half of the "fallback if Electric is down" story; the
// collections themselves also degrade to REST polling automatically on hard
// stream failure (see electricCollection.js).
export function electricEnabled() {
  if (typeof window !== "undefined") {
    if (window.__RUNYARD_DISABLE_ELECTRIC__ === true) return false;
    try {
      if (window.localStorage?.getItem("runyard.electric") === "off") return false;
    } catch {
      /* private mode / no storage — default on */
    }
  }
  return true;
}

export const ELECTRIC_SHAPE_URL = "/api/electric/v1/shape";
