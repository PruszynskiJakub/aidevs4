/**
 * Generate the TypeScript prelude injected before every sandboxed script.
 *
 * Provides:
 * - SESSION_DIR constant (the only writable directory)
 * - `tools` object with async methods that call back to the bridge server
 *
 * The prelude uses only `fetch()` — compatible with both Deno and Bun runtimes.
 * When running under Deno, the sandbox is enforced via --allow-net=127.0.0.1:{port}
 * with no --allow-read or --allow-write, so direct fs calls are blocked by the runtime.
 */
export function generatePrelude(bridgePort: number, sessionDir: string): string {
  return `\
// === SANDBOX PRELUDE (auto-injected) ===
// File access goes through the bridge. Direct fs/Deno.readFile calls are blocked by the Deno sandbox.
const SESSION_DIR = ${JSON.stringify(sessionDir)};

const _BRIDGE_URL = "http://127.0.0.1:${bridgePort}";

async function _bridge(endpoint: string, body: Record<string, unknown>): Promise<any> {
  const resp = await fetch(\`\${_BRIDGE_URL}/\${endpoint}\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result: any = await resp.json();
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}

const tools = {
  /** Read file contents as UTF-8 string */
  readFile(path: string): Promise<string> { return _bridge("read_file", { path }); },
  /** Read and parse a JSON file */
  readJson(path: string): Promise<any> { return _bridge("read_json", { path }); },
  /** Write string content to a file */
  writeFile(path: string, content: string): Promise<void> { return _bridge("write_file", { path, content }); },
  /** List entries in a directory */
  listDir(path: string): Promise<string[]> { return _bridge("list_dir", { path }); },
  /** Check if a path exists */
  exists(path: string): Promise<boolean> { return _bridge("exists", { path }); },
  /** Get file/directory stats */
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> { return _bridge("stat", { path }); },
  /** Create directory (recursive) */
  mkdir(path: string): Promise<void> { return _bridge("mkdir", { path }); },
};
// === END PRELUDE ===

`;
}
