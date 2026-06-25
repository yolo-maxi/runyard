import { api } from "./api.js";
import { toast } from "./toast.js";
import { refreshCollection } from "./collections.js";
import { queryClient } from "./queryClient.js";

const DEFAULT_COMMENTS = {
  approve: "Approved from Web Hub",
  reject: "Rejected from Web Hub",
  "request-changes": "Changes requested from Web Hub"
};

// Resolve an approval (approve | reject | request-changes). Ported from
// resolveApproval(); refreshes the approvals collection + dashboard so the
// pending count and lists update reactively.
export async function resolveApproval(id, decision, { comment } = {}) {
  const body = { comment: (comment || "").trim() || DEFAULT_COMMENTS[decision] || "Resolved from Web Hub" };
  await api(`/api/approvals/${id}/${decision}`, { method: "POST", body });
  toast(
    decision === "approve" ? "Approval granted" : decision === "request-changes" ? "Changes requested" : "Approval rejected",
    "ok"
  );
  await Promise.all([
    refreshCollection("approvals"),
    queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    queryClient.invalidateQueries({ queryKey: ["approval", id] })
  ]);
}
