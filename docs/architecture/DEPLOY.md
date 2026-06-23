# RunYard Deploy Path

RunYard has one production hub: `hub.repo.box` on the repo.box VPS. Treat this Hetzner checkout as a build/test workspace only.

## Production Deploy

1. Build and test the candidate branch on this machine.
2. Deploy the reviewed branch to the `prod` remote:

   ```sh
   git push prod <branch>:main
   ```

3. Restart the user service on repo.box:

   ```sh
   ssh repo.box 'systemctl --user restart smithers-hub'
   ```

4. Verify production through the public API:

   ```sh
   curl -fsS https://hub.repo.box/api/version
   curl -fsS https://hub.repo.box/readyz
   ```

## Source Of Truth

Capability definitions are git-authored seed data. On boot, the Hub applies those definitions idempotently by content hash: unchanged seed content must not bump capability versions, while changed seed content updates the DB cache and records a new version snapshot.

Admin/Web edits to workflow definitions are operational overrides only. They are not the source of truth and can be replaced by the next git-seeded definition change.

## Hetzner Boundary

Do not treat any Hetzner-local Caddy route or local `127.0.0.1:43117` Hub as production. DNS for `hub.repo.box` points at repo.box; deploy verification must use `https://hub.repo.box/api`.

This document is intentionally documentation-only. It does not modify live Caddy, systemd, DNS, or repo.box state.
