import { describe, it, expect, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ToolResult } from "../../apps/server/src/types/tool-result.ts";
import agentsHub from "../../apps/server/src/tools/agents_hub.ts";
import { config } from "../../apps/server/src/config/index.ts";
import { createSandbox, _setSandboxForTest } from "../../apps/server/src/infra/sandbox.ts";

const handler = agentsHub.handler;

let tmp: string;
let restoreFiles: () => void;
const originalFetch = globalThis.fetch;

/** Extract text from ToolResult */
function getText(result: ToolResult): string {
  const part = result.content[0];
  return part.type === "text" ? part.text : "";
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agents-hub-test-"));
  restoreFiles = _setSandboxForTest(
    createSandbox({
      readPaths: [...config.sandbox.allowedReadPaths, tmp],
      writePaths: [...config.sandbox.allowedWritePaths, tmp],
      blockedWritePaths: [],
    }),
  );
});

afterAll(async () => {
  restoreFiles();
  await rm(tmp, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

// --------------- verify ---------------

describe("agents_hub verify", () => {
  it("submits inline JSON object as answer", async () => {
    let capturedBody: any = null;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ code: 0, message: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "verify",
      payload: { task: "test", answer: '{"city":"Krakow"}' },
    });

    expect(capturedBody.answer).toEqual({ city: "Krakow" });
    expect(capturedBody.apikey).toBe(config.hub.apiKey);
    expect(capturedBody.task).toBe("test");
    expect(getText(result)).toContain("OK");
  });

  it("submits inline raw string as answer", async () => {
    let capturedBody: any = null;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ code: 0, message: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await handler({
      action: "verify",
      payload: { task: "test", answer: "KRAKOW" },
    });

    expect(capturedBody.answer).toBe("KRAKOW");
  });

  it("reads answer from file", async () => {
    const answerFile = join(tmp, "answer.json");
    await Bun.write(answerFile, JSON.stringify({ city: "Krakow" }));

    let capturedBody: any = null;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ code: 0, message: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await handler({
      action: "verify",
      payload: { task: "test", answer: answerFile },
    });

    expect(capturedBody.answer).toEqual({ city: "Krakow" });
  });
});

// --------------- verify_batch ---------------

describe("agents_hub verify_batch", () => {
  it("submits inline JSON array and returns ToolResult", async () => {
    const capturedBodies: any[] = [];
    const outputFile = join(tmp, "vb_inline_out.json");

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ code: 0, message: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "verify_batch",
      payload: {
        task: "test",
        answers: '[{"a":1},{"a":2}]',
        output_file: outputFile,
      },
    });

    expect(result.content).toHaveLength(1);
    expect(getText(result)).toContain("Item 0");
    expect(getText(result)).toContain("Item 1");
    expect(capturedBodies[0].answer).toEqual({ a: 1 });
    expect(capturedBodies[1].answer).toEqual({ a: 2 });
  });

  it("reads answers from file", async () => {
    const answersFile = join(tmp, "answers.json");
    const outputFile = join(tmp, "vb_file_out.json");
    await Bun.write(answersFile, JSON.stringify([{ a: 1 }, { a: 2 }]));

    const capturedBodies: any[] = [];

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ code: 0, message: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "verify_batch",
      payload: { task: "test", answers: answersFile, output_file: outputFile },
    });

    expect(getText(result)).toContain("Item 0");
    expect(capturedBodies[0].answer).toEqual({ a: 1 });
  });

  it("rejects inline non-array", async () => {
    const outputFile = join(tmp, "vb_bad_out.json");

    await expect(
      handler({
        action: "verify_batch",
        payload: { task: "test", answers: '{"a":1}', output_file: outputFile },
      }),
    ).rejects.toThrow("answers must resolve to a JSON array");
  });
});

// --------------- api_request (merged) ---------------

describe("agents_hub api_request", () => {
  it("sends inline JSON body with apikey merged", async () => {
    let capturedBody: any = null;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "api_request",
      payload: { path: "location", body: '{"query":"test"}' },
    });

    expect(capturedBody.query).toBe("test");
    expect(capturedBody.apikey).toBe(config.hub.apiKey);
    expect(getText(result)).toContain("ok");
  });

  it("reads body from file with apikey merged", async () => {
    const bodyFile = join(tmp, "request.json");
    await Bun.write(bodyFile, JSON.stringify({ query: "from-file", limit: 5 }));

    let capturedBody: any = null;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ data: [1, 2] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "api_request",
      payload: { path: "search", body: bodyFile },
    });

    expect(capturedBody.query).toBe("from-file");
    expect(capturedBody.limit).toBe(5);
    expect(capturedBody.apikey).toBe(config.hub.apiKey);
  });

  it("rejects non-object body (raw string)", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as any;

    await expect(
      handler({
        action: "api_request",
        payload: { path: "test", body: "KRAKOW" },
      }),
    ).rejects.toThrow("body must resolve to a JSON object");
  });

  it("rejects non-object body (array)", async () => {
    await expect(
      handler({
        action: "api_request",
        payload: { path: "test", body: "[1,2,3]" },
      }),
    ).rejects.toThrow("body must resolve to a JSON object");
  });

  it("throws on non-OK HTTP response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as any;

    try {
      await handler({
        action: "api_request",
        payload: { path: "missing", body: '{"x":1}' },
      });
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toBe("API request failed (404)");
      expect(e.internalMessage).toContain("Not Found");
      expect(e.type).toBe("provider");
    }
  });

  it("returns text response when content-type is not JSON", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("plain text response", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as any;

    const result = await handler({
      action: "api_request",
      payload: { path: "echo", body: '{"msg":"hi"}' },
    });

    expect(getText(result)).toBe("plain text response");
  });
});

// --------------- api_batch ---------------

describe("agents_hub api_batch", () => {
  it("sends each JSON row with field mapping and returns ToolResult", async () => {
    const dataFile = join(tmp, "batch_data.json");
    const outputFile = join(tmp, "batch_output.json");
    await Bun.write(
      dataFile,
      JSON.stringify([
        { name: "Alice", born: "1990" },
        { name: "Bob", born: "1985" },
        { name: "Charlie", born: "2000" },
      ]),
    );

    const capturedBodies: any[] = [];

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedBodies.push(body);
      return new Response(JSON.stringify({ status: "found", id: capturedBodies.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "api_batch",
      payload: {
        path: "location",
        data_file: dataFile,
        field_map_json: '{"born":"birthYear"}',
        output_file: outputFile,
      },
    });

    expect(result.content).toHaveLength(1);
    expect(getText(result)).toContain("Row 1/3");
    expect(getText(result)).toContain("Row 3/3");

    expect(capturedBodies[0].birthYear).toBe("1990");
    expect(capturedBodies[0].born).toBeUndefined();
    expect(capturedBodies[0].name).toBe("Alice");
    expect(capturedBodies[0].apikey).toBe(config.hub.apiKey);

    const output = JSON.parse(await Bun.file(outputFile).text());
    expect(output.length).toBe(3);
  });

  it("passes fields through unchanged with empty field map", async () => {
    const dataFile = join(tmp, "batch_passthrough.json");
    const outputFile = join(tmp, "batch_passthrough_out.json");
    await Bun.write(dataFile, JSON.stringify([{ x: 1 }, { x: 2 }]));

    const capturedBodies: any[] = [];

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await handler({
      action: "api_batch",
      payload: { path: "test", data_file: dataFile, field_map_json: "{}", output_file: outputFile },
    });

    expect(capturedBodies[0].x).toBe(1);
    expect(capturedBodies[1].x).toBe(2);
  });

  it("throws on non-array JSON file", async () => {
    const dataFile = join(tmp, "batch_bad.json");
    const outputFile = join(tmp, "batch_bad_out.json");
    await Bun.write(dataFile, JSON.stringify({ not: "array" }));

    await expect(
      handler({
        action: "api_batch",
        payload: { path: "test", data_file: dataFile, field_map_json: "{}", output_file: outputFile },
      }),
    ).rejects.toThrow("JSON data file must contain an array");
  });

  it("throws on file not found", async () => {
    await expect(
      handler({
        action: "api_batch",
        payload: {
          path: "test",
          data_file: join(tmp, "nonexistent.json"),
          field_map_json: "{}",
          output_file: join(tmp, "out.json"),
        },
      }),
    ).rejects.toThrow();
  });
});
