### Waiting to implement


----
### Brain dump
Support tool_search capability

skills
workflows

fallback mechanism
---
### Problems
nie mam pojecia ile tokeów lata


wykorzystanie promptfoo oraz langfuse do ewaluacji i observability


routing zapytań do dedykowanego modelu

narzędzie
publish - udostępniania plików na zewnątrz ( security !!!)
share - udostępenianie plików dla innych agentów

tool upload przydatny dla usera i agentów

heartbeat

rozbicie agentów na faktyczne skillesety

przeredagowanie promptów


dzielenie przestrzeni pamięci to jedno, czym innym jest dzielenie logów


mode like headless (for cli), different for server as a part of AgentContext

support communication client slack/postman/cli etc

porządek ze ścieżkami zapisu

browser z feedbackiem i zbieraniem good tips

browser obsługa screenshotów

wpiecie ollamy

web__download returns a ref: URI like file:///Users/.../output/uuid.json but the agent tried reading relative paths              
(foodwarehouse/output/uuid.json). It looped through 10 glob attempts to locate the file. The download tool's response format     
doesn't clearly hand off the absolute path.                                                                                      
                                              

prompt caching

wsparcie dla wielu środowisk

Cron

Przeorać MCP
oAuth ze Slackiem jak ?

MCP OAuth Web Panel
- Web panel on Hono server for managing MCP server authorization
- Shows all configured MCP servers with their auth status (authorized / needs auth)
- "Authorize" button triggers OAuth flow — redirect URL points back to the Hono server (not localhost:8090)
- OAuth callback route on the server completes the token exchange
- MCP tools are only discovered and registered after successful OAuth (not at startup)
- Needs: unregister/re-register support in tool registry, per-server connect+registerTools, panel UI
- Works for both server and Slack entrypoints (Slack bot can share the same token store)