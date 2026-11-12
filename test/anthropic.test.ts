import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  fromAnthropicResponse,
  toAnthropicMessages,
  toAnthropicTools,
} from "../src/anthropic.js";
import { toolDefinitions } from "../src/tools.js";

describe("Anthropic adapter", () => {
  it("converts tools to input_schema format", () => {
    const tools = toAnthropicTools(toolDefinitions);
    expect(tools.map((t) => t.name)).toEqual([
      "search_menu",
      "get_dish_details",
      "prepare_order",
      "confirm_order",
    ]);
    expect(tools[1]!.input_schema.required).toEqual(["dishId"]);
  });

  it("moves the system prompt out and merges consecutive tool results", () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "Be nice" },
      { role: "user", content: "Vegan?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "search_menu", arguments: '{"tags":["vegan"]}' },
          },
          {
            id: "t2",
            type: "function",
            function: {
              name: "get_dish_details",
              arguments: '{"dishId":"sorbet"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: '{"ok":true}' },
      { role: "tool", tool_call_id: "t2", content: '{"ok":true}' },
    ];

    const { system, messages } = toAnthropicMessages(history);
    expect(system).toBe("Be nice");
    expect(messages).toHaveLength(3);
    expect(messages[1]!.content).toEqual([
      {
        type: "tool_use",
        id: "t1",
        name: "search_menu",
        input: { tags: ["vegan"] },
      },
      {
        type: "tool_use",
        id: "t2",
        name: "get_dish_details",
        input: { dishId: "sorbet" },
      },
    ]);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: '{"ok":true}' },
        { type: "tool_result", tool_use_id: "t2", content: '{"ok":true}' },
      ],
    });
  });

  it("converts Claude's response back to the agent's format", () => {
    const msg = fromAnthropicResponse([
      { type: "text", text: "Ich suche kurz.", citations: null },
      {
        type: "tool_use",
        id: "tu1",
        name: "search_menu",
        input: { maxPrice: 20 },
      },
    ] as any);
    expect(msg.content).toBe("Ich suche kurz.");
    expect(msg.tool_calls?.[0]).toEqual({
      id: "tu1",
      type: "function",
      function: { name: "search_menu", arguments: '{"maxPrice":20}' },
    });
  });
});
