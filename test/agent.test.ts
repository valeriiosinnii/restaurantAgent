import { describe, expect, it } from "vitest";
import type { ChatCompletionMessage } from "openai/resources/chat/completions";
import { RestaurantAgent, type Completer } from "../src/agent.js";
import { createStore } from "../src/store.js";

/** Fake LLM that replays a fixed script of responses. */
function scriptedCompleter(script: ChatCompletionMessage[]): Completer {
  let i = 0;
  return async () => {
    const next = script[i++];
    if (!next) throw new Error("script exhausted");
    return next;
  };
}

function toolCall(id: string, name: string, args: unknown): ChatCompletionMessage {
  return {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function text(content: string): ChatCompletionMessage {
  return { role: "assistant", content, refusal: null };
}

describe("RestaurantAgent", () => {
  it("runs tools and returns the final answer", async () => {
    const store = createStore();
    const toolLog: string[] = [];
    const agent = new RestaurantAgent(
      scriptedCompleter([
        toolCall("c1", "search_menu", { tags: ["vegan"] }),
        text("Ich empfehle die Falafel Bowl."),
      ]),
      store,
      (name) => toolLog.push(name),
    );

    const answer = await agent.send("Was habt ihr Veganes?");
    expect(answer).toBe("Ich empfehle die Falafel Bowl.");
    expect(toolLog).toEqual(["search_menu"]);
  });

  it("blocks confirmation in the same turn and allows it after the guest replies", async () => {
    const store = createStore();
    const results: string[] = [];
    const draftId = () => [...store.drafts.keys()][0]!;
    let step = 0;
    const completer: Completer = async () => {
      step += 1;
      switch (step) {
        case 1:
          return toolCall("c1", "prepare_order", { items: [{ dishId: "sorbet", quantity: 1 }] });
        case 2: // misbehaving model tries to place the order without asking
          return toolCall("c2", "confirm_order", { draftId: draftId() });
        case 3:
          return text("1x Fruchtsorbet, total CHF 8.00. Bestätigen Sie die Bestellung?");
        case 4:
          return toolCall("c3", "confirm_order", { draftId: draftId() });
        default:
          return text("Ihre Bestellung ist aufgegeben.");
      }
    };
    const agent = new RestaurantAgent(completer, store, (_n, _a, r) => results.push(r));

    await agent.send("Ein Sorbet bitte");
    expect(JSON.parse(results[1]!).ok).toBe(false); // guard kicked in
    expect(store.orders).toHaveLength(0);

    await agent.send("Ja, bitte bestellen");
    expect(JSON.parse(results[2]!).ok).toBe(true);
    expect(store.orders).toHaveLength(1);
  });

  it("stops after too many tool steps", async () => {
    const store = createStore();
    const loop = Array.from({ length: 20 }, (_, i) => toolCall(`c${i}`, "search_menu", {}));
    const agent = new RestaurantAgent(scriptedCompleter(loop), store);
    const answer = await agent.send("Hallo");
    expect(answer).toMatch(/zu lange/);
  });
});
