import { actorName } from "./routeActors.js";
import {
  eligibleHookProfiles,
  hookProfileReadiness,
  presentHookProfileForCaller
} from "./hookProfileRecords.js";

function isAdmin(req) {
  return (req.token?.scopes || []).includes("admin");
}

export function createHookProfileHandlers({
  getCapability,
  getHookProfile,
  listHookProfiles,
  recordAudit,
  secretExists,
  secretsEnabled,
  upsertHookProfile
} = {}) {
  const withReadiness = (profile) => ({
    ...profile,
    readiness: hookProfileReadiness(profile, { secretExists, secretsEnabled })
  });

  return {
    // Discovery. Admins (with ?all=1) see every profile including disabled
    // ones, with full config + readiness. Everyone else sees enabled profiles
    // in the caller shape only — no paths, remotes, URLs, or secret names.
    // ?workflow=<slug> narrows to profiles that workflow may select.
    listHookProfiles(req, res) {
      const admin = isAdmin(req);
      const includeDisabled = admin && req.query.all === "1";
      let profiles = listHookProfiles({ includeDisabled });
      const capabilitySlug = String(req.query.workflow || req.query.capability || "").trim();
      if (capabilitySlug) {
        const capability = getCapability(capabilitySlug);
        if (!capability) return res.status(404).json({ error: "workflow not found" });
        profiles = eligibleHookProfiles({ capability, profiles });
      }
      res.json({
        hookProfiles: admin ? profiles.map(withReadiness) : profiles.map(presentHookProfileForCaller)
      });
    },

    getHookProfile(req, res) {
      const profile = getHookProfile(req.params.slug);
      if (!profile) return res.status(404).json({ error: "hook profile not found" });
      if (isAdmin(req)) return res.json({ hookProfile: withReadiness(profile) });
      // Disabled profiles are invisible to non-admin callers.
      if (!profile.enabled) return res.status(404).json({ error: "hook profile not found" });
      res.json({ hookProfile: presentHookProfileForCaller(profile) });
    },

    // Admin-only (route-gated). Validation errors name offending keys but
    // never echo submitted values; the audit trail records the slug only.
    upsertHookProfile(req, res) {
      const body = { ...req.body, slug: String(req.body?.slug || req.params?.slug || "").trim() };
      const result = upsertHookProfile(body);
      if (!result.ok) {
        return res.status(400).json({ error: "invalid hook profile", errors: result.errors });
      }
      recordAudit(actorName(req.token), "hook_profile.upserted", result.hookProfile.slug, {
        slug: result.hookProfile.slug,
        kind: result.hookProfile.kind,
        enabled: result.hookProfile.enabled,
        version: result.hookProfile.version
      });
      res.json({ hookProfile: withReadiness(result.hookProfile) });
    },

    // Admin-only dry-run: is this stored profile executable right now?
    // Reports hook_config_required with missing secret NAMES only.
    validateHookProfile(req, res) {
      const profile = getHookProfile(req.params.slug);
      if (!profile) return res.status(404).json({ error: "hook profile not found" });
      const readiness = hookProfileReadiness(profile, { secretExists, secretsEnabled });
      res.json({
        slug: profile.slug,
        kind: profile.kind,
        enabled: profile.enabled,
        ...readiness
      });
    }
  };
}
