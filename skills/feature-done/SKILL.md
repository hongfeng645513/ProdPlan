---
name: feature-done
description: Wraps up a completed feature - commits the staged work and
  archives its spec. Triggered when finishing a feature, "feature done",
  "wrap up", "clean up feature".
model: sonnet
---

This repo has no linter or test suite (see CLAUDE.md), so there are no
build checks to run — this skill focuses on committing the finished work
cleanly and filing its spec away.

1. Read the staged diff
2. Write a conventional commit message from the diff
3. Show the message for approval, then run `git commit -m`
4. Archive the spec: move specs/[feature-name].md to specs/archive/
5. Report what was committed and confirm the branch is clean
