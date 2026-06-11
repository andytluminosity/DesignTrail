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

2. Call `AskUserQuestions` with exactly one single-select question:

- id: `annotationMode`
- prompt: `How should DesignTrail annotate this commit?`
- options:
  - `Skip annotations`
  - `Manually add annotation`
  - `AI generated annotations`
  - `Manual and AI generated annotations`

3. If the user chose `Manually add annotation` or `Manual and AI generated annotations`, ask for a short manual annotation describing the design intent behind the change.

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
