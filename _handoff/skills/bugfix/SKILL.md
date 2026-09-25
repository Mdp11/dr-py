---
name: bugfix
description: Guide a bug from report to merge. You lead the diagnosis and the fix decision; the reading and the building go to the agent roster (searcher, tracer, implementer, critical-implementer, task-reviewer, escalation-debugger, branch-reviewer, chores). Run it in an Opus session.
argument-hint: <the bug: symptom, error, issue link, or a diagnosis/plan path to resume>
disable-model-invocation: true
---

You are guiding the user through a bug from report to merge. You lead the diagnosis and decide the shape of the fix yourself; the reading and the building go to subagents, each on the model that suits it.

Bug: $ARGUMENTS

## Before anything else

If no bug was given, ask for the symptom and how to reproduce it. If the argument is the path of an existing diagnosis, resume at stage 2; if it is a plan, resume at stage 3.

## Running the stages

There are four stages. Open each with one line naming it (`Stage 1 of 4: Diagnose`) and what the user will decide at its end. Close each at a gate: summarize what was decided, point to what the user should check (file paths), and wait for their go-ahead. Never cross a gate on your own.

Keep your own context for judgment. Send code reading to subagents: `searcher` to find where things are, `tracer` to understand how the mechanism behaves. Ask for conclusions with `path:line` evidence, not file dumps.

## Stage 1: Diagnose

Find the root cause with the superpowers:systematic-debugging skill. No fix is written in this stage.

The stage produces:
- **A reproduction**: a failing test that captures the bug, committed on the branch. When the bug cannot be captured in a test (environment, timing, infrastructure), a written sequence of steps that reproduces it instead, with the reason no test is possible.
- **The root cause**: what goes wrong, where (`path:line`), and the evidence that confirms it, as opposed to the hypotheses that were ruled out.
- **The blast radius**: other callers, data or paths the same cause affects, and whether data already written needs repair.

If two hypotheses fail, or the behavior makes no sense, dispatch `escalation-debugger` with the symptom, the reproduction and what has been ruled out.

Write the diagnosis to `docs/superpowers/diagnoses/YYYY-MM-DD-<topic>.md`.

Gate: the user agrees with the root cause.

## Stage 2: Shape the fix

Judge the size of the fix and propose one of two paths, with your reasoning:

- **Direct fix**: one task, localized, no open design questions. Describe the fix in a few lines and tag it `implementer` (fully specified) or `critical-implementer` (touches invariants, concurrency, performance, security, data integrity or protocols, or leaves a real decision open), with a one-line reason for a `critical-implementer` tag.
- **Planned fix**: several tasks, a redesign, or a data repair. Write the plan with superpowers:writing-plans, using the diagnosis as the spec. Every task names the tests that prove it and carries an agent tag, as above. The reproduction test from stage 1 must pass by the end of the plan. When the planning skill reaches its execution choice, don't offer it; stage 3 replaces it.

When the fix needs design choices the diagnosis does not settle, say so: the user may prefer to run `/feature` with the diagnosis path, starting at its planning stage.

Gate: the user approves the fix, or the plan with its tags.

## Stage 3: Build

- **Direct fix**: dispatch the tagged agent with the fix description, the diagnosis path and the reproduction test; then `task-reviewer` on the diff. Send findings back until the review is clean, escalating one tier (`implementer` → `critical-implementer` → `escalation-debugger`) if a round fails to converge. The reproduction test must pass and the full suite must stay green.
- **Planned fix**: offer the same two ways as `/feature`, with your recommendation. **Hand off to a fresh session**: the user starts a new session in the same directory and runs `/build-plan <plan path>`; your part ends there. **Build here**: read `~/.claude/skills/build-plan/SKILL.md` and follow it with the plan path.

## Stage 4: Finish

- **Direct fix**: run `branch-reviewer` only when the fix carried a `critical-implementer` tag; fix its findings. Then `chores` writes the commit message, PR description and changelog entry, and the user decides between merge and PR through superpowers:finishing-a-development-branch.
- **Planned fix**: build-plan covers it.

In both cases, present the root cause, the fix, any rulings made along the way, and any data repair still owed before the merge-or-PR decision.
