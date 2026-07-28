---
name: commit-and-push
description: >-
  Stage every change in the working tree, commit it with an auto-generated
  message, and push to the main branch on origin. Use this whenever the user
  wants to save and publish their current work in one step — phrases like
  "commit and push", "push my changes", "ship it", "save everything to GitHub",
  "commit everything and push to main", or "sync my work up". Trigger even when
  the user doesn't spell out all three steps (find/commit/push) but clearly
  means "get my current changes onto main". This skill is tuned for the Stock
  Watch repo, whose GitHub Action commits data to main on a schedule, so it
  always pulls with rebase before pushing to avoid rejected pushes.
---

# Commit and push to main

Take everything currently changed in the working tree and get it safely onto
`origin/main` in one guided flow: inspect → stage → commit (auto-message) →
pull --rebase → push. The goal is a clean, honest, one-command "ship my work"
that never does anything destructive and never hides what it's doing.

## Why this skill exists (context that shapes every step)

This repo is unusual in a way that matters here: a GitHub Action refreshes
`data/stocks.json` and **commits directly to `main` several times per weekday**.
That means `origin/main` frequently moves *underneath* your local branch. A
plain `git push` will then be rejected ("fetch first"), and the naive fix people
reach for — a force push — would **destroy the bot's data commits**. So this
skill always rebases local work on top of the remote before pushing, and it
**never force-pushes**. The repo's `.claude/settings.json` also denies force
pushes and asks for confirmation on commit/push; expect those prompts — they are
the safety net working as intended, not errors.

## The workflow

Run these steps in order. Show the user what you find at each stage — this
operation publishes their work, so visibility matters more than speed.

### 1. Confirm there's something to do, and where you are

```bash
git rev-parse --is-inside-work-tree   # bail out cleanly if not a git repo
git branch --show-current
git status --short
```

- **Nothing changed?** Stop and say so plainly ("working tree is clean — nothing
  to commit"). Do not create an empty commit unless the user explicitly asks.
- **Not on `main`?** Don't silently switch branches or push another branch's tip
  to `main` — that's surprising and easy to get wrong. Tell the user which branch
  they're on and ask how they want to proceed (commit here and push this branch,
  switch to main first, or open a PR). Only continue straight through when the
  current branch is `main`.

### 2. Show the changes, then stage everything

```bash
git status
git diff --stat HEAD          # a quick shape-of-the-change overview
git add -A
```

`git add -A` stages modifications, new files, and deletions across the whole
repo. It respects `.gitignore`, so ignored files like `.claude/settings.local.json`
stay out automatically. If the diff is large, skim `git diff --cached` enough to
write an honest commit message — you don't need to read every line.

### 3. Write a commit message from the actual diff

Generate the message yourself from what changed — don't ask the user (they chose
auto-generation). Aim for a Conventional-Commits-style subject plus a short body
when the change is non-trivial:

- Subject line ≤ ~72 chars, imperative mood, prefixed by type when it's clear
  (`feat`, `fix`, `docs`, `chore`, `refactor`, `data`).
- Body (optional): 1–3 lines on *what* and *why*, only if it adds real signal.
- End with the co-author trailer so authorship is transparent.

**Example — small doc tweak:**
Input: edited README troubleshooting section
Output:
```
docs: clarify ticker troubleshooting steps in README
```

**Example — multi-file feature:**
Input: added a new watchlist endpoint in serve.py + wired a button in index.html
Output:
```
feat(dashboard): add per-list membership editing

Add /api/setlists endpoint and an "On lists" toggle in the stock
detail panel so a stock can be moved between lists without a refetch.
```

Commit with a heredoc so multi-line messages and special characters survive:

```bash
git commit -m "$(cat <<'EOF'
<subject line>

<optional body>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

This will trigger the repo's commit-confirmation prompt. That's expected — let it
through to the user.

### 4. Pull --rebase, then push

```bash
git pull --rebase origin main
git push origin main
```

Rebase first so your commit lands cleanly on top of whatever the data-bot pushed.

- **Rebase reports conflicts?** Stop immediately. Do **not** guess at resolving
  data-file conflicts or run `git rebase --skip`/`--abort` on the user's behalf
  without telling them. Report which files conflict and ask how they want to
  resolve. (Conflicts here are almost always in `data/stocks.json` from the bot —
  usually the user wants the newer data, but that's their call.)
- **Push still rejected after a clean rebase?** Re-fetch and rebase once more; the
  bot may have pushed again in the meantime. **Never** reach for `--force` or
  `--force-with-lease` — those are denied in this repo precisely because they'd
  drop the bot's commits.

### 5. Report honestly

Tell the user exactly what happened: the commit hash and subject, the ref update
range from the push (e.g. `d266bfd..a1b2c3d main -> main`), and the fact that it's
now live on `origin/main`. If any step was skipped (nothing to commit) or stopped
(conflict, non-main branch), say that clearly instead of implying success.

## Hard guardrails

- **Never force-push** (`--force`, `-f`, `--force-with-lease`). It would erase the
  data-bot's commits and is denied by repo settings anyway.
- **Never `git add -A` and commit if the user only wanted specific files.** This
  skill is the "everything" flow; if they scope it down, honor that.
- **Never resolve merge/rebase conflicts blind.** Surface them and hand back to
  the user.
- **Never fabricate a result.** If the push failed, show the error verbatim.
