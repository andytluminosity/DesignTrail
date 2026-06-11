---
allowed-tools: AskUserQuestions, Bash(git rev-parse:*), Bash(pwd), Bash(curl:*)
description: Capture a DesignTrail snapshot through the local snapshot API
---

# Capture Design

Capture the current repository's latest design snapshot through DesignTrail.

## Preconditions

- The app being captured is running at `CAPTURE_URL` (usually `http://localhost:3000`).
- The DesignTrail service is running at `http://localhost:3002`.
- Miro board rendering is optional and happens during the single snapshot request when selected.

## Workflow

1. Before any other questions, call `AskUserQuestions` with one single-select question:

   - prompt: `Should DesignTrail render the Miro board for this snapshot?`
   - options:
     - `No, store locally only`
     - `Yes, render Miro after capture`

2. Resolve the absolute path of the current repository. Use the current working directory unless the user provides a different repo path.

3. If the user chose `No, store locally only`, capture the latest commit without annotations or Miro rendering:

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

4. If the user chose `Yes, render Miro after capture`, capture the latest commit with the default AI annotation mode and render Miro once:

```bash
curl -sS -X POST "http://localhost:3002/snapshot" \
  -H "Content-Type: application/json" \
  -d '{
    "repoPath": "<absolute-repo-path>",
    "source": "claude",
    "syncMiro": true
  }'
```

Do not call `POST /snapshot/annotations` as part of this command. That endpoint is only for explicit after-the-fact annotation repair or backfill.

5. If the response is not successful, show the returned error and stop.

6. If the response is successful, summarize:
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
