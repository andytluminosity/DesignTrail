---
allowed-tools: AskUserQuestions, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(git rev-parse:*), Bash(pwd)
description: Commit changes through DesignTrail with annotation options
---

# Commit Design

Create a Git commit and let DesignTrail capture the resulting design snapshot.

## Preconditions

- The target repository already has the DesignTrail `post-commit` hook installed with `npm run track -- <repo-path>`.
- The app being captured is running at `CAPTURE_URL` (usually `http://localhost:3000`).
- Use the current working directory unless the user gives a different repo path.

## Workflow

1. Inspect the working tree and staged changes before committing:

```bash
git status --short
git diff
git diff --staged
git log --oneline -5
```

2. Use the `AskUserQuestions` tool to ask exactly one single-select multiple-choice question. This first annotation-mode question must be rendered through the tool UI, not as a plain chat question or numbered text list.

Question: `How should DesignTrail annotate this commit?`

Options:

- `Skip annotations`
- `Manually add annotation`
- `AI generated annotations`
- `Manual and AI generated annotations`

Do not ask the user to type the option number or option label for this first question.

3. If the user chose `Manually add annotation` or `Manual and AI generated annotations`, stop and ask this exact follow-up in normal chat:

`Please type the manual DesignTrail annotation for this commit. I will wait for your reply before staging or committing.`

Do not use `AskUserQuestions` for this text entry. Do not run `git add`, `git commit`, or any other shell command until the user replies with the annotation text. Use the user's reply exactly as `DESIGNTRAIL_ANNOTATION`.

If the user chose `Skip annotations` or `AI generated annotations`, do not ask for manual annotation text.

4. Stage only the files relevant to the user-requested commit.

5. Run `git commit` with DesignTrail environment variables on the same command invocation so the post-commit hook receives the selected mode:

```bash
DESIGNTRAIL_SOURCE=claude \
DESIGNTRAIL_SKIP_PROMPT=1 \
DESIGNTRAIL_AI_ANNOTATIONS=<true-or-false> \
DESIGNTRAIL_ANNOTATION="<manual annotation when present>" \
git commit -m "<commit message>"
```

For `Skip annotations`, set `DESIGNTRAIL_AI_ANNOTATIONS=false` and omit `DESIGNTRAIL_ANNOTATION`.

For `Manually add annotation`, set `DESIGNTRAIL_AI_ANNOTATIONS=false` and include `DESIGNTRAIL_ANNOTATION`.

For `AI generated annotations`, set `DESIGNTRAIL_AI_ANNOTATIONS=true` and omit `DESIGNTRAIL_ANNOTATION`.

For `Manual and AI generated annotations`, set `DESIGNTRAIL_AI_ANNOTATIONS=true` and include `DESIGNTRAIL_ANNOTATION`.

6. After the commit completes, summarize:

- Commit hash and message.
- Which DesignTrail annotation mode was used.
- Whether the post-commit hook reported a successful capture.

## Safety

- Do not commit secrets such as `.env` or credential files.
- Do not bypass hooks unless the user explicitly asks.
- Do not amend, reset, force-push, or run destructive Git commands unless explicitly requested.
