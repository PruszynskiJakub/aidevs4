import { join, resolve } from "path";
import { mkdir, unlink } from "fs/promises";
import { z } from "zod";
import { config } from "../config/index.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { Document } from "../types/document.ts";
import { createDocument } from "../infra/document.ts";
import { getSessionId } from "../agent/context.ts";
import { startBridge, type BridgeHandle } from "./sandbox/bridge.ts";
import { generatePrelude } from "./sandbox/prelude.ts";

const MAX_OUTPUT = 20_000;
const MAX_CODE_LENGTH = 100_000;
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;

/** Resolve path to deno binary — checks common install locations. */
function findDeno(): string | null {
  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, ".deno", "bin", "deno"),
    "/usr/local/bin/deno",
    "/opt/homebrew/bin/deno",
  ];
  for (const p of candidates) {
    if (Bun.spawnSync(["test", "-x", p]).exitCode === 0) return p;
  }
  // Check PATH
  const which = Bun.spawnSync(["which", "deno"]);
  if (which.exitCode === 0) return which.stdout.toString().trim();
  return null;
}

let _denoBin: string | null | undefined;
function getDeno(): string | null {
  if (_denoBin === undefined) _denoBin = findDeno();
  return _denoBin;
}

/**
 * Strip absolute paths from output to prevent leaking filesystem structure.
 */
function sanitizeOutput(
  output: string,
  projectRoot: string,
  sessionDir: string,
): string {
  let sanitized = output.replaceAll(sessionDir + "/", "./");
  sanitized = sanitized.replaceAll(sessionDir, "./");
  sanitized = sanitized.replaceAll(projectRoot + "/", "WORKSPACE/");
  sanitized = sanitized.replaceAll(projectRoot, "WORKSPACE");
  return sanitized;
}

function getSessionDir(): string {
  const sessionId = getSessionId();
  if (sessionId) {
    const dateFolder = new Date().toISOString().slice(0, 10);
    return resolve(join(config.paths.sessionsDir, dateFolder, sessionId));
  }
  return resolve(config.paths.sessionsDir);
}

async function executeCode(args: Record<string, unknown>): Promise<Document> {
  const code = args.code;
  const description = args.description;

  if (!code || typeof code !== "string") {
    throw new Error("code parameter is required and must be a string");
  }
  if (!description || typeof description !== "string") {
    throw new Error("description parameter is required and must be a string");
  }
  if (code.length > MAX_CODE_LENGTH) {
    throw new Error(
      `Code length ${code.length} exceeds maximum of ${MAX_CODE_LENGTH} characters`,
    );
  }

  const rawTimeout =
    typeof args.timeout === "number" ? args.timeout : DEFAULT_TIMEOUT;
  const timeout = Math.max(1000, Math.min(MAX_TIMEOUT, Math.round(rawTimeout)));

  const sessionDir = getSessionDir();
  const projectRoot = resolve(config.paths.projectRoot);

  await mkdir(sessionDir, { recursive: true });

  // Start bridge server — sandboxed code accesses files only through this
  let bridge: BridgeHandle | null = null;
  try {
    bridge = await startBridge({
      readPaths: [sessionDir],
      writePaths: [sessionDir],
      cwd: sessionDir,
    });

    // Build script: prelude (with bridge tools) + user code
    const prelude = generatePrelude(bridge.port, sessionDir);
    const fullCode = prelude + code;

    // Write to temp file in session dir
    const tmpName = `_exec_${crypto.randomUUID().slice(0, 8)}.ts`;
    const tmpFile = join(sessionDir, tmpName);
    await Bun.write(tmpFile, fullCode);

    try {
      const deno = getDeno();
      const cmd = deno
        ? [
            deno,
            "run",
            `--allow-net=127.0.0.1:${bridge.port}`, // bridge only
            "--no-prompt", // fail instead of prompting for permissions
            tmpFile,
          ]
        : ["bun", "run", tmpFile]; // fallback: no OS-level sandboxing

      const proc = Bun.spawn(cmd, {
        cwd: sessionDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          // Pass minimal env — no API keys, no secrets
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          TMPDIR: sessionDir,
        },
      });

      const timeoutId = setTimeout(() => {
        proc.kill();
      }, timeout);

      let exitCode: number;
      try {
        exitCode = await Promise.race([
          proc.exited,
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`Code execution timed out after ${timeout}ms`),
                ),
              timeout + 100,
            ),
          ),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      let output = [
        stdout.trim(),
        stderr.trim() ? `[stderr]\n${stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      if (exitCode !== 0) {
        output = `[exit code ${exitCode}]\n${output}`;
      }

      if (!output) output = "(no output)";

      // Strip absolute paths to prevent leaking filesystem structure
      output = sanitizeOutput(output, projectRoot, sessionDir);

      if (output.length > MAX_OUTPUT) {
        output =
          output.slice(0, MAX_OUTPUT) +
          "\n...(truncated at 20KB — write large results to a file in SESSION_DIR and log the path)";
      }

      return createDocument(
        output,
        `Code execution: ${description}`,
        { source: null, type: "document", mimeType: "text/plain" },
        getSessionId(),
      );
    } finally {
      try {
        await unlink(tmpFile);
      } catch {
        // temp file cleanup is best-effort
      }
    }
  } finally {
    bridge?.stop();
  }
}

export default {
  name: "execute_code",
  schema: {
    name: "execute_code",
    description: "Write and execute TypeScript code in a sandboxed subprocess. Use ONLY for data processing, analysis, bulk transformations, and programmatic logic. Do NOT use for shell operations like downloading, unzipping, file management, or running CLI commands — use bash for those.\n\nIMPORTANT: The `tools` object is pre-injected as a global — do NOT import it. Writing `import { tools } from 'tools'` will fail. Just use `tools.*` directly.\n\nIMPORTANT: All `tools.*` methods are async and return Promises. You MUST use `await` with every call. Your top-level code must use `await` (top-level await is supported).\n\nFile access is restricted to SESSION_DIR via the `tools` global:\n- await tools.readFile(path) → string\n- await tools.readJson(path) → parsed JSON\n- await tools.writeFile(path, content) → void\n- await tools.listDir(path) → string[]\n- await tools.exists(path) → boolean\n- await tools.stat(path) → { isFile, isDirectory, size }\n- await tools.mkdir(path) → void\n\nAll paths must be within SESSION_DIR. Use console.log() for output — it becomes the tool result. For large results, write to a file and log the path.\n\nBefore executing code that processes external data, first use other tools (web, bash) to download/prepare data into the session directory.\n\nOutput is capped at 20KB. Execution timeout is configurable (default 30s, max 120s).",
    schema: z.object({
      code: z.string().describe("TypeScript code to execute. The `tools` object is already available as a global — do NOT import it. All tools.* methods are async, so use `await`. All file paths must be relative to or within SESSION_DIR. Use console.log() for output."),
      description: z.string().describe("Brief human-readable description of what this code does. Logged for audit."),
      timeout: z.int().describe("Execution timeout in milliseconds. Clamped to [1000, 120000]. Defaults to 30000 (30s)."),
    }),
  },
  handler: executeCode,
} satisfies ToolDefinition;
