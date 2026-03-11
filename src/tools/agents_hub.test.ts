import { describe, it, expect, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import agentsHub from "./agents_hub.ts";
import { ALLOWED_READ_PATHS, ALLOWED_WRITE_PATHS } from "../config.ts";

const handler = agentsHub.handler;

let tmp: string;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agents-hub-test-"));
  ALLOWED_READ_PATHS.push(tmp);
  ALLOWED_WRITE_PATHS.push(tmp);
  process.env.HUB_API_KEY = "test-key-123";
});

afterAll(async () => {
  ALLOWED_READ_PATHS.splice(ALLOWED_READ_PATHS.indexOf(tmp), 1);
  ALLOWED_WRITE_PATHS.splice(ALLOWED_WRITE_PATHS.indexOf(tmp), 1);
  await rm(tmp, { recursive: true, force: true });
  delete process.env.HUB_API_KEY;
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

describe("agents_hub api_request", () => {
  it("sends inline body with apikey merged", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = (await handler({
      action: "api_request",
      payload: { path: "location", body: { query: "test" } },
    })) as any;

    expect(capturedUrl).toBe("https://hub.ag3nts.org/api/location");
    expect(capturedBody.query).toBe("test");
    expect(capturedBody.apikey).toBe("test-key-123");
    expect(result.status).toBe("ok");
    expect(result.data.path).toBe("location");
    expect(result.data.response).toEqual({ message: "ok" });
    expect(result.hints).toContain("Response from /api/location received.");
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

    const result = (await handler({
      action: "api_request",
      payload: { path: "search", body_file: bodyFile },
    })) as any;

    expect(capturedBody.query).toBe("from-file");
    expect(capturedBody.limit).toBe(5);
    expect(capturedBody.apikey).toBe("test-key-123");
    expect(result.status).toBe("ok");
    expect(result.data.response).toEqual({ data: [1, 2] });
  });

  it("throws when both body and body_file are provided", async () => {
    await expect(
      handler({
        action: "api_request",
        payload: { path: "test", body: { x: 1 }, body_file: "/some/file.json" },
      }),
    ).rejects.toThrow("Provide either body or body_file, not both");
  });

  it("throws when neither body nor body_file is provided", async () => {
    await expect(
      handler({
        action: "api_request",
        payload: { path: "test" },
      }),
    ).rejects.toThrow("Provide either body or body_file");
  });

  it("throws on non-OK HTTP response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as any;

    await expect(
      handler({
        action: "api_request",
        payload: { path: "missing", body: {} },
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

    const result = (await handler({
      action: "api_request",
      payload: { path: "echo", body: { msg: "hi" } },
    })) as any;

    expect(result.data.response).toBe("plain text response");
  });
});

describe("agents_hub api_request_body", () => {
  it("parses body_json string and sends as body with apikey", async () => {
    let capturedBody: any = null;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = (await handler({
      action: "api_request_body",
      payload: { path: "test", body_json: '{"query":"hello","limit":10}' },
    })) as any;

    expect(capturedBody.query).toBe("hello");
    expect(capturedBody.limit).toBe(10);
    expect(capturedBody.apikey).toBe("test-key-123");
    expect(result.status).toBe("ok");
    expect(result.data.path).toBe("test");
    expect(result.data.response).toEqual({ ok: true });
  });

  it("throws on invalid body_json", async () => {
    await expect(
      handler({
        action: "api_request_body",
        payload: { path: "test", body_json: "not-json" },
      }),
    ).rejects.toThrow();
  });
});

describe("agents_hub api_request_file", () => {
  it("reads body from file with apikey merged", async () => {
    const bodyFile = join(tmp, "request_file_action.json");
    await Bun.write(bodyFile, JSON.stringify({ data: "from-file-action" }));

    let capturedBody: any = null;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ result: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const result = (await handler({
      action: "api_request_file",
      payload: { path: "upload", body_file: bodyFile },
    })) as any;

    expect(capturedBody.data).toBe("from-file-action");
    expect(capturedBody.apikey).toBe("test-key-123");
    expect(result.status).toBe("ok");
    expect(result.data.path).toBe("upload");
    expect(result.data.response).toEqual({ result: "ok" });
  });
});

describe("agents_hub api_batch", () => {
  it("sends each JSON row with field mapping and writes results", async () => {
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

    const result = (await handler({
      action: "api_batch",
      payload: {
        path: "location",
        data_file: dataFile,
        field_map_json: '{"born":"birthYear"}',
        output_file: outputFile,
      },
    })) as any;

    expect(result.status).toBe("ok");
    expect(result.data.path).toBe("location");
    expect(result.data.count).toBe(3);
    expect(result.data.output_file).toBe(outputFile);
    expect(result.hints).toContain(`Processed 3 rows. Results written to ${outputFile}.`);

    // Check field mapping: born → birthYear
    expect(capturedBodies[0].birthYear).toBe("1990");
    expect(capturedBodies[0].born).toBeUndefined();
    expect(capturedBodies[0].name).toBe("Alice");
    expect(capturedBodies[0].apikey).toBe("test-key-123");

    // Check output file was written
    const output = JSON.parse(await Bun.file(outputFile).text());
    expect(output.length).toBe(3);
    expect(output[0].input).toEqual({ name: "Alice", born: "1990" });
    expect(output[0].response).toEqual({ status: "found", id: 1 });
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

    const result = (await handler({
      action: "api_batch",
      payload: { path: "people", data_file: dataFile, field_map_json: "{}", output_file: outputFile },
    })) as any;

    expect(result.data.count).toBe(2);
    expect(capturedBodies[0].name).toBe("Alice");
    expect(capturedBodies[0].age).toBe("30");
    expect(capturedBodies[0].apikey).toBe("test-key-123");
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
