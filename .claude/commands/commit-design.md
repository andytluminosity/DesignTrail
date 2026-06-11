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

1. Before any other questions, call `AskUserQuestions` with one single-select question so the user can choose with the up/down arrows:

- prompt: `Should DesignTrail render the Miro board for this commit?`
- options:
  - `Yes, render Miro`
  - `No, store locally only`

2. Inspect the working tree and staged changes before committing:

```bash
git status --short
git diff
git diff --staged
git log --oneline -5
```

3. Stage only the files relevant to the user-requested commit.

4. If the user chose `No, store locally only`, run `git commit` with DesignTrail capture enabled, annotation prompts disabled, and Miro rendering disabled:

```bash
DESIGNTRAIL_SOURCE=claude \
DESIGNTRAIL_SKIP_PROMPT=1 \
DESIGNTRAIL_DEFAULT_ANNOTATION_MODE=skip \
DESIGNTRAIL_SYNC_MIRO=false \
git commit -m "<commit message>"
```

5. If the user chose `Yes, render Miro`, run `git commit` with DesignTrail Miro rendering enabled and allow the post-commit hook to ask for per-screenshot annotation choices during the capture:

```bash
DESIGNTRAIL_SOURCE=claude \
DESIGNTRAIL_SKIP_PROMPT=0 \
DESIGNTRAIL_DEFAULT_ANNOTATION_MODE=ai \
DESIGNTRAIL_SYNC_MIRO=true \
git commit -m "<commit message>"
```

Do not call `POST /snapshot/annotations` after this commit. The hook has already applied annotation choices and, when requested, rendered the board once.

6. After the hook completes, summarize:

- Commit hash and message.
- Each screenshot/component's annotation mode.
- Whether the post-commit hook reported a successful capture and whether Miro rendered.

## Safety

- Do not commit secrets such as `.env` or credential files.
- Do not bypass hooks unless the user explicitly asks.
- Do not amend, reset, force-push, or run destructive Git commands unless explicitly requested.
