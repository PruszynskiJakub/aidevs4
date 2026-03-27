import { resolve, isAbsolute } from "path";
import { createBunFileService } from "../../infra/file.ts";

interface BridgeConfig {
  readPaths: string[];
  writePaths: string[];
  /** Base directory for resolving relative paths (typically the session dir). */
  cwd?: string;
}

export interface BridgeHandle {
  port: number;
  stop: () => void;
}

export async function startBridge(cfg: BridgeConfig): Promise<BridgeHandle> {
  const fs = createBunFileService(cfg.readPaths, cfg.writePaths);
  const baseCwd = cfg.cwd;

  const server = Bun.serve({
    port: 0, // OS picks a free port
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const endpoint = new URL(req.url).pathname.slice(1);

      try {
        const body = await req.json() as Record<string, unknown>;
        // Resolve relative paths against the configured cwd (session dir)
        // so that files created by bash (which runs in session dir) are accessible.
        const rawPath = body.path as string;
        const filePath =
          baseCwd && !isAbsolute(rawPath)
            ? resolve(baseCwd, rawPath)
            : rawPath;

        switch (endpoint) {
          case "read_file": {
            const content = await fs.readText(filePath);
            return Response.json({ status: "ok", data: content });
          }
          case "read_json": {
            const data = await fs.readJson(filePath);
            return Response.json({ status: "ok", data });
          }
          case "write_file": {
            await fs.write(filePath, body.content as string);
            return Response.json({ status: "ok" });
          }
          case "list_dir": {
            const entries = await fs.readdir(filePath);
            return Response.json({ status: "ok", data: entries });
          }
          case "exists": {
            const exists = await fs.exists(filePath);
            return Response.json({ status: "ok", data: exists });
          }
          case "stat": {
            const s = await fs.stat(filePath);
            return Response.json({ status: "ok", data: s });
          }
          case "mkdir": {
            await fs.mkdir(filePath);
            return Response.json({ status: "ok" });
          }
          default:
            return Response.json(
              { status: "error", error: `Unknown endpoint: ${endpoint}` },
              { status: 404 },
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { status: "error", error: message },
          { status: 400 },
        );
      }
    },
  });

  return {
    port: server.port,
    stop: () => server.stop(),
  };
}
