# Tool Description Writing Guide

Best practices for writing tool and action descriptions that maximize LLM
tool-selection accuracy and reduce wasted calls. Complements the general tool
standard in `tools_standard.md` (which covers security, schemas, validation).

This guide focuses on one thing: **what the model reads when deciding which
tool to call and how to call it**.

---

## 1. The Model Sees Only Three Things

When choosing a tool the LLM has access to:

1. **Tool name** — must be self-explanatory (`file_read`, not `fr`).
2. **Tool description** — the single most important piece of guidance.
3. **Parameter descriptions** — per-field micro-docs.

There is no README, no code, no comments. If it's not in these three fields
the model doesn't know it.

---

## 2. Description Structure

A good tool description answers four questions in order:

```
1. WHAT does this tool do?          → one sentence
2. WHEN should the model use it?    → selection trigger
3. HOW does the workflow look?       → prerequisite → this tool → next step
4. WHAT does it return?             → shape of the response
```

### Example — weak

```
"Read a file."
```

### Example — strong

```
"Read lines from a text file. Returns numbered lines with file stats.
Use offset/limit to window into large files.
For text search use file_grep instead."
```

The strong version has: what (read lines), when (text files), how (offset/limit),
return shape (numbered lines + stats), and a redirect to the better tool for
search.

---

## 3. Embed Workflow Position

Tools rarely work in isolation. The description should tell the model where
this tool sits in a chain:

- **Prerequisites**: what must happen before calling this tool.
- **Next steps**: what to do with the output.
- **Redirects**: which tool to use instead for adjacent tasks.

### Patterns

```
"PREREQUISITE: call fs_read first to obtain the checksum."
"After downloading, inspect with file_read or search with file_grep."
"For structural operations (delete, rename, move) use fs_manage instead."
```

This prevents the model from calling tools out of order or picking the wrong
tool for a related task.

---

## 4. Tell the Model What It Cannot Do

Stating boundaries is as important as stating capabilities. Without explicit
constraints the model will try anyway and waste a call.

```
"SANDBOXED — can ONLY access mounted directories. Cannot write to /Users or C:\."
"Only text files. Binary files will be rejected."
"Max 1000 lines per call. Use offset to paginate."
```

Call out the most common misuse patterns you've observed or expect.

---

## 5. Hints in Responses — Guide the Next Action

Every tool response should include a `hint` (or `hints`) field that tells the
model what to do next. This is the single highest-leverage improvement for
multi-step accuracy.

### Success hints

```
"File saved to output/report.csv. Use file_read to verify."
"Checksum: a1b2c3. Pass this to file_write when editing."
"3 results. If none match, broaden the query or try patternMode='regex'."
```

### Error hints (recovery)

```
"CHECKSUM_MISMATCH — file changed. Call file_read to get current checksum."
"team_id required. Fetch it via agents_hub__api_request first."
"Line 999 is beyond file end (48 lines). Adjust range to 1-48."
```

A good error hint answers: what happened, why, and exactly what tool call
fixes it.

---

## 6. Parameter Descriptions

Each parameter description should state:

1. **What** the value represents.
2. **Format** (when not obvious): `"Line range: '10' or '10-50'"`.
3. **Default** (if any): `"Default 200. Max 1000."`.
4. **Effect on output**: `"If true, includes file size and modified time."`.

### Anti-patterns

- `"The path"` — too vague. Path to what? Absolute or relative?
- `"Set to true to enable"` — enable what? State the effect.
- Repeating the parameter name: `"query: The query to search"`.

### Good examples

```
path: "Relative path within a mount. Use '.' for root. Example: 'docs/api.md'."
offset: "Skip first N lines (1-based). Default 1. Use with limit to paginate large files."
dryRun: "Preview changes as a unified diff without applying. Always use before destructive edits."
```

---

## 7. Multi-Action Tool Descriptions

For tools with an `actions` key, descriptions exist at two levels:

### Tool-level description

Summarize the domain and list available actions. Keep it short — the model
will read individual action descriptions for details.

```
"Interact with the AG3NTS hub platform.
Actions: verify (submit answer), api_request (call hub API), api_batch (bulk calls)."
```

### Action-level description

Each action gets a focused description following the same WHAT/WHEN/HOW/RETURNS
structure. Don't repeat tool-level context — focus on what's unique to this
action.

```
verify: "Submit a single answer for task verification. Returns flag on success."
verify_batch: "Submit multiple answers sequentially. Use when you have >1 answer for the same task."
```

---

## 8. Description Anti-Patterns

| Anti-pattern | Why it's bad | Fix |
|---|---|---|
| Implementation details ("uses SHA256", "calls fetch internally") | Noise — model can't act on it | Remove |
| Shell syntax in description ("pipe to jq", "redirect to file") | Encourages unsafe composition | Reference the right tool instead |
| Vague trigger ("useful for various tasks") | Model can't decide when to use it | State explicit trigger condition |
| No boundary statement | Model tries impossible operations | Add "Cannot…" / "Only…" constraints |
| Wall of text (>500 chars without structure) | Model skims and misses key info | Use line breaks, caps for headers |
| Describing what it does NOT do at length | Noise | One line of constraints is enough |

---

## 9. Checklist — Before Shipping a Description

- [ ] Answers: WHAT / WHEN / HOW / RETURNS
- [ ] States prerequisites ("call X first to get Y")
- [ ] States boundaries ("only text files", "max N items")
- [ ] Redirects to sibling tools for adjacent tasks
- [ ] Every parameter has format + default + effect
- [ ] Response hints guide next action (success and error)
- [ ] No implementation details, no shell syntax, no vague triggers
- [ ] Under 600 characters for simple tools, under 1200 for multi-action