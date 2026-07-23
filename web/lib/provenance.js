import { deepLinks } from "./router.js";

export function runAutomation(run) {
  if (run?.automation?.type === "schedule") return run.automation;
  const origin = run?.origin || run?.input?.__origin || null;
  if (!origin || origin.type !== "schedule") return null;
  const scheduleId = origin.scheduleId || "";
  return {
    type: "schedule",
    label: "Scheduled",
    scheduleId,
    scheduleName: origin.scheduleName || origin.name || "Schedule",
    trigger: origin.trigger || "",
    ...(scheduleId ? { deepLink: deepLinks.schedule(scheduleId) } : {})
  };
}
