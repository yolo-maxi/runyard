import { spawn } from "node:child_process";
import path from "node:path";
import { truncate } from "./presentation.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let crcTable;

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char];
  });
}

function basenameLabel(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return path.basename(text.replace(/\/+$/, "")) || text;
}

function compactProjectLabel(project = {}) {
  return (
    basenameLabel(project.repo) ||
    basenameLabel(project.path) ||
    basenameLabel(project.project) ||
    basenameLabel(project.display)
  );
}

function visualKindLabel(context = {}) {
  const kind = context.approval?.kind || "";
  if (kind === "side_effect") return "External action";
  if (kind === "workflow_gate") return "Workflow checkpoint";
  if (kind === "escalation") return "Recovery decision";
  return context.approval?.kindLabel || "Approval";
}

export function telegramApprovalVisualSummary(context = {}) {
  const workflow = truncate(context.workflow?.name || context.workflow?.slug || "", 54);
  const repo = truncate(compactProjectLabel(context.project), 54);
  const runTitle = truncate(context.run?.title || context.inputTitle || "", 72);
  if (!workflow && !repo) return null;
  return {
    workflow,
    repo,
    runTitle,
    kind: visualKindLabel(context)
  };
}

export function telegramApprovalVisualAltText(summary = {}) {
  if (!summary) return "";
  const parts = ["RunYard approval visual"];
  if (summary.kind) parts.push(`Type: ${summary.kind}`);
  if (summary.workflow) parts.push(`Workflow: ${summary.workflow}`);
  if (summary.repo) parts.push(`Repo/project: ${summary.repo}`);
  if (summary.runTitle) parts.push(`Run: ${summary.runTitle}`);
  return `${parts.join(". ")}.`;
}

function splitLine(text = "", max = 34) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > max && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

export function telegramApprovalVisualSvg(summary = {}) {
  const primaryLines = splitLine(summary.workflow || summary.repo || "Approval", 30);
  const showRepo = Boolean(summary.workflow && summary.repo);
  const repoLines = showRepo ? splitLine(summary.repo, 32) : [];
  const repoY = primaryLines.length > 1 ? 238 : 206;
  const runLines = summary.runTitle ? splitLine(summary.runTitle, 54).slice(0, 1) : [];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="420" viewBox="0 0 960 420">
  <rect width="960" height="420" rx="36" fill="#101828"/>
  <rect x="0" y="0" width="16" height="420" fill="#22c55e"/>
  <text x="64" y="74" font-family="DejaVu Sans, Arial, sans-serif" font-size="28" font-weight="700" fill="#86efac">${escapeXml(summary.kind || "Approval")}</text>
  ${primaryLines.map((line, index) => `<text x="64" y="${142 + index * 58}" font-family="DejaVu Sans, Arial, sans-serif" font-size="50" font-weight="800" fill="#ffffff">${escapeXml(line)}</text>`).join("\n  ")}
  ${showRepo ? `<text x="64" y="${repoY}" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" font-weight="700" fill="#94a3b8">REPO / PROJECT</text>` : ""}
  ${repoLines.map((line, index) => `<text x="64" y="${repoY + 48 + index * 42}" font-family="DejaVu Sans, Arial, sans-serif" font-size="36" font-weight="700" fill="#dbeafe">${escapeXml(line)}</text>`).join("\n  ")}
  ${runLines.length ? `<text x="64" y="374" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" font-weight="700" fill="#94a3b8">RUN</text>
  <text x="128" y="374" font-family="DejaVu Sans, Arial, sans-serif" font-size="28" font-weight="700" fill="#e2e8f0">${escapeXml(runLines[0])}</text>` : ""}
</svg>`;
}

export function renderSvgToPng(svg, { convertPath = process.env.RUNYARD_IMAGE_MAGICK_CONVERT || "convert" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(convertPath, ["svg:-", "png:-"], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    const errors = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `convert exited ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.end(svg);
  });
}

function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      return value >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function pngTextChunk(keyword, text) {
  const cleanKeyword = String(keyword || "").replace(/\0/g, "").slice(0, 79);
  const cleanText = String(text || "").replace(/\0/g, "");
  if (!cleanKeyword || !cleanText) return null;
  return pngChunk("iTXt", Buffer.concat([
    Buffer.from(cleanKeyword, "latin1"),
    Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from(cleanText, "utf8")
  ]));
}

export function embedPngTextMetadata(png, metadata = {}) {
  const buffer = Buffer.isBuffer(png) ? png : Buffer.from(png || []);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return buffer;
  const firstLength = buffer.readUInt32BE(8);
  const firstType = buffer.subarray(12, 16).toString("latin1");
  if (firstType !== "IHDR") return buffer;
  const insertAt = 8 + 12 + firstLength;
  const chunks = Object.entries(metadata)
    .map(([keyword, text]) => pngTextChunk(keyword, text))
    .filter(Boolean);
  if (!chunks.length) return buffer;
  return Buffer.concat([buffer.subarray(0, insertAt), ...chunks, buffer.subarray(insertAt)]);
}

export async function renderTelegramApprovalVisual(summary, options = {}) {
  if (!summary) return null;
  return renderSvgToPng(telegramApprovalVisualSvg(summary), options);
}
