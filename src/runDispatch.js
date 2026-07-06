// Create a dispatcher that turns a run request into the stored run. Historical
// supervisor wrapping has been removed; HTTP routes, schedules, and reruns all
// share this direct execution path.
export function createRunDispatcher({
  createRun
} = {}) {
  return function dispatchRun(capability, input, options = {}) {
    return { run: createRun(capability, input, options) };
  };
}
