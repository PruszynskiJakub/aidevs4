import { join } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { createServer, type Server } from "node:http";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

const DATA_DIR = join(import.meta.dir, "../../data/mcp-oauth");

function stateDir(serverName: string): string {
  const dir = join(DATA_DIR, serverName);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

/**
 * File-based OAuth client provider for MCP servers.
 * Persists tokens, client info, and code verifiers to data/mcp-oauth/<serverName>/.
 * On auth redirect, opens the browser and starts a temporary callback server.
 */
export function createOAuthProvider(
  serverName: string,
  callbackPort: number = 8090,
): OAuthClientProvider {
  const dir = stateDir(serverName);
  const tokensPath = join(dir, "tokens.json");
  const clientInfoPath = join(dir, "client-info.json");
  const verifierPath = join(dir, "verifier.txt");
  const discoveryPath = join(dir, "discovery.json");

  const callbackUrl = `http://127.0.0.1:${callbackPort}/callback`;

  return {
    get redirectUrl() {
      return callbackUrl;
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: `aidevs4-agent-${serverName}`,
        redirect_uris: [callbackUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      };
    },

    clientInformation(): OAuthClientInformationMixed | undefined {
      return readJson<OAuthClientInformationMixed>(clientInfoPath);
    },

    saveClientInformation(info: OAuthClientInformationMixed): void {
      writeJson(clientInfoPath, info);
    },

    tokens(): OAuthTokens | undefined {
      return readJson<OAuthTokens>(tokensPath);
    },

    saveTokens(tokens: OAuthTokens): void {
      writeJson(tokensPath, tokens);
    },

    redirectToAuthorization(authorizationUrl: URL): void {
      const url = authorizationUrl.toString();
      console.log(`[mcp-oauth] Opening browser for authorization: ${url}`);
      // Open in default browser
      const cmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      Bun.spawn([cmd, url], { stdio: ["ignore", "ignore", "ignore"] });
    },

    saveCodeVerifier(codeVerifier: string): void {
      writeFileSync(verifierPath, codeVerifier, "utf-8");
    },

    codeVerifier(): string {
      try {
        return readFileSync(verifierPath, "utf-8");
      } catch {
        throw new Error("No code verifier saved");
      }
    },

    saveDiscoveryState(state: OAuthDiscoveryState): void {
      writeJson(discoveryPath, state);
    },

    discoveryState(): OAuthDiscoveryState | undefined {
      return readJson<OAuthDiscoveryState>(discoveryPath);
    },

    invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
      if (scope === "all" || scope === "tokens") removeFile(tokensPath);
      if (scope === "all" || scope === "client") removeFile(clientInfoPath);
      if (scope === "all" || scope === "verifier") removeFile(verifierPath);
      if (scope === "all" || scope === "discovery") removeFile(discoveryPath);
    },
  };
}

/**
 * Starts a temporary HTTP server to receive the OAuth callback.
 * Returns a promise that resolves with the authorization code.
 */
export function waitForOAuthCallback(port: number): Promise<{ code: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(404);
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url || "", `http://127.0.0.1:${port}`);
      const code = parsedUrl.searchParams.get("code");
      const error = parsedUrl.searchParams.get("error");

      if (code) {
        console.log(`[mcp-oauth] Authorization code received`);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h1>Authorization Successful!</h1>
          <p>You can close this window and return to the terminal.</p>
          <script>setTimeout(() => window.close(), 2000);</script>
        </body></html>`);
        resolve({ code, server });
      } else if (error) {
        console.error(`[mcp-oauth] Authorization error: ${error}`);
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h1>Authorization Failed</h1><p>${error}</p></body></html>`);
        reject(new Error(`OAuth authorization failed: ${error}`));
        setTimeout(() => server.close(), 1000);
      } else {
        res.writeHead(400);
        res.end("Bad request");
      }
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`[mcp-oauth] Callback server listening on http://127.0.0.1:${port}`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}
