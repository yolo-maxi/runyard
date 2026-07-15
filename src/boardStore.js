import {
  DEFAULT_BOARD_LANES,
  boardCountQuery,
  boardCreateRecord,
  boardInsertQuery,
  boardListQuery,
  boardLookupQuery,
  boardUpdateQuery,
  boardUpdateValues,
  normalizeBoard
} from "./boardRecords.js";

// Board instances: durable configured views over work items. The store is a
// thin CRUD layer (records own SQL/validation shapes); ensureDefaultBoard
// seeds the instance's own software-factory board on first boot so /app#work
// is a configured product surface, never an empty shell.

export const DEFAULT_BOARD_SEED = {
  slug: "runyard",
  title: "RunYard Factory",
  description: "This deployment's own software-factory board: product, infra, docs, and release work, executed and updated by workflows.",
  project: "",
  lanes: DEFAULT_BOARD_LANES,
  defaultWorkflows: [],
  isDefault: true,
  createdBy: "system"
};

export function createBoardStore({ all, one, run, id, now }) {
  function listBoards() {
    const query = boardListQuery();
    return all(query.sql, query.params).map(normalizeBoard);
  }

  function getBoard(slugOrId) {
    const query = boardLookupQuery(slugOrId);
    return normalizeBoard(one(query.sql, query.params));
  }

  function createBoard(input) {
    if (getBoard(input.slug)) throw new Error(`board slug already exists: ${input.slug}`);
    const record = boardCreateRecord({ id: id("board"), input, timestamp: now() });
    run(boardInsertQuery().sql, record);
    return getBoard(record.id);
  }

  function updateBoard(slugOrId, updates = {}) {
    const lookup = boardLookupQuery(slugOrId);
    const existing = one(lookup.sql, lookup.params);
    if (!existing) return null;
    const query = boardUpdateQuery({ idValue: slugOrId, values: boardUpdateValues(existing, updates, now()) });
    run(query.sql, query.params);
    return getBoard(existing.id);
  }

  // Idempotent first-boot seed: if no boards exist, create the instance's
  // default factory board (instanceName personalizes the title).
  function ensureDefaultBoard({ instanceName = "" } = {}) {
    const count = one(boardCountQuery().sql, boardCountQuery().params).count;
    if (count > 0) return null;
    const title = instanceName ? `${instanceName} Factory` : DEFAULT_BOARD_SEED.title;
    return createBoard({ ...DEFAULT_BOARD_SEED, title });
  }

  return {
    createBoard,
    ensureDefaultBoard,
    getBoard,
    listBoards,
    updateBoard
  };
}
