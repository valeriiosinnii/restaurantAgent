import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { RestaurantAgent, openAICompleter, type Completer } from "./agent.js";
import { anthropicCompleter } from "./anthropic.js";
import { createStore } from "./store.js";

function createCompleter(): { completer: Completer; label: string } {
  const provider = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();

  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY in .env");
    const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5";
    return { completer: anthropicCompleter(new Anthropic(), model), label: `Anthropic ${model}` };
  }
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    return { completer: openAICompleter(new OpenAI(), model), label: `OpenAI ${model}` };
  }
  throw new Error(`Unknown LLM_PROVIDER "${provider}" (use "anthropic" or "openai")`);
}

let setup: ReturnType<typeof createCompleter>;
try {
  setup = createCompleter();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  console.error("Copy .env.example to .env and fill in your key.");
  process.exit(1);
}

const debug = process.argv.includes("--debug");
const store = createStore();
const agent = new RestaurantAgent(setup.completer, store, (name, args, result) => {
  if (debug) console.log(`  [tool] ${name}(${args}) -> ${result}`);
});

const rl = createInterface({ input, output });
console.log(`Restaurant-Agent (${setup.label}). Tippe "exit" zum Beenden.\n`);

while (true) {
  const text = (await rl.question("Gast: ")).trim();
  if (!text) continue;
  if (text.toLowerCase() === "exit") break;

  try {
    const answer = await agent.send(text);
    console.log(`\nAgent: ${answer}\n`);
  } catch (err) {
    console.error("Fehler beim LLM-Aufruf:", err instanceof Error ? err.message : err);
  }
}

rl.close();
