import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function parseJsonOption(value, label = "JSON") {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

export function readJsonFileOrEmpty(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function writePrettyJsonFile(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
