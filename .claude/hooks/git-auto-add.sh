#!/bin/bash
# Auto-stage files modified by Claude Code (Edit/Write tools)
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -n "$FILE_PATH" && -f "$FILE_PATH" ]]; then
  git -C "$CLAUDE_PROJECT_DIR" add "$FILE_PATH" 2>/dev/null
fi

exit 0