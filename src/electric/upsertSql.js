// Pure Postgres upsert SQL builder for the projector. Extracted for unit testing.
// JSON columns get an explicit ::jsonb cast so JSON text from SQLite parses
// correctly instead of being stored as an opaque string.
export function placeholder(col, index, jsonCols) {
  return jsonCols.has(col) ? `$${index}::jsonb` : `$${index}`;
}

export function buildMultiUpsert(table, columns, jsonCols, pk, rows) {
  const cols = columns.join(", ");
  const tuples = [];
  const values = [];
  let p = 1;
  for (const row of rows) {
    const ph = [];
    for (const col of columns) {
      ph.push(placeholder(col, p, jsonCols));
      let v = row[col];
      // node:sqlite may return undefined for absent columns; normalize to null.
      if (v === undefined) v = null;
      values.push(v);
      p += 1;
    }
    tuples.push(`(${ph.join(", ")})`);
  }
  const updates = columns
    .filter((c) => c !== pk)
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  const text =
    `INSERT INTO ${table} (${cols}) VALUES ${tuples.join(", ")} ` +
    (updates
      ? `ON CONFLICT (${pk}) DO UPDATE SET ${updates}`
      : `ON CONFLICT (${pk}) DO NOTHING`);
  return { text, values };
}
