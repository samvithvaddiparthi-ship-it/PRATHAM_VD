# Publishing to the production repo

**Who runs this: only Dhyan, and only when promoting.** Samvith never needs to.
Push to this repo as normal — nothing here fires automatically, and no commit here
reaches production until someone deliberately runs the sync below.

## The one rule

**This repo is where everything is authored. `pratham-opd-clean` is a build artifact.**

Never edit, fix, or commit anything directly in `pratham-opd-clean`. It is regenerated
from here and force-pushed; anything authored there is destroyed on the next sync.

This replaced an older process where *both* repos were authored in — features here,
security fixes there. Neither was the source of truth, so "syncing" was really a manual
merge needing a judgment call on every conflict, and things fell through: production
silently ran old code for weeks, and one attempted mirror would have locked out every
doctor. A derived artifact cannot drift.

## The workflow

PowerShell, from `pratham/opd-preconsult`:

```powershell
# 1. Pull, so you publish everyone's work and not just yours
git pull --rebase

# 2. Commit anything you want to ship. The sync reads from git HEAD, never your
#    working tree, so uncommitted work does NOT ship. (This is deliberate: it is
#    what makes .env, node_modules/ and eval/ impossible to leak.)
git status

# 3. See what would change in production — writes nothing, exits 1 if out of sync
python scripts/sync-clean.py --dest ..\..\pratham-opd-clean --check

# 4. Apply it (prompts before writing)
python scripts/sync-clean.py --dest ..\..\pratham-opd-clean

# 5. Review the real diff, then commit and push from the production repo
cd ..\..\pratham-opd-clean
git add -A
git diff --cached --stat          # <-- the truth. See the git status note below.
git commit -m "..."               # no Claude attribution on production commits
git push
```

Step 3 doubles as the answer to "is production up to date?" — it exits 0 when in sync.

The sync is safe to re-run. It makes production *match* this repo; it does not
append. Run it twice and the second run says "Already in sync" — that is how you
answer "is production up to date?" without guessing.

The script never commits, never pushes, and never touches GitHub. It writes files and
prints a diff. Every push is yours.

## What ships

`.cleanignore` decides — gitignore syntax, and it is the source of truth, not this file.
It currently holds back AI-development artifacts, the `*-lab/` prototypes, internal
process docs, the sync tooling itself, and the two demo-seed migrations.

Two things the sync guarantees by construction rather than by rule:

- **Secrets cannot leak.** Files are read from git, so untracked files are invisible to
  it. `.env`, `bhashini-lab/.env`, `eval/` (75MB of images) cannot ship even by accident.
- **Line endings stay LF.** Your working tree checks out `.sql`/`.sh` as CRLF on Windows;
  git stores them LF. A file copy would ship CRLF and break `#!/bin/bash` inside the
  Linux containers ("exited (126)"). Reading blobs cannot.

It also **asserts, never rewrites**. If a shipped file still names `CLAUDE.md`, the sync
aborts and tells you which file. Fix it here and re-run — do not scrub it in transit. A
check that fails is loud and safe; a regex that half-matches silently corrupts production
source.

## Things that will confuse you once

**`git status` in the production repo lies after a sync.** It can report ~180 modified
files when only ~17 really changed. That is git wanting to renormalize line endings after
`.gitattributes` arrived; the content is identical and the entries vanish on `git add`.
**Use `git add -A && git diff --cached --stat`** — that is what actually gets committed.

**The two seed migrations are meant to differ.** `db/migrations/005_doctors.sql` and
`006_departments.sql` are excluded, so production keeps its own. Here they seed 3 demo
doctors (PIN `1234`) + CARD/GEN so the app is testable; there they seed a clean slate so a
fresh hospital deployment does not come up with demo logins. Both are already applied in
every existing database (`schema_migrations` is keyed on filename, so they never re-run).
**Do not "fix" this by mirroring them** — that ships PIN-1234 doctors to every fresh
deployment. Every *other* migration is byte-identical across both repos; keep it that way.

**A doctor cannot log in after a deploy and sees "Doctor not found".** In production,
startup force-expires any account still on PIN `1234` (`is_active = false`). Re-activate
them in HIS and set a fresh PIN. See `deploy/OPERATIONS.md`.

## Requirements

`python3` and `pathspec` (`pip install pathspec`).

No rsync, and no Makefile: neither is available in this environment (Git Bash on Windows
ships no `rsync`, and `make` is not installed), which is why this is a Python script
invoked directly rather than the usual `make sync` / `rsync --delete --exclude-from`
recipe.
