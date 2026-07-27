import assert from "node:assert/strict";
import { test } from "node:test";

import { streamChat } from "./llm.js";

function sseResponse(lines) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${lines.join("\n")}\n`));
        controller.close();
      },
    }),
  };
}

test("streamChat forwards tools and reconstructs streamed tool calls", async () => {
  const previousKey = process.env.FIREWORKS_API_KEY;
  process.env.FIREWORKS_API_KEY = "test-only-fireworks-key";
  const toolDeltas = [];
  let requestBody;

  try {
    const result = await streamChat(
      [{ role: "user", content: "Je refuse l'enregistrement." }],
      () => {
        throw new Error("no spoken token expected");
      },
      {
        provider: "fireworks",
        tools: [
          {
            type: "function",
            function: {
              name: "end_call",
              parameters: { type: "object" },
            },
          },
        ],
        tool_choice: "auto",
        parallel_tool_calls: false,
        onToolCallDelta(delta) {
          toolDeltas.push(delta);
        },
        async fetchImpl(_url, options) {
          requestBody = JSON.parse(options.body);
          return sseResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"end_","arguments":"{\\"reason\\":"}}]},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"call","arguments":"\\"consent_refused\\"}"}}]},"finish_reason":"tool_calls"}]}',
            "data: [DONE]",
          ]);
        },
      }
    );

    assert.equal(requestBody.tools[0].function.name, "end_call");
    assert.equal(requestBody.tool_choice, "auto");
    assert.equal(requestBody.parallel_tool_calls, false);
    assert.equal(toolDeltas.length, 2);
    assert.equal(result.text, "");
    assert.equal(result.finishReason, "tool_calls");
    assert.deepEqual(result.toolCalls, [
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: {
          name: "end_call",
          arguments: '{"reason":"consent_refused"}',
        },
      },
    ]);
  } finally {
    if (previousKey === undefined) {
      delete process.env.FIREWORKS_API_KEY;
    } else {
      process.env.FIREWORKS_API_KEY = previousKey;
    }
  }
});
