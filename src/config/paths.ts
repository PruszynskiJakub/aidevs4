import { join, resolve } from "path";

// src/config/paths.ts lives in src/config/ — project root is two levels up
export const PROJECT_ROOT = resolve(import.meta.dir, "../..");
export const WORKSPACE_DIR = join(PROJECT_ROOT, "workspace");
export const SESSIONS_DIR = join(WORKSPACE_DIR, "sessions");

// Well-known directories under workspace/
export const SYSTEM_DIR = join(WORKSPACE_DIR, "system");
export const KNOWLEDGE_DIR = join(WORKSPACE_DIR, "knowledge");
export const SCRATCH_DIR = join(WORKSPACE_DIR, "scratch");
export const WORKFLOWS_DIR = join(WORKSPACE_DIR, "workflows");
export const BROWSER_DIR = join(WORKSPACE_DIR, "browser");

// Well-known directories under workspace/system/
export const AGENTS_DIR = join(SYSTEM_DIR, "agents");
export const PROMPTS_DIR = join(PROJECT_ROOT, "src", "prompts");

// Data directories (outside workspace — runtime/infra data)
export const DATA_DIR = join(PROJECT_ROOT, "data");
export const MCP_OAUTH_DIR = join(DATA_DIR, "mcp-oauth");
export const MCP_CONFIG_PATH = join(SYSTEM_DIR, "mcp.json");
