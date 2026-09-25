---
name: build-plan
description: Build a written implementation plan through the agent roster — each task to implementer or critical-implementer as the plan tags it, task-reviewer after each, escalation for stuck tasks, branch-reviewer at the end, chores for PR text and docs. Run it in the session that orchestrates the build, normally Opus.
argument-hint: <plan path>
disable-model-invocation: true
---

Build the plan at: $ARGUMENTS

If no path was given, ask for it.

Run the plan with the superpowers:subagent-driven-development skill. Follow its process (setup, ledger, task loop, fix rounds, rulings, final review) with the changes below to how it dispatches subagents. They come from the user and take precedence over the skill's defaults, its model-selection section included.

**Which agent.** Dispatch to these agent types instead of `general-purpose`, still using the skill's own prompt templates as the prompt:
- Implementing a task: the agent its tag names, `implementer` or `critical-implementer`. For an untagged task, choose by the same rule: fully specified → `implementer`; touches invariants, concurrency, performance, security or protocols, or leaves a decision open → `critical-implementer`.
- Task reviews and scoped re-reviews: `task-reviewer`.
- Fix rounds 4–5 (the skill's escalation): one tier up — `critical-implementer` for an `implementer` task, `escalation-debugger` for a `critical-implementer` task — briefed with the task, the open findings and what has been tried. If the findings describe a bug whose cause is still unknown after two rounds, go to `escalation-debugger` then rather than waiting for round 4.
- Final whole-branch review: `branch-reviewer`.
- PR description, changelog and doc updates at the end: `chores`.

**No model parameter.** Do not pass `model` on these dispatches. Each agent's definition sets its model and effort, and an explicit model would override them.

If superpowers:subagent-driven-development is not available, run the same loop yourself: for each task in order, dispatch its implementer with the task text and the spec path, then `task-reviewer` on the task's diff; send findings back to the implementer, escalating as above, until the review is clean; after the last task, `branch-reviewer` on the whole branch.

When the final review is clean, report to the user: the tasks built, every ruling made along the way and what it costs if wrong, and the branch-reviewer's verdict. Then hand them the merge-or-PR decision through superpowers:finishing-a-development-branch.
