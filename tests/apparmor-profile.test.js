import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = path.join(ROOT, "deploy/apparmor/bwrap");
const INSTALL = path.join(ROOT, "deploy/apparmor/install.sh");
const README = path.join(ROOT, "deploy/apparmor/README.md");

const profileText = readFileSync(PROFILE, "utf8");
const installText = readFileSync(INSTALL, "utf8");

describe("deploy/apparmor/bwrap profile", () => {
  it("is the narrow flags=(unconfined) userns stub scoped to /usr/bin/bwrap", () => {
    assert.match(profileText, /^abi <abi\/4\.0>,/m, "declares the AppArmor abi");
    assert.match(profileText, /include <tunables\/global>/, "pulls in the standard tunables");
    assert.match(profileText, /profile bwrap \/usr\/bin\/bwrap flags=\(unconfined\) \{/, "attaches to the bwrap binary, unconfined");
    assert.match(profileText, /^\s*userns,\s*$/m, "grants the userns capability");
    assert.match(profileText, /include if exists <local\/bwrap>/, "leaves a site-override hook");
  });

  it("grants nothing broader than userns (no capability/mount/etc. rules)", () => {
    // A flags=(unconfined) profile already allows everything; make sure we did
    // not additionally hand-write privileged rules that would surprise readers.
    assert.doesNotMatch(profileText, /^\s*capability\b/m);
    assert.doesNotMatch(profileText, /^\s*mount\b/m);
  });
});

describe("deploy/apparmor/install.sh", () => {
  it("is executable", () => {
    assert.equal(statSync(INSTALL).mode & 0o111, 0o111, "install.sh must be executable");
  });

  it("installs/loads exactly the profile artifact and supports --uninstall", () => {
    assert.match(installText, /\/etc\/apparmor\.d\/bwrap/, "targets the canonical profile path");
    assert.match(installText, /apparmor_parser -r\b/, "reloads via apparmor_parser -r");
    assert.match(installText, /apparmor_parser -N\b/, "validates before installing");
    assert.match(installText, /--uninstall/, "offers a clean removal path");
    assert.match(installText, /apparmor_parser -R\b/, "uninstall removes the loaded profile");
  });

  it("does NOT change any sysctl or restart any service (stays narrow)", () => {
    assert.doesNotMatch(installText, /sysctl\s+-w/, "must not mutate sysctls");
    assert.doesNotMatch(installText, /systemctl\s+(restart|start|stop)/, "must not touch services");
    assert.doesNotMatch(installText, /service\s+\S+\s+(restart|start|stop)/, "must not touch services");
  });
});

test("deploy/apparmor/README.md points operators at the installer", () => {
  const readme = readFileSync(README, "utf8");
  assert.match(readme, /deploy\/apparmor\/install\.sh/);
  assert.match(readme, /setting up uid map: Permission denied/);
});

// Real AppArmor syntax validation — only where apparmor_parser is installed
// (skipped elsewhere). `-N` parses + resolves includes and prints the profile
// name without loading into the kernel or writing a cache, so it needs no root
// and mutates nothing.
const APPARMOR_PARSER = ["/usr/sbin/apparmor_parser", "/sbin/apparmor_parser"].find((p) => {
  try {
    execFileSync(p, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

test("bwrap profile parses cleanly under apparmor_parser", { skip: !APPARMOR_PARSER && "apparmor_parser unavailable" }, () => {
  const out = execFileSync(APPARMOR_PARSER, ["-N", "-I", "/etc/apparmor.d", PROFILE], { encoding: "utf8" });
  assert.match(out, /^bwrap$/m, "apparmor_parser should report the profile name 'bwrap'");
});
