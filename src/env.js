import { mkdirSync } from "node:fs";
import path from "node:path";

const root = process.env.SMITHERS_HUB_ROOT || process.cwd();
const dataDir = process.env.SMITHERS_HUB_DATA_DIR || path.join(root, "data");

mkdirSync(dataDir, { recursive: true });
mkdirSync(path.join(dataDir, "artifacts", "runs"), { recursive: true });

export const env = {
  root,
  dataDir,
  dbPath: process.env.SMITHERS_HUB_DB || path.join(dataDir, "smithers-hub.sqlite"),
  artifactDir: process.env.SMITHERS_HUB_ARTIFACT_DIR || path.join(dataDir, "artifacts"),
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 43117),
  baseUrl: process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 43117}`,
  instanceName: process.env.SMITHERS_HUB_INSTANCE_NAME || "Smithers Hub",
  sessionSecret: process.env.SMITHERS_HUB_SESSION_SECRET || "dev-smithers-hub-session-secret",
  bootstrapToken: process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || process.env.SMITHERS_TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || process.env.SMITHERS_TELEGRAM_CHAT_ID || ""
};
