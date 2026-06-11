---
allowed-tools: AskUserQuestions, Bash(git rev-parse:*), Bash(pwd), Bash(curl:*)
description: Capture a DesignTrail snapshot through the local snapshot API
---

# Capture Design

Capture the current repository's latest design snapshot through DesignTrail.

## Preconditions

- The app being captured is running at `CAPTURE_URL` (usually `http://localhost:3000`).
- The DesignTrail service is running at `http://localhost:3002`.
- Miro board rendering is optional. When selected, capture first without rendering, ask per-screenshot annotation choices in Cursor, then render once.

## Workflow

1. Before any other questions, call `AskUserQuestions` with one single-select question so the user can choose with the up/down arrows:

   - prompt: `Should DesignTrail render the Miro board for this snapshot?`
   - options:
     - `Yes, render Miro`
     - `No, store locally only`

2. Resolve the absolute path of the current repository. Use the current working directory unless the user provides a different repo path.

3. Capture the latest commit without annotations or Miro rendering. This is required for both Miro choices so Cursor can ask per-screenshot annotation questions before any render happens:

```bash
curl -sS -X POST "http://localhost:3002/snapshot" \
  -H "Content-Type: application/json" \
  -d '{
    "repoPath": "<absolute-repo-path>",
    "defaultAnnotationMode": "skip",
    "source": "claude",
    "syncMiro": false
  }'
```

4. If the user chose `No, store locally only`, stop after the capture response and summarize the local capture.

5. If the user chose `Yes, render Miro`, for each returned entry, call `AskUserQuestions` with one single-select question using the entry's `nodeId` in the question id. This keeps keyboard navigation for mode selection.

   - prompt: `How should DesignTrail annotate <branchId> (<summary>)?`
   - options:
     - `Skip annotations`
     - `Manually add annotation`
     - `AI generated annotations`
     - `Manual and AI generated annotations`

6. The annotation mode picker above is the only per-screenshot use of `AskUserQuestions`. If any selected mode includes manual annotation, stop after the mode picker completes and ask for the manual annotation text in normal chat.

   - Do not include manual annotation text prompts in `AskUserQuestions`.
   - Do not use an `Other` choice, custom answer field, or any question form for annotation text.
   - Send a normal chat message like: `Enter your manual annotation for <branchId> (<summary>):`
   - Wait for the user's normal chat reply and use the full reply text as that entry's `annotation`.
   - If multiple entries need manual annotations, ask for them one at a time in normal chat, never in a question form.
   - If the user explicitly says to skip a manual note, omit only that note and continue. Do not abort the whole flow because a manual annotation was skipped.
   - If a question form reports "User declined to answer questions" while collecting annotation text, ignore that failed text collection attempt and continue by asking in normal chat.

7. Apply the per-screenshot choices and render Miro once:

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

This `POST /snapshot/annotations` call is the only Miro render in the capture flow. Do not call it if the user chose local-only, and do not call `POST /snapshot` with `syncMiro: true` when asking annotation choices.

8. If any response is not successful, show the returned error and stop.

9. If the flow is successful, summarize:
   - Repository name and commit hash.
   - Commit message.
   - Screenshot count.
   - Whether Miro rendered.
   - Each returned entry's `nodeId`, `branchId`, `type`, `summary`, `screenshotPath`, and annotation mode when present.

## Response Handling

Expected success shape:

```json
{
  "success": true,
  "commit": {
    "hash": "...",
    "message": "...",
    "timestamp": 1781097600000,
    "source": "claude"
  },
  "repoName": "TempRepo",
  "repoPath": "/Users/mikezhang/Desktop/Development/TempRepo",
  "entries": [
    {
      "nodeId": "...",
      "branchId": "sidebar",
      "type": "UI_CHANGE",
      "summary": "...",
      "annotationMode": "manual",
      "screenshotPath": "captures/..."
    }
  ],
  "screenshotCount": 1,
  "miroSynced": false
}
```

Expected error shape:

```json
{
  "success": false,
  "error": "repoPath is required and must be a non-empty string"
}
```

Do not shell out to `tracker/capture.ts`; DesignTrail owns the workflow through `POST /snapshot`.
