---
name: feature
description: Guide a new feature from idea to merge. You lead the design and the plan; the reading and the building go to the agent roster (searcher, tracer, implementer, critical-implementer, task-reviewer, escalation-debugger, branch-reviewer, chores). Run it in an Opus session.
argument-hint: <what you want to build, or a spec/plan path to resume>
disable-model-invocation: true
---

You are guiding the user through a feature from idea to merge. You lead the design and the plan yourself; the reading and the building go to subagents, each on the model that suits it.

Feature: $ARGUMENTS

## Before anything else

If no feature was given, ask what they want to build. If the argument is the path of an existing spec, resume at stage 2; if it is a plan, resume at stage 3.

## Running the stages

There are four stages. Open each with one line naming it (`Stage 2 of 4: Plan`) and what the user will decide at its end. Close each at a gate: summarize what was decided, point to what the user should check (file paths), and wait for their go-ahead. Never cross a gate on your own.

Keep your own context for design and judgment. Send code reading to subagents: `searcher` to find where things are, `tracer` to understand how an existing mechanism behaves. Ask for conclusions with `path:line` evidence, not file dumps.

## Stage 1: Design

Judge the size first. If the feature fits comfortably in one session and carries little risk, say so: the lighter path is to build it directly, without the staged workflow, and have `task-reviewer` check the diff. Let the user choose.

Otherwise, design it with the superpowers:brainstorming skill. If that skill is not installed, run the same process yourself: questions one at a time, two or three approaches with your recommendation, then a written spec.

Gate: the user approves the spec.

## Stage 2: Plan

Write the implementation plan with superpowers:writing-plans. Beyond what that skill asks, every task must:
- name the tests that prove it, and
- carry an agent tag: `implementer` when the task is fully specified; `critical-implementer` when it touches invariants, concurrency, performance, security or protocols, or leaves a real decision open. Give every `critical-implementer` tag a one-line reason.

When the planning skill reaches its execution choice, don't offer it; stage 3 replaces it.

Gate: the user approves the plan, tags included.

## Stage 3: Build

Offer two ways to build, with your recommendation:

- **Hand off to a fresh session** (the default): a clean context, and faster turns. Tell the user to start a new session in the same directory and run `/build-plan <plan path>`. Say what to expect: the build runs task by task without check-ins, then a final review and the merge-or-PR decision. Your part ends there.
- **Build here, with you orchestrating**: slower and pricier per orchestration turn, but the design conversation stays in context for the rulings a build makes where the plan is silent. Recommend it when the plan leaves judgment calls open or the feature is high-risk. To do it, read `~/.claude/skills/build-plan/SKILL.md` and follow it with the plan path.

## Stage 4: Finish

build-plan covers it: `branch-reviewer` gives the final verdict, its findings are fixed, `chores` writes the PR description and changelog, and the user decides between merge and PR. If you orchestrated the build, present the verdict and the rulings made along the way before that decision.
