---
name: handoff
description: Hand the work over to a fresh session when the current context is too full — finish the task in progress, write a disposable handoff file (deleted by the next session once read), and print a ready-to-paste prompt for the next session. Use when the user says the context is full, too long, saturated, asks for a handoff / to prepare the next session, or wants to restart cold / from a clean slate — e.g. "context is full", "prepare a handoff", "let's continue in a new session", "write the handoff", "let's start fresh", "cold start", "restart from scratch with a clean context", "le contexte est plein", "prépare un handoff", "on continue dans une nouvelle session", "passe la main", "on repart à froid", "repartir à froid", "reprendre à froid", "on repart sur une session propre".
---

# Session handoff

The context of this session is nearly exhausted. The goal is to let a fresh session pick up the work with no loss, at minimal cost, and leave nothing behind.

## 1. Finish the current task first

- If a task is in progress, **do not stop to write the handoff**. Finish it — including its verification (tests, build, lint) — exactly as you would have without this request.
- Do not start any new task, refactor or follow-up after it.
- If the task cannot be finished (blocked, waiting on the user, failing for an unknown reason), stop at the cleanest possible point and record exactly where you stopped and why.
- Stay terse from now on: no recaps, no re-reading files you already know, so the remaining context goes to the work.

Do not commit, push or stash on your own initiative; record the working-tree state instead.

## 2. Write the handoff file

Path, outside the project so it can never be committed:

```
${TMPDIR:-/tmp}/agent-handoff/<project-dir-name>-<YYYYMMDD-HHMMSS>.md
```

Create the directory if needed and resolve the path to an absolute one.

Write it for a reader that has the repository but **none** of this conversation. Include only what cannot be recovered from the code, the git history or the project docs; point to files and commits instead of copying them.

```markdown
# Handoff — <project> — <date time>

## Goal
What the user is ultimately trying to achieve, in their terms. One or two sentences.

## State
- Branch, last relevant commits (hash + subject).
- Uncommitted changes (`git status --short`), and whether they are intended.
- Last verification run and its result (command + pass/fail).

## Done
What was completed in this session, briefly, with file paths.

## Next
Ordered list of remaining steps. The first one must be immediately actionable.

## Decisions
Choices made with the user and why — so the next session does not re-ask or re-litigate them.

## Dead ends & gotchas
What was tried and failed, traps, non-obvious constraints, flaky commands.

## User preferences
Instructions the user gave in this session about how to work (style, scope, things not to do).

## Key files
`path` — one line on its role in this task.
```

Drop any section that would be empty. Aim for under ~80 lines: dense facts, no narration. Never write secrets (tokens, passwords, keys) into it; name where they live instead.

## 3. Print the prompt for the next session

End your reply with the handoff path and a single fenced block the user can paste as-is into a new session. Write the prompt in the language the user speaks in this session. Template (English):

````
```
Read the handoff file <absolute path>, then delete it immediately (`rm <absolute path>`) — it is disposable and its content is now in your context. Treat it as the state of the work; check that the branch and working tree match its "State" section (tell me if they don't), then continue from the first step of "Next". Do not re-ask the user about anything listed under "Decisions".
```
````

Nothing after the block except, if useful, one short line (e.g. "uncommitted changes are left in the working tree on purpose").
