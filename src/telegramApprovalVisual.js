import { spawn } from "node:child_process";
import path from "node:path";
import { truncate } from "./presentation.js";

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

export function telegramApprovalVisualSummary(context = {}) {
  const workflow = truncate(context.workflow?.name || context.workflow?.slug || "", 54);
  const repo = truncate(compactProjectLabel(context.project), 54);
  if (!workflow && !repo) return null;
  return {
    workflow,
    repo,
    kind: context.approval?.kindLabel || context.approval?.kind || "Approval"
  };
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="360" viewBox="0 0 960 360">
  <rect width="960" height="360" rx="36" fill="#101828"/>
  <rect x="0" y="0" width="16" height="360" fill="#22c55e"/>
  <text x="64" y="74" font-family="DejaVu Sans, Arial, sans-serif" font-size="28" font-weight="700" fill="#86efac">${escapeXml(summary.kind || "Approval")}</text>
  ${primaryLines.map((line, index) => `<text x="64" y="${142 + index * 58}" font-family="DejaVu Sans, Arial, sans-serif" font-size="50" font-weight="800" fill="#ffffff">${escapeXml(line)}</text>`).join("\n  ")}
  ${showRepo ? `<text x="64" y="${repoY}" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" font-weight="700" fill="#94a3b8">REPO / PROJECT</text>` : ""}
  ${repoLines.map((line, index) => `<text x="64" y="${repoY + 48 + index * 42}" font-family="DejaVu Sans, Arial, sans-serif" font-size="36" font-weight="700" fill="#dbeafe">${escapeXml(line)}</text>`).join("\n  ")}
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

export async function renderTelegramApprovalVisual(summary, options = {}) {
  if (!summary) return null;
  return renderSvgToPng(telegramApprovalVisualSvg(summary), options);
}
