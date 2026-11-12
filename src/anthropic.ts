import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Completer } from "./agent.js";

/**
 * Adapter: the agent keeps its history in OpenAI chat format.
 * This module converts it to the Anthropic Messages API and back,
 * so the same agent loop works with Claude.
 */

function textOf(content: ChatCompletionMessageParam["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((part) => ("text" in part ? part.text : "")).join("");
}

export function toAnthropicTools(tools: ChatCompletionTool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: (t.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));
}

export function toAnthropicMessages(messages: ChatCompletionMessageParam[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  let system = "";
  const out: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
      case "developer":
        system += (system ? "\n\n" : "") + textOf(m.content);
        break;

      case "user":
        out.push({ role: "user", content: textOf(m.content) });
        break;

      case "assistant": {
        const blocks: Anthropic.ContentBlockParam[] = [];
        const text = textOf(m.content ?? null);
        if (text) blocks.push({ type: "text", text });
        for (const call of m.tool_calls ?? []) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: call.function.arguments ? JSON.parse(call.function.arguments) : {},
          });
        }
        if (blocks.length) out.push({ role: "assistant", content: blocks });
        break;
      }

      case "tool": {
        // Claude expects tool results inside a user message; consecutive results are merged.
        const block: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: textOf(m.content),
        };
        const last = out[out.length - 1];
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
          last.content.push(block);
        } else {
          out.push({ role: "user", content: [block] });
        }
        break;
      }

      default:
        break;
    }
  }

  return { system, messages: out };
}

export function fromAnthropicResponse(content: Anthropic.ContentBlock[]): ChatCompletionMessage {
  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const toolCalls = content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function" as const,
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));

  return {
    role: "assistant",
    content: text || null,
    refusal: null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

export function anthropicCompleter(client: Anthropic, model: string): Completer {
  return async (messages, tools) => {
    const { system, messages: converted } = toAnthropicMessages(messages);
    const res = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      messages: converted,
      tools: toAnthropicTools(tools),
    });
    return fromAnthropicResponse(res.content);
  };
}
