# DesignTrail Claude Guidance

When the user asks Claude to create a Git commit, use the DesignTrail commit flow instead of running `git commit` directly.

1. Run the `/commit-design` command flow.
2. Before any other prompt, ask a clear yes/no single-select question for whether DesignTrail should render Miro for this commit.
3. Always run the commit hook with annotation prompts skipped, `DESIGNTRAIL_DEFAULT_ANNOTATION_MODE=skip`, and `DESIGNTRAIL_SYNC_MIRO=false` so the commit captures screenshots and stores data in SQLite without rendering Miro.
4. If the user chooses local-only, stop after the hook completes and summarize the local capture.
5. If the user chooses Miro rendering, use Cursor `AskUserQuestions` to ask per-screenshot annotation choices from the hook output, then apply those choices through `/snapshot/annotations` with `syncMiro: true` so Miro renders exactly once.
6. Only fall back to a normal `git commit` if the user explicitly asks to bypass DesignTrail.

DesignTrail uses two annotation layers:

- Manual annotations are screenshot/node-level notes stored as `user` records in the annotations table.
- AI generated annotations are screenshot/node-level notes stored on `node.annotation`.
