---
name: handoff
description: Use when the current session's context window is filling up, is being compacted, or the user says they will start a new/fresh session, switch sessions, continue elsewhere, or asks for a handoff, continuation prompt, or "prompt to paste into the next session".
---

# Handoff

## Overview

Compress the live session into a durable artifact so a fresh session reaches the same
working state without re-reading the transcript.

**Core principle: pointers over payload.** Anything that lives on disk gets referenced by
`path:line`, never pasted. Only what exists *solely in this conversation* — decisions,
dead ends, deferrals, plan — gets written down. That knowledge is the entire reason this
skill exists; the code is already on disk.

## Procedure

1. Reconstruct state. Do not trust old tool output — facts decay across a long session.
   Re-run the cheap ones now: `git status --short`, `git branch --show-current`,
   `git log --oneline -5`. If a test/lint result is going in the handoff, either re-run
   it or mark it with when it was last true.
2. Write the handoff to a file (see Where To Write).
3. Reply with the paste-line, then the full handoff in one fenced block. Nothing else.

## The Handoff Contract

The handoff file has these sections, in this order, with these headings. Every section is
REQUIRED. A section with nothing in it says `None.` — an empty section is information
(it tells the next session not to go looking).

```markdown
# Handoff: <short task name>

## Mission
<2-4 sentences: what we are building, absolute path to the project, what "done" means.>

## Orient First
<Numbered list of files to read, as path or path:line, each with one clause on why.>
<Then the commands to confirm state: test cmd, lint cmd, git status.>
Treat everything below as *as-of* notes, not current fact. Verify before you rely on it.

## State
- Branch: <name>
- Uncommitted: <files, or "clean">
- Tests: <result> (as of <when>)
- <Anything else needed to resume: running servers, env vars, migration revision.>

## Standing Constraints
<Decisions already made, each with its one-line reason. The reason is what stops the
next session from relitigating. Include tool/style preferences that are not in CLAUDE.md.>

## Done
<What has been completed. The next session must not redo these.>

## Known Issues, Not Yet Fixed
<Diagnosed but unfixed problems, with path:line. Say diagnosed, not suspected, only if verified.>

## Deferred — Do Not Do
<Work that was raised and then explicitly postponed or rejected, with who deferred it.
Only work that someone proposed and someone declined. Not plan ordering, not restated
constraints. This section is why the next session does not "helpfully" rebuild what we removed.>

## Plan
<Numbered next actions in order. State the first one concretely enough to begin without asking.>

## Open Questions
<Anything needing the user's decision before proceeding.>
```

## Where To Write

`~/.claude/handoffs/<project-name>-<YYYY-MM-DD-HHMM>.md`

Get the timestamp with `date +%Y-%m-%d-%H%M`. Create the directory if needed. Write outside
the repo so the handoff never lands in a commit or a diff.

## What To Reply

The file is the artifact; the reply is the delivery. Give the user both a one-line paste
(cheapest) and the inline copy (works if the new session cannot read the path):

```
Handoff written to ~/.claude/handoffs/invoicer-2026-07-10-1432.md

Paste this into the new session:

    Read ~/.claude/handoffs/invoicer-2026-07-10-1432.md and continue from the Plan section.

Or paste the full text:

<the complete handoff, fenced>
```

## Quick Reference

| Content | Goes in handoff? |
|---|---|
| Source code that exists on disk | No — cite `path:line` |
| A decision and the reason behind it | Yes — Standing Constraints |
| Work the user told you to hold off on | Yes — Deferred |
| A dead end you burned an hour on | Yes — Standing Constraints, one line |
| Something already in CLAUDE.md | No — say "read CLAUDE.md" in Orient First |
| Test results from 200 messages ago | Only with an as-of marker, or re-run |
| Narrative of how the session unfolded | No |

## Common Mistakes

**Restating the repo.** If the next session can learn it by opening a file, give it the
path. The handoff carries what the *filesystem cannot tell it*.

**Dropping the deferrals.** The most expensive loss. A fresh session sees an obvious
missing optimization and adds it back, undoing a deliberate choice. This section is
load-bearing.

**Recording decisions without reasons.** "Use `field_validator`" invites a rewrite the
moment `model_validator` looks cleaner. "Use `field_validator` — `model_validator(mode='before')`
mangles nested models here" survives.

**Presenting stale state as fact.** Re-run git and the test command, or timestamp the claim.

**Burying the artifact in prose.** The user is going to copy this. One fenced block, no
lead-in, no commentary after.

## Real-World Impact

A fresh session that reads a handoff spends its first tokens on the four or five files that
matter, instead of rediscovering the repo — and does not undo the decisions the last session
paid for.
