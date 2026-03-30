---
title: Tool Inventory
tags: [tools, reference]
---

## When to use which tool

| Scenario | Tool |
|---|---|
| Submit answer to hub | agents_hub (verify action) |
| Fetch a URL or scrape a page | web (fetch/scrape actions) |
| Process documents (PDF, images) | document_processor |
| Run arbitrary code | execute_code |
| Read/write/edit files | read_file, write_file, edit_file |
| Search file names | glob |
| Search file contents | grep |
| Shell commands | bash |
| Reason step by step | think |
| Delegate to sub-agent | delegate |
| Domain knowledge lookup | knowledge |

## Tips

- Prefer `execute_code` over `bash` for data transformations — it's safer
- Use `think` before complex multi-step plans
- Check knowledge base before starting a new task type

## See also

- [Task Solving](../procedures/task-solving.md) — overall workflow
- [Hub API](./hub-api.md) — hub-specific endpoints
