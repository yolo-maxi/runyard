import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";

// Boot/auth sequence ported from legacy app.js boot(): try the existing session
// (/api/me); if that fails, attempt Telegram WebApp auth ONCE using the Mini App
// initData, then retry /api/me. The token-login form path lives in AuthGate.

let telegramAttempted = false;
export let telegramAuthError = "";

function telegramWebApp() {
  return (typeof window !== "undefined" && window.Telegram?.WebApp) || null;
}

export function markTelegramWebAppReady() {
  try {
    telegramWebApp()?.ready?.();
  } catch {
    /* readiness is advisory */
  }
}

async function tryTelegramAuth() {
  const initData = telegramWebApp()?.initData || "";
  if (!initData || telegramAttempted) return false;
  telegramAttempted = true;
  try {
    await api("/api/auth/telegram-webapp", { method: "POST", body: { initData } });
    telegramAuthError = "";
    return true;
  } catch (error) {
    telegramAuthError = error.message || "Telegram approval access failed";
    return false;
  }
}

// Resolves to the authenticated token record, or throws (→ login fallback).
async function bootMe() {
  try {
    return await api("/api/me");
  } catch {
    // fall through to Telegram attempt
  }
  if (await tryTelegramAuth()) {
    return api("/api/me"); // throws again if the Hub session wasn't accepted
  }
  throw new Error("no-session");
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: bootMe,
    retry: false,
    staleTime: Infinity
  });
}

export function meIsAdmin(me) {
  return (me?.scopes || []).includes("admin");
}
