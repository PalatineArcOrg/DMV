# DMV marketing site (dmv.palatinearc.com)

The repo `website/` dir is the **source of truth**. Caddy serves the live site from
`/var/www/dmv` (static `file_server`); `deploy.sh` mirrors the repo there.

## Files
- `index.html` — the self-unpacking single-file bundle (the real page is a JSON string
  in `<script type="__bundler/template">`; edit via the slash-safe recipe — see the
  `dmv-website-bundle` note). Release-version text (`Latest release: vX.Y.Z`) is
  hardcoded here; bump it when releasing.
- `icon.png` — favicon / apple-touch-icon / nav logo (512×512).
- `gen-changelog.mjs` — renders repo `../CHANGELOG.md` → a styled `changelog.html`.
  Run standalone to preview into `website/changelog.html`, or pass an output path.
- `changelog.html` — **generated, git-ignored.** Produced on deploy; never hand-edit.
- `deploy.sh` — `website/` → `/var/www/dmv` (regenerates changelog.html + syncs assets).

## Deploy
```bash
bash website/deploy.sh          # regenerate changelog + push repo/website -> /var/www/dmv
```
Caddy serves the files directly — no reload needed.

## Auto-deploy on commit (recommended)
A git `post-commit` hook runs `deploy.sh` whenever a commit touches `website/` or
`CHANGELOG.md`, so the live site never drifts from the repo. Hooks aren't version-
controlled, so install it once per clone:
```bash
ln -sf ../../website/hooks/post-commit .git/hooks/post-commit   # from repo root
chmod +x website/hooks/post-commit
```
