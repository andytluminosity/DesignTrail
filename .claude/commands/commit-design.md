---
allowed-tools: AskUserQuestions, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(git rev-parse:*), Bash(pwd), Bash(curl:*)
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

2. Stage only the files relevant to the user-requested commit.

3. Run `git commit` with DesignTrail capture enabled but annotation/Miro rendering deferred:

```bash
DESIGNTRAIL_SOURCE=claude \
DESIGNTRAIL_SKIP_PROMPT=1 \
DESIGNTRAIL_DEFAULT_ANNOTATION_MODE=skip \
DESIGNTRAIL_SYNC_MIRO=false \
git commit -m "<commit message>"
```

4. Read the DesignTrail hook output. For each returned screenshot/component, call `AskUserQuestions` with one single-select question using the entry's `nodeId` in the question id:

- prompt: `How should DesignTrail annotate <branchId> (<summary>)?`
- options:
  - `Skip annotations`
  - `Manually add annotation`
  - `AI generated annotations`
  - `Manual and AI generated annotations`

5. For every entry whose selected mode includes manual annotation, ask for a short manual annotation describing the design intent for that specific screenshot/component.

6. Apply the per-screenshot choices and render Miro:

```bash
curl -sS -X POST "http://localhost:3002/snapshot/annotations" \
  -H "Content-Type: application/json" \
  -d '{
    "repoPath": "<absolute-repo-path>",
    "commitHash": "<commit-hash>",
    "annotationChoices": [
      {
        "nodeId": "<entry-node-id>",
        "mode": "skip|manual|ai|manual_and_ai",
        "annotation": "<manual annotation when present>"
      }
    ],
    "syncMiro": true
  }'
```

7. After the annotation update completes, summarize:

- Commit hash and message.
- Each screenshot/component's annotation mode.
- Whether the post-commit hook reported a successful capture and whether Miro synced.

## Safety

- Do not commit secrets such as `.env` or credential files.
- Do not bypass hooks unless the user explicitly asks.
- Do not amend, reset, force-push, or run destructive Git commands unless explicitly requested.
