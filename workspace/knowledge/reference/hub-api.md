---
title: AG3NTS Hub API Reference
tags: [api, hub, endpoints]
---

## Base URL

`https://hub.ag3nts.org`

## Authentication

All requests require `apikey` field in the JSON body. The key is injected automatically by the agents_hub tool.

## Endpoints

### POST /verify

Submit an answer for verification.

```json
{
  "task": "task_name",
  "answer": "your_answer",
  "apikey": "auto-injected"
}
```

Returns a flag on success or an error message.

### POST /api/{path}

General-purpose API endpoint. Body format varies by task.

### GET /data/{apikey}/{filename}

Download task-specific data files (images, text, JSON).

## See also

- [Task Solving](../procedures/task-solving.md) — how to use these endpoints in practice
