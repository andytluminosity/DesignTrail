---
allowed-tools: AskUserQuestions, Bash(git rev-parse:*), Bash(pwd), Bash(curl:*)
description: Capture a DesignTrail snapshot through the local snapshot API
---

# Capture Design

Capture the current repository's latest design snapshot through DesignTrail.

## Preconditions

- The app being captured is running at `CAPTURE_URL` (usually `http://localhost:3000`).
- The DesignTrail service is running at `http://localhost:3002`.
- Miro board rendering is manual via `npm run render-miro -- <repo>` after capture.

## Workflow

1. Call `AskUserQuestions` with exactly one single-select question:
   - id: `annotationMode`
   - prompt: `How should DesignTrail annotate this capture?`
   - options:
     - `Skip annotations`
     - `Manually add annotation`
     - `AI generated annotations`
     - `Manual and AI generated annotations`
2. If the user chose a manual annotation mode, ask for a short annotation describing the design intent behind the latest change.
3. Resolve the absolute path of the current repository. Use the current working directory unless the user provides a different repo path.
4. Send a POST request to `http://localhost:3002/snapshot`:

```bash
curl -sS -X POST "http://localhost:3002/snapshot" \
  -H "Content-Type: application/json" \
  -d '{
    "repoPath": "<absolute-repo-path>",
    "annotation": "<manual annotation when present>",
    "generateAiAnnotations": <true-or-false>,
    "source": "claude"
  }'
```

Use `generateAiAnnotations: false` for Skip annotations and Manually add annotation.
Use `generateAiAnnotations: true` for AI generated annotations and Manual and AI generated annotations.

5. If the response is not successful, show the returned error and stop.
6. If the response is successful, summarize:
   - Repository name and commit hash.
   - Commit message.
   - Screenshot count.
   - That Miro was not synced during capture.
   - Each returned entry's `branchId`, `type`, `summary`, and `screenshotPath`.

## Response Handling

Expected success shape:

```json
{
  "success": true,
  "commit": {
    "hash": "...",
    "message": "...",
    "timestamp": 1781097600000,
    "source": "claude",
    "annotation": "..."
  },
  "repoName": "TempRepo",
  "repoPath": "/Users/mikezhang/Desktop/Development/TempRepo",
  "entries": [],
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
