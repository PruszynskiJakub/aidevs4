import type { ToolDefinition } from "../types/tool.ts";
import { files } from "../services/file.ts";
import { buildHubUrl, sanitizeUrl } from "../utils/hub.ts";
import { ensureOutputDir, outputPath } from "../utils/output.ts";

async function downloadFile({ url }: { url: string }): Promise<{ url: string; path: string }> {
  await ensureOutputDir();

  const fetchUrl = buildHubUrl(url);
  const filename = new URL(fetchUrl).pathname.split("/").pop() || "file";
  const path = outputPath(filename);

  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${sanitizeUrl(fetchUrl)}: ${response.status}`);
  }

  await files.write(path, response);

  return { url: sanitizeUrl(fetchUrl), path };
}

export default {
  name: "download_file",
  handler: downloadFile,
} satisfies ToolDefinition;
