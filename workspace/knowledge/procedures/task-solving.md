---
title: Task Solving Procedure
tags: [workflow, tasks, hub]
---

## Overview

Standard procedure for solving AG3NTS hub tasks.

## Steps

1. Read and understand the task description thoroughly
2. Identify what data needs to be fetched or processed
3. Check [Hub API](../reference/hub-api.md) for relevant endpoints
4. Prototype a solution — break the problem into small steps
5. Verify the answer format matches what the hub expects
6. Submit via the verify endpoint

## Common Pitfalls

- Submitting answers in wrong format (string vs array vs object)
- Forgetting to include the API key in requests
- Not reading the full task description — details matter
- Trying to solve everything in one step instead of decomposing

## See also

- [Hub API](../reference/hub-api.md) — endpoint details
- [Tool Inventory](../reference/tool-inventory.md) — which tools to use
