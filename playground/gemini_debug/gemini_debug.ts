/**
 * Debug: verify thoughtSignature preservation fixes Gemini 3 tool calling.
 */
import { GoogleGenAI } from "@google/genai";
import type { Part } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

const MODEL = "gemini-3-flash-preview";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const tools = [{
  functionDeclarations: [{
    name: "bash",
    description: "Execute a bash command",
    parametersJsonSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  }],
}];

// Step 1: Get a real function call with thoughtSignature
console.log("=== Step 1: Get function call with thoughtSignature ===");
const resp1 = await ai.models.generateContent({
  model: MODEL,
  contents: [{ role: "user", parts: [{ text: "Run: echo hello" }] }],
  config: { tools },
});

const candidate = resp1.candidates?.[0];
const parts = candidate?.content?.parts ?? [];
console.log("Response parts:", JSON.stringify(parts, null, 2));

// Extract the function call part with thoughtSignature
const fcPart = parts.find((p: Part) => p.functionCall != null) as Part & { thoughtSignature?: string } | undefined;
if (!fcPart?.functionCall) {
  console.log("No function call in response, exiting.");
  process.exit(1);
}

console.log("\nthoughtSignature present:", !!(fcPart as any).thoughtSignature);

// Step 2: Send back with thoughtSignature preserved
console.log("\n=== Step 2: Reply with thoughtSignature preserved ===");
try {
  const resp2 = await ai.models.generateContent({
    model: MODEL,
    contents: [
      { role: "user", parts: [{ text: "Run: echo hello" }] },
      { role: "model", parts: parts }, // Pass through as-is (includes thoughtSignature)
      {
        role: "user",
        parts: [{
          functionResponse: {
            id: fcPart.functionCall.id,
            name: fcPart.functionCall.name,
            response: { result: "hello\n" },
          },
        }],
      },
    ],
    config: { tools },
  });
  console.log("Success! Response:", resp2.text?.slice(0, 200));
} catch (e: any) {
  console.log("Error:", e.message);
}

// Step 3: Send back WITHOUT thoughtSignature (should fail)
console.log("\n=== Step 3: Reply WITHOUT thoughtSignature (expect failure) ===");
try {
  const resp3 = await ai.models.generateContent({
    model: MODEL,
    contents: [
      { role: "user", parts: [{ text: "Run: echo hello" }] },
      {
        role: "model",
        parts: [{
          functionCall: {
            id: fcPart.functionCall.id,
            name: fcPart.functionCall.name,
            args: fcPart.functionCall.args,
          },
        }],
      },
      {
        role: "user",
        parts: [{
          functionResponse: {
            id: fcPart.functionCall.id,
            name: fcPart.functionCall.name,
            response: { result: "hello\n" },
          },
        }],
      },
    ],
    config: { tools },
  });
  console.log("Unexpectedly succeeded:", resp3.text?.slice(0, 200));
} catch (e: any) {
  console.log("Expected error:", e.message?.slice(0, 200));
}