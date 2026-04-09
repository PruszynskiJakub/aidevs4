import { join } from "node:path";
import type { MemoryState } from "../../types/memory.ts";
import { sandbox as files } from "../../infra/sandbox.ts";
import { config } from "../../config/index.ts";
import { safeParse } from "../../utils/parse.ts";

const STATE_FILENAME = "memory-state.json";

function sessionOutputDir(sessionId: string): string {
  const dateFolder = new Date().toISOString().slice(0, 10);
  return join(config.paths.sessionsDir, dateFolder, sessionId);
}

export async function saveState(
  sessionId: string,
  state: MemoryState,
): Promise<void> {
  const dir = sessionOutputDir(sessionId);
  await files.mkdir(dir);
  await files.write(join(dir, STATE_FILENAME), JSON.stringify(state, null, 2));
}

export async function loadState(
  sessionId: string,
): Promise<MemoryState | null> {
  const path = join(sessionOutputDir(sessionId), STATE_FILENAME);
  if (!(await files.exists(path))) return null;
  const raw = await files.readText(path);
  return safeParse<MemoryState>(raw, "memory-state");
}

export async function saveDebugArtifact(
  sessionId: string,
  type: "observer" | "reflector",
  content: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const dir = sessionOutputDir(sessionId);
  await files.mkdir(dir);

  // Find next sequence number
  const existing = await files.readdir(dir);
  const prefix = `${type}-`;
  const numbers = existing
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .map((f) => {
      const match = f.slice(prefix.length, -3).match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    });
  const nextNum = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  const padded = String(nextNum).padStart(3, "0");

  // Build YAML frontmatter
  const frontmatter = Object.entries(metadata)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");

  const fileContent = `---\n${frontmatter}\n---\n\n${content}\n`;
  await files.write(join(dir, `${prefix}${padded}.md`), fileContent);
}
