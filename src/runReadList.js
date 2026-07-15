import { boundedLimit } from "./httpQuery.js";

export function runListQuery(rawQuery = {}, hiddenRunSlugs = []) {
  const status = rawQuery.status || "";
  const limit = boundedLimit(rawQuery.limit, 100, 500);
  // ?workflow= is canonical; ?capability= / ?capabilitySlug= are legacy aliases.
  const capability = String(rawQuery.workflow || rawQuery.capability || rawQuery.capabilitySlug || "").trim();
  const hasWorkflowParam = Object.hasOwn(rawQuery, "workflows") || Object.hasOwn(rawQuery, "capabilities");
  const workflowParam = hasWorkflowParam ? String(rawQuery.workflows || rawQuery.capabilities || "").trim() : "";
  const workflowSlugs = [
    ...new Set(
      [
        ...workflowParam.split(","),
        capability
      ].map((slug) => String(slug || "").trim()).filter(Boolean)
    )
  ];
  const explicitEmptyWorkflowFilter = hasWorkflowParam && !capability && workflowSlugs.length === 0;
  const q = String(rawQuery.q || "").trim();
  const since = String(rawQuery.since || "").trim();
  const until = String(rawQuery.until || "").trim();
  const cursor = String(rawQuery.cursor || "").trim();
  const workItemId = String(rawQuery.workItem || rawQuery.workItemId || "").trim();
  return {
    status,
    limit,
    capability,
    workflowSlugs,
    capabilitySlugs: explicitEmptyWorkflowFilter ? ["__runyard-no-workflow__"] : workflowSlugs,
    includeInternal: workflowSlugs.some((slug) => hiddenRunSlugs.includes(slug)),
    explicitEmptyWorkflowFilter,
    q,
    since,
    until,
    cursor,
    workItemId,
    filtered: Boolean(q || since || until || cursor || workItemId || workflowSlugs.length || explicitEmptyWorkflowFilter)
  };
}

export function runListPage({ countRuns, listRuns, query }) {
  const filters = {
    status: query.status,
    q: query.q,
    since: query.since,
    until: query.until,
    capabilitySlugs: query.capabilitySlugs,
    workItemId: query.workItemId,
    includeInternal: query.includeInternal
  };
  if (!query.filtered) {
    return {
      rows: listRuns({ status: query.status, limit: query.limit }),
      total: countRuns({ status: query.status }),
      nextCursor: null
    };
  }
  const page = listRuns({ ...filters, cursor: query.cursor, limit: query.limit + 1 });
  const hasNext = page.length > query.limit;
  const rows = hasNext ? page.slice(0, query.limit) : page;
  return {
    rows,
    total: countRuns(filters),
    nextCursor: hasNext ? rows[rows.length - 1].createdAt : null
  };
}

export function runListFilterResponse(query) {
  return {
    q: query.q,
    status: query.status,
    since: query.since,
    until: query.until,
    cursor: query.cursor,
    workflows: query.workflowSlugs,
    workItem: query.workItemId
  };
}
