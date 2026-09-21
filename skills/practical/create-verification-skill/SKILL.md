---
name: create-verification-skill
description: "Generate a project-local verification skill that drives the app the way a user does. Use when a repository has no repeatable way for an agent to prove real UI, CLI, or service behavior."
---

# Create a verification skill

Generate a project-local skill that launches the real app, exercises a feature the way a user would, and captures evidence. Write it for the next agent, not for a human.

Pi loads project skills from `.pi/skills/` (and `.agents/skills/` when present). Do not write `.cursor/skills/` unless this repository already uses that layout.

## 1. Interview the repo, not the user

Answer these from the codebase. Ask the user only what you cannot observe:

- **Surface:** web UI, CLI/TUI, desktop app, API, library. Pick the primary one.
- **Run:** the repo's own documented dev command. Note ports, env, seed data, auth.
- **Drive:** existing harnesses first (Playwright, expect, PTY, curl). Only then a generic recipe.
- **Observe:** screenshots, transcripts, response bodies, logs, exit codes, DB state.
- **Isolate:** can two instances run side by side? If not, say so.

If the checkout does not start, fix that or report it before generating.

## 2. Generate the skill

Write `.pi/skills/verify-<app>/SKILL.md` with frontmatter (`name: verify-<app>` and a description that names the app and surface) and these sections, grounded in what you found:

- **Launch** and how to tell it is ready, plus teardown
- **Doctor:** one read-only check that the instance is worth driving
- **Drive:** real selectors or commands from this repo
- **Evidence:** what to capture and where it goes. Exercise the real user path. Verify side effects.
- **Cleanup:** tear down what you started. Evidence survives.
- **Helpers:** any script is executable and invoked in the skill body

## 3. Seed the feature map

Create `.pi/skills/verify-<app>/features/README.md` plus one file per user-facing feature you can identify (start with 3-5). Follow `references/feature-map-example/`. Each file answers, from the user's point of view: what it is, how to reach it, how to drive it, and what observable end state proves it.

## 4. Prove it

Run launch, doctor, drive one mapped feature, capture evidence, clean up. After cleanup, confirm the evidence still exists. A skill that was never executed is a draft.

## 5. Maintenance

Point at `maintain-verification-skill` for keeping the map honest.
