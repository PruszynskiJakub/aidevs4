/**
 * Generate the TypeScript prelude injected before every sandboxed script.
 *
 * Provides:
 * - SESSION_DIR constant (the only writable directory)
 * - `tools` object with async methods that call back to the bridge server
 */
export function generatePrelude(bridgePort: number, sessionDir: string): string {
  return `\
// === SANDBOX PRELUDE (auto-injected) ===
// All file access goes through the bridge — direct fs calls will be blocked when Deno sandbox is enabled.
const SESSION_DIR = ${JSON.stringify(sessionDir)};

const _BRIDGE_URL = "http://127.0.0.1:${bridgePort}";

async function _bridge(endpoint: string, body: Record<string, unknown>): Promise<any> {
  const resp = await fetch(\`\${_BRIDGE_URL}/\${endpoint}\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await resp.json() as { status: string; data?: any; error?: string };
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}

const tools = {
  /** Read file contents as UTF-8 string */
  readFile: (path: string): Promise<string> => _bridge("read_file", { path }),
  /** Read and parse a JSON file */
  readJson: <T = any>(path: string): Promise<T> => _bridge("read_json", { path }),
  /** Write string content to a file */
  writeFile: (path: string, content: string): Promise<void> => _bridge("write_file", { path, content }),
  /** List entries in a directory */
  listDir: (path: string): Promise<string[]> => _bridge("list_dir", { path }),
  /** Check if a path exists */
  exists: (path: string): Promise<boolean> => _bridge("exists", { path }),
  /** Get file/directory stats */
  stat: (path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> => _bridge("stat", { path }),
  /** Create directory (recursive) */
  mkdir: (path: string): Promise<void> => _bridge("mkdir", { path }),
};
// === END PRELUDE ===

`;
}
