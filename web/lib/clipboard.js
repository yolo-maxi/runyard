import { toast } from "./toast.js";

// Copy text to the clipboard with a toast, mirroring legacy bindCopy() UX.
export async function copyText(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, "ok");
  } catch {
    // Fallback for non-secure contexts / older browsers.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast(label, "ok");
    } catch {
      toast("Copy failed", "error");
    }
  }
}
