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

4. Run `git commit` with DesignTrail capture enabled, hook annotation prompts disabled, and Miro rendering disabled. This is required for both Miro choices so Cursor can ask per-screenshot annotation questions before any render happens:

```bash
DESIGNTRAIL_SOURCE=claude \
DESIGNTRAIL_SKIP_PROMPT=1 \
DESIGNTRAIL_DEFAULT_ANNOTATION_MODE=skip \
DESIGNTRAIL_SYNC_MIRO=false \
git commit -m "<commit message>"
```

5. If the user chose `No, store locally only`, stop after the hook completes and summarize the local capture.

6. If the user chose `Yes, render Miro`, read the DesignTrail hook output. For each returned screenshot/component, call `AskUserQuestions` with one single-select question using the entry's `nodeId` in the question id. Use `AskUserQuestions` only for these single-select mode choices:

- prompt: `How should DesignTrail annotate <branchId> (<summary>)?`
- options:
  - `Skip annotations`
  - `Manually add annotation`
  - `AI generated annotations`
  - `Manual and AI generated annotations`

7. For every entry whose selected mode includes manual annotation, collect the manual annotation as a normal chat reply, not through `AskUserQuestions`.

- Do not use an `Other` choice, custom answer field, or any question form for the annotation text.
- Send a normal message like: `Enter your manual annotation for <branchId> (<summary>):`
- Wait for the user's reply and use the full reply text as that entry's `annotation`.
- If the user sends an empty reply or explicitly says to skip, omit only that manual note and continue. Do not abort the whole flow because a manual annotation was skipped.

8. Apply the per-screenshot choices and render Miro once:

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

This `POST /snapshot/annotations` call is the only Miro render in the commit flow. Do not call it if the user chose local-only, and do not run the commit hook with `DESIGNTRAIL_SYNC_MIRO=true`.

9. After the hook and optional annotation update complete, summarize:

- Commit hash and message.
- Each screenshot/component's annotation mode.
- Whether the post-commit hook reported a successful capture and whether Miro rendered.

## Safety

- Do not commit secrets such as `.env` or credential files.
- Do not bypass hooks unless the user explicitly asks.
- Do not amend, reset, force-push, or run destructive Git commands unless explicitly requested.
