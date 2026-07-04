import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  eligibleHookProfiles,
  HOOK_KINDS,
  hookProfileReadiness,
  presentHookProfileForCaller,
  validateHookProfileDefinition
} from "../src/hookProfileRecords.js";

function staticPublishInput(overrides = {}) {
  return {
    slug: "static-publish",
    name: "Static publish",
    description: "Publish verified build output to the static host.",
    kind: "static-publish",
    config: { targetRoot: "/var/www/apps", urlBase: "https://apps.example.com" },
    params: [{ name: "publicAccess", type: "boolean", description: "Publish without auth." }],
    secretNames: [],
    allowedCapabilities: ["idea-to-product"],
    ...overrides
  };
}

describe("hook profile records", () => {
  it("accepts a bounded static-publish definition and normalizes it", () => {
    const result = validateHookProfileDefinition(staticPublishInput());
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.definition.kind, "static-publish");
    assert.equal(result.definition.config.targetRoot, "/var/www/apps");
    assert.equal(result.definition.enabled, true);
    assert.deepEqual(result.definition.allowedCapabilities, ["idea-to-product"]);
  });

  it("rejects unknown kinds, bad slugs, and non-absolute roots", () => {
    assert.equal(validateHookProfileDefinition(staticPublishInput({ kind: "rm-rf" })).ok, false);
    assert.equal(validateHookProfileDefinition(staticPublishInput({ slug: "Bad Slug!" })).ok, false);
    const relative = validateHookProfileDefinition(staticPublishInput({ config: { targetRoot: "www/apps" } }));
    assert.equal(relative.ok, false);
    assert.ok(relative.errors.some((error) => /targetRoot/.test(error)));
    assert.deepEqual(HOOK_KINDS.includes("git-push"), true);
  });

  it("rejects unknown config keys without echoing their values", () => {
    const smuggled = validateHookProfileDefinition(staticPublishInput({
      config: { targetRoot: "/var/www/apps", token: "sk-SUPER-SECRET-VALUE-123456" }
    }));
    assert.equal(smuggled.ok, false);
    const combined = smuggled.errors.join("\n");
    assert.match(combined, /unknown key "token"/);
    assert.match(combined, /secretNames/);
    assert.ok(!combined.includes("SUPER-SECRET-VALUE"), "error messages must never echo submitted values");
  });

  it("models git push as a hook that can never bypass promotion gates", () => {
    // Pushing a work branch under a prefix is fine.
    const ok = validateHookProfileDefinition({
      slug: "git-push-work",
      name: "Push work branch",
      kind: "git-push",
      config: { repoRoot: "/home/runner/repos/app", remote: "origin", branchPrefix: "runyard/" }
    });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));

    // Targeting a protected branch is rejected and points at run promotion.
    const protectedBranch = validateHookProfileDefinition({
      slug: "git-push-main",
      name: "Push main",
      kind: "git-push",
      config: { repoRoot: "/home/runner/repos/app", targetBranch: "main" }
    });
    assert.equal(protectedBranch.ok, false);
    assert.ok(protectedBranch.errors.some((error) => /protected branch/.test(error) && /promotion/.test(error)));

    // Remotes are names, never URLs (URLs can embed credentials).
    const urlRemote = validateHookProfileDefinition({
      slug: "git-push-url",
      name: "Push URL",
      kind: "git-push",
      config: { repoRoot: "/home/runner/repos/app", remote: "https://user:token@github.com/x/y.git", branchPrefix: "runyard/" }
    });
    assert.equal(urlRemote.ok, false);
    assert.ok(urlRemote.errors.some((error) => /remote name/.test(error)));
  });

  it("constrains webhooks to https URLs without credentials and secret refs by name", () => {
    assert.equal(validateHookProfileDefinition({
      slug: "notify",
      name: "Notify",
      kind: "webhook",
      config: { url: "http://example.com/hook" }
    }).ok, false);
    assert.equal(validateHookProfileDefinition({
      slug: "notify",
      name: "Notify",
      kind: "webhook",
      config: { url: "https://user:pass@example.com/hook" }
    }).ok, false);
    const badSecretRef = validateHookProfileDefinition({
      slug: "notify",
      name: "Notify",
      kind: "webhook",
      config: { url: "https://example.com/hook", secretHeaders: { Authorization: "not a name!!" } }
    });
    assert.equal(badSecretRef.ok, false);
    const good = validateHookProfileDefinition({
      slug: "notify",
      name: "Notify",
      kind: "webhook",
      config: { url: "https://example.com/hook", method: "POST", secretHeaders: { Authorization: "WEBHOOK_TOKEN" } },
      secretNames: ["WEBHOOK_TOKEN"]
    });
    assert.equal(good.ok, true, JSON.stringify(good.errors));
  });

  it("keeps custom-script conservative: absolute command, declared-param argv, no shell strings", () => {
    const good = validateHookProfileDefinition({
      slug: "publish-script",
      name: "Publish script",
      kind: "custom-script",
      params: [{ name: "channel", type: "string" }],
      config: {
        command: "/opt/hooks/publish.sh",
        argv: ["--channel", { param: "channel" }, { field: "artifactPath" }],
        allowedCommandPaths: ["/opt/hooks"],
        timeoutSeconds: 120
      }
    });
    assert.equal(good.ok, true, JSON.stringify(good.errors));

    const undeclaredParam = validateHookProfileDefinition({
      slug: "publish-script",
      name: "Publish script",
      kind: "custom-script",
      config: { command: "/opt/hooks/publish.sh", argv: [{ param: "not_declared" }] }
    });
    assert.equal(undeclaredParam.ok, false);

    const outsideAllowedPath = validateHookProfileDefinition({
      slug: "publish-script",
      name: "Publish script",
      kind: "custom-script",
      config: { command: "/usr/bin/bash", allowedCommandPaths: ["/opt/hooks"] }
    });
    assert.equal(outsideAllowedPath.ok, false);

    const multiline = validateHookProfileDefinition({
      slug: "publish-script",
      name: "Publish script",
      kind: "custom-script",
      config: { command: "/opt/hooks/publish.sh", argv: ["ok", "bad\nline"] }
    });
    assert.equal(multiline.ok, false);
  });

  it("requires vercel-preview tokens to be referenced by secret name", () => {
    const missingSecret = validateHookProfileDefinition({
      slug: "vercel",
      name: "Vercel preview",
      kind: "vercel-preview",
      config: { project: "my-app" }
    });
    assert.equal(missingSecret.ok, false);
    const good = validateHookProfileDefinition({
      slug: "vercel",
      name: "Vercel preview",
      kind: "vercel-preview",
      config: { project: "my-app" },
      secretNames: ["VERCEL_TOKEN"]
    });
    assert.equal(good.ok, true, JSON.stringify(good.errors));
  });

  it("reports readiness with missing secret names only, never values", () => {
    const profile = { secretNames: ["VERCEL_TOKEN", "OTHER_TOKEN"] };
    const missing = hookProfileReadiness(profile, {
      secretExists: (name) => name === "OTHER_TOKEN",
      secretsEnabled: () => true
    });
    assert.equal(missing.ready, false);
    assert.equal(missing.status, "hook_config_required");
    assert.deepEqual(missing.missingSecrets, ["VERCEL_TOKEN"]);

    const disabled = hookProfileReadiness(profile, { secretExists: () => true, secretsEnabled: () => false });
    assert.equal(disabled.status, "hook_config_required");
    assert.match(disabled.message, /secrets store disabled/);

    const ready = hookProfileReadiness(profile, { secretExists: () => true, secretsEnabled: () => true });
    assert.deepEqual(ready, { ready: true, status: "ready", missingSecrets: [] });
    assert.deepEqual(hookProfileReadiness({ secretNames: [] }, {}), { ready: true, status: "ready", missingSecrets: [] });
  });

  it("presents a caller shape without config, secret names, or capability lists", () => {
    const profile = {
      slug: "static-publish",
      name: "Static publish",
      description: "Publish",
      kind: "static-publish",
      params: [{ name: "publicAccess", type: "boolean", description: "", required: false }],
      config: { targetRoot: "/var/www/apps" },
      secretNames: ["DEPLOY_KEY"],
      allowedCapabilities: ["idea-to-product"],
      enabled: true
    };
    const presented = presentHookProfileForCaller(profile);
    assert.deepEqual(Object.keys(presented).sort(), ["description", "enabled", "kind", "name", "params", "slug"]);
    assert.equal(JSON.stringify(presented).includes("DEPLOY_KEY"), false);
    assert.equal(JSON.stringify(presented).includes("/var/www"), false);
  });

  it("computes two-sided, default-closed eligibility", () => {
    const profiles = [
      { slug: "static-publish", enabled: true, allowedCapabilities: [] },
      { slug: "git-push-work", enabled: true, allowedCapabilities: ["improve"] },
      { slug: "disabled-hook", enabled: false, allowedCapabilities: [] }
    ];
    // Capability that never opted in gets nothing.
    assert.deepEqual(eligibleHookProfiles({ capability: { slug: "idea-to-product", workflow: {} }, profiles }), []);
    // Opt-in by slug intersects with the profile side.
    const optedIn = eligibleHookProfiles({
      capability: { slug: "idea-to-product", workflow: { hooks: { allowedProfiles: ["static-publish", "git-push-work", "disabled-hook"] } } },
      profiles
    });
    assert.deepEqual(optedIn.map((profile) => profile.slug), ["static-publish"]);
    // Wildcard still respects the profile's allowedCapabilities and enabled flag.
    const wildcard = eligibleHookProfiles({
      capability: { slug: "improve", workflow: { hooks: { allowedProfiles: ["*"] } } },
      profiles
    });
    assert.deepEqual(wildcard.map((profile) => profile.slug), ["static-publish", "git-push-work"]);
  });
});
