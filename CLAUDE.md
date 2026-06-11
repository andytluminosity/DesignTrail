# DesignTrail Claude Guidance

When the user asks Claude to create a Git commit, use the DesignTrail commit flow instead of running `git commit` directly.

1. Run the `/commit-design` command flow.
2. Before any other prompt, ask a clear yes/no single-select question for whether DesignTrail should render Miro for this commit.
3. Always run the commit hook with annotation prompts skipped, `DESIGNTRAIL_DEFAULT_ANNOTATION_MODE=skip`, and `DESIGNTRAIL_SYNC_MIRO=false` so the commit captures screenshots and stores data in SQLite without rendering Miro.
4. If the user chooses local-only, stop after the hook completes and summarize the local capture.
5. If the user chooses Miro rendering, use Cursor `AskUserQuestions` to ask per-screenshot annotation mode choices from the hook output, then apply those choices through `/snapshot/annotations` with `syncMiro: true` so Miro renders exactly once.
   - Use `AskUserQuestions` for the initial yes/no Miro rendering choice and the per-screenshot annotation mode choices so the user can navigate options with the keyboard.
   - Do not use `AskUserQuestions` for manual annotation text.
   - For manual annotation text, ask in normal chat after the mode picker completes and use the user's full normal-chat reply as the annotation. Do not use an `Other` option or custom question-form answer for annotation text.
   - If multiple screenshots need manual annotations, ask for them one at a time in normal chat.
   - If a manual annotation is skipped, omit only that note and continue; do not abort the whole flow.
   - If a question form reports "User declined to answer questions" while collecting annotation text, ignore that failed text collection attempt and continue in normal chat instead of aborting.
6. Only fall back to a normal `git commit` if the user explicitly asks to bypass DesignTrail.

DesignTrail uses two annotation layers:

- Manual annotations are screenshot/node-level notes stored as `user` records in the annotations table.
- AI generated annotations are screenshot/node-level notes stored on `node.annotation`.
