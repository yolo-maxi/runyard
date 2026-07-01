export function actorName(token = {}, fallback = "") {
  if (!token || typeof token !== "object") return fallback;
  return token.name || token.id || fallback;
}
