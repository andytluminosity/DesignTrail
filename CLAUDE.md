# DesignTrail Claude Guidance

When the user asks Claude to create a Git commit, use the DesignTrail commit flow instead of running `git commit` directly.

1. Run the `/commit-design` command flow.
2. Let the post-commit hook capture screenshots with annotations and Miro rendering deferred.
3. Ask the user which annotation mode to use for each returned screenshot/component:
   - Skip annotations
   - Manually add annotation
   - AI generated annotations
   - Manual and AI generated annotations
4. Apply the selected per-screenshot choices through DesignTrail so annotations attach to the correct node before Miro renders.
5. Only fall back to a normal `git commit` if the user explicitly asks to bypass DesignTrail.

DesignTrail uses two annotation layers:

- Manual annotations are screenshot/node-level notes stored as `user` records in the annotations table.
- AI generated annotations are screenshot/node-level notes stored on `node.annotation`.
