# DesignTrail Claude Guidance

When the user asks Claude to create a Git commit, use the DesignTrail commit flow instead of running `git commit` directly.

1. Run the `/commit-design` command flow.
2. Ask the user which annotation mode to use before committing:
   - Skip annotations
   - Manually add annotation
   - AI generated annotations
   - Manual and AI generated annotations
3. Pass the selected mode to the commit through DesignTrail environment variables so the post-commit hook can capture without asking a second terminal prompt.
4. Only fall back to a normal `git commit` if the user explicitly asks to bypass DesignTrail.

DesignTrail uses two annotation layers:

- Manual annotations are commit-level notes stored on `commit.annotation`.
- AI generated annotations are screenshot/node-level notes stored on `node.annotation`.
