import { join } from "path";
import { mkdir } from "fs/promises";

const OUTPUT_DIR = join(import.meta.dir, "output");

interface DownloadFileRequest {
  url: string;
}

interface DownloadFileResponse {
  url: string;
  path: string;
}

function buildHubUrl(url: string): string {
  const parsed = new URL(url);

  if (parsed.hostname !== "hub.ag3nts.org") {
    throw new Error("URL must be from hub.ag3nts.org");
  }

  // Expected format: /data/{api-key}/filename.ext
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "data") {
    throw new Error(
      "URL must point to a file: /data/{key}/filename.ext"
    );
  }

  const apiKey = process.env.HUB_API_KEY;
  if (!apiKey) {
    throw new Error("HUB_API_KEY environment variable is not set");
  }

  segments[1] = apiKey;
  parsed.pathname = "/" + segments.join("/");
  return parsed.toString();
}

function sanitizeUrl(url: string): string {
  const apiKey = process.env.HUB_API_KEY;
  if (apiKey) {
    return url.replaceAll(apiKey, "***");
  }
  return url;
}

async function download_file_from_hub(
  request: DownloadFileRequest
): Promise<DownloadFileResponse> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const fetchUrl = buildHubUrl(request.url);
  const filename = new URL(fetchUrl).pathname.split("/").pop() || "file";
  const path = join(OUTPUT_DIR, filename);

  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${sanitizeUrl(fetchUrl)}: ${response.status}`
    );
  }

  await Bun.write(path, response);

  return { url: sanitizeUrl(fetchUrl), path };
}

const response = await download_file_from_hub({url: "https://hub.ag3nts.org/data/tutaj-twoj-klucz/people.csv"});
console.log(response);

export { download_file_from_hub, type DownloadFileRequest, type DownloadFileResponse };
