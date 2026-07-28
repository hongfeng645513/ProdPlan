---
name: feature-start
description: Sets up a new feature workflow - creates branch, writes spec
  file, produces initial plan. Triggered when starting a new feature or
  "set up feature", "start feature", "new feature".
model: opus
---

Ask me one question at a time to understand the feature:
1. What are we building?
2. What decisions have already been made?
3. What is the definition of done?

Then:
- Create a branch: git checkout -b feature/[feature-name]
- Create specs/[feature-name].md with my answers as the spec
- Enter plan mode and produce an initial implementation plan
- Show me the plan for approval before anything is implemented
