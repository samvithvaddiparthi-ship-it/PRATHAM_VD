#!/usr/bin/env python3
"""
Generate the production repo (Dhyan-rao-10/Pratham-OPD) from this one.

    python scripts/sync-clean.py --dest ../../pratham-opd-clean [--check] [--yes]

WHAT THIS IS
    The production repo is a BUILD ARTIFACT. It is never authored in. This script
    makes it match `opd-preconsult/` at HEAD, minus everything in .cleanignore.
    Re-running it is always safe: it reflects the current state, it does not append.

WHY IT READS FROM GIT, NOT YOUR WORKING TREE
    Every file is read from the git object store at HEAD (`git cat-file`), never off
    disk. Three properties fall out of that for free, rather than needing rules:
      * Secrets cannot leak.     Untracked files are invisible. .env, bhashini-lab/.env,
                                 eval/ (75MB of patient-ish images) simply do not exist
                                 to this script.
      * Line endings stay LF.    The working tree checks out .sql/.sh as CRLF on Windows;
                                 git stores them LF. Copying files off disk would ship
                                 CRLF and break `#!/bin/bash` inside the Linux containers
                                 ("exited (126)"). Reading blobs cannot.
      * Only committed work ships. If it is not committed here, it does not reach
                                 production. Both collaborators get identical output.

    The cost: commit here first, then sync. That is the intended order.

IT ASSERTS, IT DOES NOT TRANSFORM
    The checks below either pass or abort. Nothing is rewritten on the way out. A check
    that fails is loud and safe; a regex that half-matches silently corrupts production
    source. If an assertion fires, fix the cause in THIS repo and re-run.

IT NEVER TOUCHES GITHUB
    No commit, no push, no branch. It writes files and prints the diff. You review and
    push by hand.
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path

try:
    import pathspec
except ImportError:
    sys.exit(
        "error: this script needs `pathspec` (gitignore-syntax matching).\n"
        "       pip install pathspec"
    )

# Everything under this prefix in THIS repo maps to the root of the production repo.
SRC_PREFIX = "opd-preconsult/"

# Never delete these from the destination, whatever else happens.
NEVER_DELETE = {".git", ".env"}

RED, GREEN, YELLOW, DIM, RESET = "\033[31m", "\033[32m", "\033[33m", "\033[2m", "\033[0m"


def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, **kw)


def git_text(repo, *args):
    return run(["git", "-C", str(repo)] + list(args)).stdout.decode("utf-8", "replace")


def fail(msg):
    sys.stdout.flush()   # keep earlier notes above the abort, not after it
    print(f"\n{RED}SYNC ABORTED{RESET}  {msg}\n", file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", required=True, help="path to the pratham-opd-clean checkout")
    ap.add_argument("--check", action="store_true",
                    help="report what would change and exit non-zero if anything would; write nothing")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args()

    src_repo = Path(__file__).resolve().parents[2]      # .../pratham
    src_root = src_repo / "opd-preconsult"
    dest = Path(args.dest).resolve()

    if not (src_repo / ".git").exists():
        fail(f"{src_repo} is not a git repo.")
    if not (dest / ".git").exists():
        fail(f"{dest} is not a git checkout. Refusing to write into a non-repo.")

    # --- Preconditions --------------------------------------------------------
    # The destination must be clean, or we would destroy uncommitted work — and we
    # could not tell you afterwards what this sync actually changed.
    if git_text(dest, "status", "--porcelain").strip():
        fail(f"{dest} has uncommitted changes. Commit or discard them first —\n"
             f"             this sync overwrites and deletes files there.")

    # Warn (do not block) if this repo is dirty: uncommitted work will NOT ship, and
    # that surprise is worth a sentence.
    if git_text(src_repo, "status", "--porcelain", "--", "opd-preconsult").strip():
        print(f"{YELLOW}note{RESET}: this repo has uncommitted changes under opd-preconsult/.")
        print(f"      The sync reads from HEAD, so those changes will NOT ship. Commit first")
        print(f"      if you meant to include them.\n")

    # --- Build the ship list from git, filtered by .cleanignore ---------------
    ignore_file = src_root / ".cleanignore"
    if not ignore_file.exists():
        fail(f"missing {ignore_file}")
    spec = pathspec.PathSpec.from_lines(
        "gitwildmatch", ignore_file.read_text(encoding="utf-8").splitlines()
    )

    tracked = [
        p[len(SRC_PREFIX):]
        for p in git_text(src_repo, "ls-files", "-z", "--", "opd-preconsult").split("\0")
        if p.startswith(SRC_PREFIX)
    ]
    if not tracked:
        fail("git ls-files returned nothing under opd-preconsult/ — wrong repo?")

    ship = sorted(p for p in tracked if not spec.match_file(p))
    excluded = sorted(set(tracked) - set(ship))

    # --- Assertions on what we are about to publish ---------------------------
    # 1. No AI-assisted-development tell. Note we look for the STRING "CLAUDE.md",
    #    not "claude" — the product legitimately calls the Anthropic API.
    offenders = []
    for rel in ship:
        blob = run(["git", "-C", str(src_repo), "cat-file", "-p",
                    f"HEAD:{SRC_PREFIX}{rel}"]).stdout
        if b"CLAUDE.md" in blob or b"CLAUDE.MD" in blob:
            offenders.append(rel)
    if offenders:
        fail("these files would ship while still naming CLAUDE.md:\n"
             + "".join(f"               - {o}\n" for o in offenders)
             + "             Fix the reference in THIS repo (point it at docs/ARCHITECTURE.md\n"
               "             or drop the file name) and re-run. Do not scrub it in transit.")

    # 2. Nothing that looks like a real secrets file.
    leaks = [p for p in ship if Path(p).name == ".env" or p.endswith("/.env")]
    if leaks:
        fail(f"refusing to ship env files: {leaks}")

    # --- Compute the change set ----------------------------------------------
    dest_tracked = {p for p in git_text(dest, "ls-files", "-z").split("\0") if p}
    ship_set = set(ship)
    # Excluded paths are PROTECTED in the destination: not copied, not deleted.
    # This is what preserves production's own 005/006 seed migrations.
    protected = {p for p in dest_tracked if spec.match_file(p)}
    to_delete = sorted(dest_tracked - ship_set - protected - NEVER_DELETE)

    # What counts as "changed" is what will land in the destination's next COMMIT, not
    # what differs on disk. Those differ: with core.autocrlf=true (the Windows default,
    # and what is set here) a fresh checkout of the destination is CRLF on disk while its
    # blobs are LF. Comparing bytes would then report every text file as modified and
    # bury the real diff — the review step is worthless if it cries wolf.
    #
    # So compare git's content hashes on both sides. Git blobs are content-addressed:
    # equal hash == identical content, independent of how either working tree is checked
    # out. We still WRITE whenever the bytes on disk differ, which is what quietly
    # repairs CRLF that a previous checkout introduced.
    src_hashes = {
        line.split("\t", 1)[1][len(SRC_PREFIX):]: line.split()[2]
        for line in git_text(src_repo, "ls-tree", "-r", "HEAD", SRC_PREFIX).splitlines()
        if line.split("\t", 1)[1].startswith(SRC_PREFIX)
    }
    dest_hashes = {
        line.split("\t", 1)[1]: line.split()[2]
        for line in git_text(dest, "ls-tree", "-r", "HEAD").splitlines()
    }

    writes, normalized_only = [], []
    for rel in ship:
        blob = run(["git", "-C", str(src_repo), "cat-file", "-p",
                    f"HEAD:{SRC_PREFIX}{rel}"]).stdout
        target = dest / rel
        current = target.read_bytes() if target.exists() else None
        changes_git = src_hashes.get(rel) != dest_hashes.get(rel)
        if current != blob:
            writes.append((rel, blob, rel not in dest_hashes, changes_git))
            if not changes_git:
                normalized_only.append(rel)

    # --- Report ---------------------------------------------------------------
    print(f"{DIM}source{RESET}  {src_root}  @ {git_text(src_repo, 'rev-parse', '--short', 'HEAD').strip()}")
    print(f"{DIM}dest  {RESET}  {dest}")
    print(f"\n  ship {len(ship)} tracked files   "
          f"({len(excluded)} excluded by .cleanignore, {len(protected)} protected in dest)")
    new = [r for r, _, isnew, cg in writes if isnew and cg]
    mod = [r for r, _, isnew, cg in writes if not isnew and cg]
    print(f"  {GREEN}+{len(new)} new{RESET}   {YELLOW}~{len(mod)} modified{RESET}   {RED}-{len(to_delete)} deleted{RESET}")
    for r in new:
        print(f"    {GREEN}+ {r}{RESET}")
    for r in mod[:25]:
        print(f"    {YELLOW}~ {r}{RESET}")
    if len(mod) > 25:
        print(f"    {DIM}... and {len(mod) - 25} more modified{RESET}")
    for r in to_delete:
        print(f"    {RED}- {r}{RESET}")
    if normalized_only:
        print(f"  {DIM}({len(normalized_only)} file(s) rewritten to fix CRLF on disk; "
              f"no change to git content){RESET}")

    if not new and not mod and not to_delete:
        print(f"\n{GREEN}Already in sync.{RESET} "
              + (f"({len(normalized_only)} line-ending fix(es) applied.)" if normalized_only and not args.check else "Nothing to commit."))
        if not normalized_only or args.check:
            return 0

    if args.check:
        print(f"\n{YELLOW}--check{RESET}: destination is NOT in sync (nothing written).")
        return 1

    if not args.yes:
        print()
        if input("Apply these changes? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Aborted; nothing written.")
            return 1

    # --- Apply ----------------------------------------------------------------
    for rel, blob, _, _cg in writes:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)          # bytes straight from git: LF preserved
    for rel in to_delete:
        (dest / rel).unlink(missing_ok=True)
    # Drop directories left empty by deletions.
    for d in sorted((p for p in dest.rglob("*") if p.is_dir()), key=lambda p: -len(p.parts)):
        if ".git" in d.parts:
            continue
        if not any(d.iterdir()):
            d.rmdir()

    print(f"\n{GREEN}Wrote {len(writes)} file(s), deleted {len(to_delete)}.{RESET}")
    print(f"\nNothing has been committed or pushed. Review, then commit in {dest.name}:")
    print(f"  {DIM}cd {dest}{RESET}")
    print(f"  {DIM}git status && git diff{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
