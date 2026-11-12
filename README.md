# Restaurant Order Agent

An LLM agent that takes orders for a restaurant via chat. The guest describes what they want
("something vegetarian, no nuts, under 25 francs"), the agent searches the real menu, checks
allergens and stock, prepares the order and places it only after explicit confirmation.

Built with TypeScript and zod. Works with **Claude (Anthropic)** or **OpenAI** – the provider is switched via `.env`; the agent loop itself is provider-independent.

## Why it is built this way

LLMs are good at understanding requests and bad at being a source of truth. So the model
never answers from its own knowledge about the menu. Everything factual comes from tools,
and the business rules are enforced in code, not only in the prompt:

| Risk | Mitigation |
|---|---|
| Model invents a dish or price | Dishes only come from `search_menu`; unknown `dishId`s are rejected |
| Wrong arguments from the model | Every tool call is validated with zod; errors are returned to the model so it can recover |
| Order placed without the guest agreeing | `confirm_order` is refused in the same turn the draft was created; the guest must reply first |
| Selling something out of stock | Stock is checked when drafting **and** again when confirming |
| Endless tool loops | Max. 8 steps per guest message |

After each order, ingredients below their minimum level are returned as purchasing alerts.

## Architecture

```
Guest (CLI) ──> RestaurantAgent ──> LLM (tool calling)
                     │
                     └─> executeTool ──> zod validation ──> tools ──> Store (menu, stock, orders)
```

- `src/tools.ts` – tools: `search_menu`, `get_dish_details`, `prepare_order`, `confirm_order`
- `src/agent.ts` – agent loop; the LLM call is injected (`Completer`) so the loop is testable offline
- `src/anthropic.ts` – adapter that maps the conversation to the Anthropic Messages API and back
- `src/store.ts` – in-memory data (would be replaced by a POS/inventory API adapter)
- `data/` – mock menu (incl. regional dishes from Graubünden) and inventory

## Run

```bash
npm install
cp .env.example .env   # set LLM_PROVIDER and the matching API key
npm run dev            # chat in the terminal
npm run dev -- --debug # also print every tool call
npm test               # 19 unit tests, no API key needed
```

## Example

```
Gast: Ich hätte gern etwas Vegetarisches ohne Gluten, max. 25 Franken
Agent: Ich kann Ihnen das Risotto ai Funghi (CHF 24) oder die Falafel Bowl (CHF 21) empfehlen ...
Gast: Die Falafel Bowl bitte
Agent: 1x Falafel Bowl, total CHF 21.00. Soll ich bestellen?
Gast: Ja
Agent: Ihre Bestellung ist aufgegeben.
```

## Limitations / next steps

- Data is in memory and resets on restart
- No web UI yet (planned: Angular chat frontend)
- Expose the same tools as an MCP server so other agents/clients can use them
- Connect a real inventory system instead of mock data
