---
allowed-tools: AskUserQuestions, Bash(git rev-parse:*), Bash(pwd), Bash(curl:*)
description: Capture a DesignTrail snapshot through the local snapshot API
---

# Capture Design

Capture the current repository's latest design snapshot through DesignTrail.

## Preconditions

- The app being captured is running at `CAPTURE_URL` (usually `http://localhost:3000`).
- The DesignTrail service is running at `http://localhost:3002`.
- Miro board rendering is deferred until per-screenshot annotation choices are applied.

## Workflow

1. Resolve the absolute path of the current repository. Use the current working directory unless the user provides a different repo path.
2. Capture the latest commit without annotations or Miro rendering:

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

3. If the response is not successful, show the returned error and stop.

4. For each returned entry, call `AskUserQuestions` with one single-select question using the entry's `nodeId` in the question id:
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

7. If the annotation response is successful, summarize:
   - Repository name and commit hash.
   - Commit message.
   - Screenshot count.
   - Whether Miro synced.
   - Each returned entry's `nodeId`, `branchId`, `type`, `summary`, `screenshotPath`, and selected annotation mode.

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
