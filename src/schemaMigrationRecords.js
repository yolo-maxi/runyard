function quoteIdentifier(value) {
  const identifier = String(value || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function tableColumnsQuery(table) {
  return {
    sql: `PRAGMA table_info(${quoteIdentifier(table)})`,
    params: []
  };
}

export function missingColumnAlterQueries({ table, existingColumns = [], columns = [] }) {
  const existing = new Set(existingColumns);
  const tableName = quoteIdentifier(table);
  return columns
    .filter((column) => !existing.has(column.name))
    .map((column) => ({
      sql: `ALTER TABLE ${tableName} ADD COLUMN ${column.definition}`,
      params: []
    }));
}
