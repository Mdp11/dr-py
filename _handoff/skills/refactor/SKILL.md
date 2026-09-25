---
name: refactor
description: Guide a refactor from motivation to merge without changing behavior. You lead the target design and the plan; the reading and the building go to the agent roster (searcher, tracer, implementer, critical-implementer, task-reviewer, escalation-debugger, branch-reviewer, chores). Run it in an Opus session.
argument-hint: <what to restructure and why, or a spec/plan path to resume>
disable-model-invocation: true
---

You are guiding the user through a refactor from motivation to merge. The one invariant is that observable behavior does not change. You lead the target design and the plan yourself; the reading and the building go to subagents, each on the model that suits it.

Refactor: $ARGUMENTS

## Before anything else

If no refactor was given, ask what they want to restructure and what problem the current shape causes. If the argument is the path of an existing spec, resume at stage 2; if it is a plan, resume at stage 3.

## Running the stages

There are four stages. Open each with one line naming it (`Stage 1 of 4: Target`) and what the user will decide at its end. Close each at a gate: summarize what was decided, point to what the user should check (file paths), and wait for their go-ahead. Never cross a gate on your own.

Keep your own context for design and judgment. Send code reading to subagents: `searcher` to find where things are and every caller of what will move, `tracer` to understand how the current mechanism behaves. Ask for conclusions with `path:line` evidence, not file dumps.

## Stage 1: Target

Judge the size first. If the refactor fits comfortably in one session and carries little risk (a rename, an extraction, a move within one module), say so: the lighter path is to do it directly, without the staged workflow, and have `task-reviewer` check the diff for behavior changes. Let the user choose.

Otherwise, write a spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-refactor.md` covering:
- **Motivation**: what the current shape makes hard, with `path:line` examples.
- **Current shape**: the modules, boundaries and callers involved, as `tracer` and `searcher` report them.
- **Target shape**: the modules, boundaries and interfaces after the refactor. When there is a real choice, use the superpowers:brainstorming skill to settle it: two or three approaches with your recommendation. If that skill is not installed, run the same process yourself.
- **Behavior contract**: what must not change: public APIs, wire and storage formats, error behavior, performance-sensitive paths, and anything else callers depend on.
- **Safety net**: which existing tests pin that contract, and the gaps where behavior that will move has no test.
- **Out of scope**: related cleanups that will not be done here.

Gate: the user approves the spec.

## Stage 2: Plan

Write the implementation plan with superpowers:writing-plans. Beyond what that skill asks:
- The plan's header links the spec and restates its behavior contract, so a build in another session reviews against it.
- The first tasks close the safety-net gaps with characterization tests that pass against the current code, before any structure changes.
- Every later task is one behavior-preserving step that leaves the suite green and could be merged on its own. Prefer sequences that keep old and new paths side by side (introduce, migrate callers, remove) over one large swap.
- Every task names the tests that prove it. For a structural step that is the existing suite, unchanged; a task that must edit an existing test (for an import path or a renamed symbol) says which and why, and never changes an assertion.
- Every task carries an agent tag: `implementer` when it is fully specified; `critical-implementer` when it touches public APIs, persistence formats, concurrency or performance-sensitive paths, or leaves a real decision open. Give every `critical-implementer` tag a one-line reason.
- Every task states "Behavior-preserving: a bug found here is recorded in the plan's deferred-bugs list, not fixed", so implementers and reviewers see it.

When the planning skill reaches its execution choice, don't offer it; stage 3 replaces it.

Gate: the user approves the plan, tags included.

## Stage 3: Build

Offer two ways to build, with your recommendation:

- **Hand off to a fresh session** (the default): a clean context, and faster turns. Tell the user to start a new session in the same directory and run `/build-plan <plan path>`. Your part ends there.
- **Build here, with you orchestrating**: recommend it when the plan leaves judgment calls open or the refactor touches the behavior contract closely. To do it, read `~/.claude/skills/build-plan/SKILL.md` and follow it with the plan path.

## Stage 4: Finish

build-plan covers it: `branch-reviewer` gives the final verdict, its findings are fixed, `chores` writes the PR description and changelog, and the user decides between merge and PR. Brief `branch-reviewer` with the spec's behavior contract so it reviews for behavior changes, not only for bugs.

Before that decision, present the verdict, the rulings made along the way, and the deferred-bugs list, suggesting `/bugfix` for each bug worth fixing.
