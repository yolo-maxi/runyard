import { deepLinks } from "./deepLinks.js";

export function runAutomationProvenance(origin) {
  if (!origin || origin.type !== "schedule") return null;
  const scheduleId = origin.scheduleId || "";
  const scheduleName = origin.scheduleName || origin.name || "Schedule";
  return {
    type: "schedule",
    label: "Scheduled",
    scheduleId,
    scheduleName,
    trigger: origin.trigger || "",
    ...(scheduleId ? { deepLink: deepLinks.schedule(scheduleId) } : {})
  };
}
