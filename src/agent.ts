import type OpenAI from "openai";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Store } from "./store.js";
import { executeTool, toolDefinitions } from "./tools.js";

export const SYSTEM_PROMPT = `You are the ordering assistant of a Swiss restaurant in Graubünden.

Rules:
- Answer in the language the guest uses. Be short and friendly.
- Only recommend dishes returned by the tools. Never invent dishes, prices or ingredients.
- If the guest mentions allergies or a diet, always filter with search_menu (excludeAllergens / tags)
  and double-check with get_dish_details before recommending.
- Prices are in CHF.
- To order: call prepare_order, show the summary (items, total) and ask the guest to confirm.
  Call confirm_order only after the guest explicitly agrees in a new message.
- If a tool returns an error, explain the problem to the guest and offer alternatives.
- Do not discuss topics unrelated to the restaurant.`;

/** Abstraction over the LLM call, so the agent loop can be tested without network access. */
export type Completer = (
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
) => Promise<ChatCompletionMessage>;

export function openAICompleter(client: OpenAI, model: string): Completer {
  return async (messages, tools) => {
    const res = await client.chat.completions.create({
      model,
      messages,
      tools,
      temperature: 0.2,
    });
    const message = res.choices[0]?.message;
    if (!message) throw new Error("LLM returned no message");
    return message;
  };
}

const MAX_STEPS = 8;

export class RestaurantAgent {
  private readonly messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  constructor(
    private readonly complete: Completer,
    private readonly store: Store,
    private readonly onToolCall?: (
      name: string,
      args: string,
      result: string,
    ) => void,
  ) {}

  /** Sends one guest message and returns the assistant's final answer. */
  async send(guestMessage: string): Promise<string> {
    this.store.turn += 1;
    this.messages.push({ role: "user", content: guestMessage });

    for (let step = 0; step < MAX_STEPS; step++) {
      const message = await this.complete(this.messages, toolDefinitions);
      this.messages.push(message);

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) return message.content ?? "";

      for (const call of toolCalls) {
        const result = executeTool(
          this.store,
          call.function.name,
          call.function.arguments,
        );
        this.onToolCall?.(call.function.name, call.function.arguments, result);
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
    }

    return "Entschuldigung, das hat zu lange gedauert. Können Sie Ihre Anfrage bitte wiederholen?";
  }
}
