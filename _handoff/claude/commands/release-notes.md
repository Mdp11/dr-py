---
description: Generate animal-themed release notes for a version tag, in the loop house style
argument-hint: "[version] [animal] — both optional; defaults to latest tag + a fresh animal"
allowed-tools: Bash(git tag:*), Bash(git log:*), Bash(git describe:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh api:*)
---

You are writing **release notes** in the established house style. Follow this process exactly.

## 1. Resolve the version

- Target version: `$1` if provided, otherwise the latest tag.
  - Latest tag: `git tag --sort=-creatordate | head -1`
- Previous version: the tag immediately before the target (for the changelog diff range).
  - `git tag --sort=-creatordate` and pick the entry after the target.

## 2. Gather the real changes (do not invent anything)

Find every PR merged between the previous tag and the target tag:

```
git log <previous>..<target> --oneline --no-merges
```

For richer detail and PR numbers, also use:

```
gh pr list --state merged --search "merged:<prev-date>..<target-date>" --limit 100 --json number,title,body,labels,url
```

Group the changes into the standard sections (below). Use the PR titles, bodies, and labels to decide what's a **Major Feature**, an **Improvement**, or a **Bug Fix**. Link every item to its real PR URL (`https://github.com/variant-tech/loop/pull/<number>`). Never fabricate PR numbers, features, or behavior — only describe what the commits/PRs actually changed.

## 3. Pick the animal

- Use `$2` if the user named an animal.
- Otherwise pick a **fresh, distinctive animal not used in recent releases** (the reference release was a Centipede — avoid repeating recent ones).
- The animal must be a genuine metaphor for the release's headline theme (e.g. parallelism → centipede). Pick the animal AFTER you understand the major feature, so the metaphor fits. Briefly explain the metaphor in the opening paragraph, including a playful "unlike / like this animal…" twist.

## 4. Write the notes in this exact format

```
Release Notes: v<VERSION> <Adjective> <Animal> <emoji matching the headline theme>

<Opening paragraph: name the animal metaphor, tie it to the release's biggest change,
and include a playful comparison to the animal's real-world behavior.>

---

:dart: Major Features

:<emoji>: <Feature Title> (<PR url>)

<1-2 sentence summary of the feature.>

- <Bullet>: <detail>
- <Bullet>: <detail>
...

---

:rocket: Improvements

:<emoji>: <Improvement Title> (<PR url>)

<Short description.>

---

:bug: Bug Fixes

- <Title> (<PR url>) — <what was fixed>
...

Full Changelog: https://github.com/variant-tech/loop/compare/<previous>...<VERSION>
```

## Rules

- Match the tone of the reference: technical but witty, emoji-led section headers, the animal woven through the intro.
- Omit a section entirely if there are no items for it (don't write "Bug Fixes: none").
- Output ONLY the finished release notes as a clean markdown block, ready to paste.
