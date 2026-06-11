# DesignTrail Claude Guidance

When the user asks Claude to create a Git commit, use the DesignTrail commit flow instead of running `git commit` directly.

1. Run the `/commit-design` command flow.
2. Before any other prompt, ask whether DesignTrail should render Miro for this commit.
3. If the user chooses local-only, run the commit with DesignTrail capture enabled, annotation prompts skipped, and `DESIGNTRAIL_SYNC_MIRO=false` so data is stored in SQLite without rendering Miro.
4. If the user chooses Miro rendering, let the post-commit hook ask for screenshot annotation choices during capture and render Miro once at the end.
5. Do not call `/snapshot/annotations` after the commit unless the user explicitly asks for an after-the-fact annotation repair or backfill.
6. Only fall back to a normal `git commit` if the user explicitly asks to bypass DesignTrail.

DesignTrail uses two annotation layers:

- Manual annotations are screenshot/node-level notes stored as `user` records in the annotations table.
- AI generated annotations are screenshot/node-level notes stored on `node.annotation`.
