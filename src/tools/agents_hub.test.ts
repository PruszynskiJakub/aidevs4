import { describe, it, expect, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Document } from "../types/document.ts";
import agentsHub from "./agents_hub.ts";
import { config } from "../config/index.ts";
import { _testReadPaths, _testWritePaths } from "../services/common/file.ts";

const handler = agentsHub.handler;

let tmp: string;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agents-hub-test-"));
  _testReadPaths.push(tmp);
  _testWritePaths.push(tmp);
});

afterAll(async () => {
  _testReadPaths.splice(_testReadPaths.indexOf(tmp), 1);
  _testWritePaths.splice(_testWritePaths.indexOf(tmp), 1);
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
    }) as Document;

    expect(capturedBody.answer).toEqual({ city: "Krakow" });
    expect(capturedBody.apikey).toBe(config.hub.apiKey);
    expect(capturedBody.task).toBe("test");
    expect(result.text).toContain("OK");
    expect(result.metadata.type).toBe("document");
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
  it("submits inline JSON array and returns Document[]", async () => {
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
    }) as Document[];

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
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
    }) as Document[];

    expect(result).toHaveLength(2);
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
    }) as Document;

    expect(capturedBody.query).toBe("test");
    expect(capturedBody.apikey).toBe(config.hub.apiKey);
    expect(result.text).toContain("ok");
    expect(result.description).toContain("/api/location");
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
    }) as Document;

    expect(capturedBody.query).toBe("from-file");
    expect(capturedBody.limit).toBe(5);
    expect(capturedBody.apikey).toBe(config.hub.apiKey);
    expect(result.metadata.type).toBe("document");
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

    await expect(
      handler({
        action: "api_request",
        payload: { path: "missing", body: '{"x":1}' },
      }),
    ).rejects.toThrow("API request failed (404): Not Found");
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
    }) as Document;

    expect(result.text).toBe("plain text response");
  });
});

// --------------- api_batch (unchanged) ---------------

describe("agents_hub api_batch", () => {
  it("sends each JSON row with field mapping and returns Document[]", async () => {
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
    }) as Document[];

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);

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

  it("parses CSV input and sends each row", async () => {
    const dataFile = join(tmp, "batch_data.csv");
    const outputFile = join(tmp, "batch_csv_out.json");
    await Bun.write(dataFile, "name,age\nAlice,30\nBob,25\n");

    const capturedBodies: any[] = [];

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = await handler({
      action: "api_batch",
      payload: { path: "people", data_file: dataFile, field_map_json: "{}", output_file: outputFile },
    }) as Document[];

    expect(result).toHaveLength(2);
    expect(capturedBodies[0].name).toBe("Alice");
    expect(capturedBodies[0].apikey).toBe(config.hub.apiKey);
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
