---
allowed-tools: Bash(git rev-parse:*), Bash(pwd), Bash(curl:*)
description: Capture a DesignTrail snapshot through the local snapshot API
---

# Capture Design

Capture the current repository's latest design snapshot through DesignTrail.

## Preconditions

- The app being captured is running at `CAPTURE_URL` (usually `http://localhost:3000`).
- The DesignTrail service is running at `http://localhost:3002`.
- Miro board rendering is manual via `npm run render-miro -- <repo>` after capture.

## Workflow

1. Ask the user for a short annotation describing the design intent behind the latest change.
2. Resolve the absolute path of the current repository. Use the current working directory unless the user provides a different repo path.
3. Send a POST request to `http://localhost:3002/snapshot`:

```bash
curl -sS -X POST "http://localhost:3002/snapshot" \
  -H "Content-Type: application/json" \
  -d '{
    "repoPath": "<absolute-repo-path>",
    "annotation": "<user-annotation>",
    "source": "claude"
  }'
```

4. If the response is not successful, show the returned error and stop.
5. If the response is successful, summarize:
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
