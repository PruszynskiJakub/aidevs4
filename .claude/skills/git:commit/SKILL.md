---
name: git:commit
description: >
  Create well-structured git commits by analyzing staged and unstaged changes.
  Use when the user says "commit", "/commit", "save my changes", or asks to
  commit code. Stages relevant files, generates a descriptive commit message,
  and runs the commit.
---

# Git Commit

## Workflow

1. **Gather context** — run these in parallel:
   - `git status` (never use `-uall`)
   - `git diff` and `git diff --cached` to see unstaged + staged changes
   - `git log --oneline -5` for recent message style

2. **Stage files** — add relevant changed/untracked files by name.
   - Never use `git add -A` or `git add .`
   - Never stage secrets (`.env`, credentials, keys)
   - If nothing to commit, tell the user and stop

3. **Write the commit message** following this project's convention:
   - **Subject**: imperative mood, max 72 chars, no period
     - Use a verb that matches the change: *Add* (new feature), *Update* (enhance existing), *Fix* (bug), *Refactor*, *Remove*, *Extract*, *Introduce*
   - **Body** (optional, for non-trivial changes): blank line after subject, wrap at 72 chars, explain *why* not *what*
   - **Trailer**: always append `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`

4. **Commit** — use a HEREDOC for the message:
   ```bash
   git commit -m "$(cat <<'EOF'
   Subject line here

   Optional body here.

   Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
   EOF
   )"
   ```

5. **Verify** — run `git status` after the commit to confirm success.

6. **Hook failure** — if a pre-commit hook fails:
   - Fix the issue
   - Re-stage files
   - Create a **new** commit (never `--amend`, that would modify the previous commit)

## Rules

- Never push unless the user explicitly asks
- Never amend unless the user explicitly asks
- Never use `--no-verify` or `--no-gpg-sign`
- Never update git config
- Do not read/explore code beyond what `git diff` shows — this is a commit skill, not a review skill