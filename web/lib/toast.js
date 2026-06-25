// Transient toast notifications. Ported from legacy app.js `toast()` — it
// appends to a `.toasts` host on document.body, so the existing styles.css
// `.toast`/`.show` rules apply unchanged. Imperative (not a React component) so
// any handler can fire one without prop drilling.
export function toast(message, kind = "info") {
  if (typeof document === "undefined") return;
  let host = document.querySelector(".toasts");
  if (!host) {
    host = document.createElement("div");
    host.className = "toasts";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 3600);
}
