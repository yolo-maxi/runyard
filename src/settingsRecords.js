export function settingLookupQuery(key) {
  return {
    sql: "SELECT key FROM settings WHERE key = ?",
    params: [key]
  };
}

export function settingDefaultInsertQuery({ key, value, timestamp }) {
  return {
    sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
    params: [key, String(value), timestamp]
  };
}
