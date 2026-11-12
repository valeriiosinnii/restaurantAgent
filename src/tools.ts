import { z } from "zod";
import { availablePortions, type Store } from "./store.js";
import { ALLERGENS, CATEGORIES, type Dish, type OrderLine } from "./types.js";

/** Error that is reported back to the LLM instead of crashing the agent. */
export class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Input schemas (runtime validation of everything the LLM sends us)
// ---------------------------------------------------------------------------

const SearchMenuInput = z
  .object({
    query: z.string().max(100).optional(),
    category: z.enum(CATEGORIES).optional(),
    maxPrice: z.number().positive().optional(),
    tags: z.array(z.string()).optional(),
    excludeAllergens: z.array(z.enum(ALLERGENS)).optional(),
    onlyAvailable: z.boolean().optional(),
  })
  .strict();

const DishIdInput = z.object({ dishId: z.string().min(1) }).strict();

const PrepareOrderInput = z
  .object({
    items: z
      .array(
        z.object({
          dishId: z.string().min(1),
          quantity: z.number().int().min(1).max(20),
        }),
      )
      .min(1)
      .max(20),
  })
  .strict();

const ConfirmOrderInput = z.object({ draftId: z.string().min(1) }).strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findDish(store: Store, dishId: string): Dish {
  const dish = store.menu.find((d) => d.id === dishId);
  if (!dish)
    throw new ToolError(
      `Unknown dishId "${dishId}". Use search_menu to find valid dish ids.`,
    );
  return dish;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Returns ingredients that are missing for the given order lines. */
function findShortages(store: Store, lines: OrderLine[]): string[] {
  const needs = new Map<string, number>();
  for (const line of lines) {
    for (const use of findDish(store, line.dishId).ingredients) {
      needs.set(
        use.ingredientId,
        (needs.get(use.ingredientId) ?? 0) + use.qty * line.quantity,
      );
    }
  }
  const shortages: string[] = [];
  for (const [id, needed] of needs) {
    const item = store.stock.get(id);
    if (!item || item.qty < needed) shortages.push(item?.name ?? id);
  }
  return shortages;
}

let idCounter = 0;
function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${idCounter}`;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export function searchMenu(
  store: Store,
  input: z.infer<typeof SearchMenuInput>,
) {
  const onlyAvailable = input.onlyAvailable ?? true;
  const query = input.query?.toLowerCase();

  return store.menu
    .filter((d) => !input.category || d.category === input.category)
    .filter((d) => input.maxPrice === undefined || d.price <= input.maxPrice)
    .filter(
      (d) => !input.tags?.length || input.tags.every((t) => d.tags.includes(t)),
    )
    .filter(
      (d) => !input.excludeAllergens?.some((a) => d.allergens.includes(a)),
    )
    .filter(
      (d) =>
        !query || `${d.name} ${d.description}`.toLowerCase().includes(query),
    )
    .map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      price: d.price,
      tags: d.tags,
      allergens: d.allergens,
      available: availablePortions(store, d) > 0,
    }))
    .filter((d) => !onlyAvailable || d.available);
}

export function getDishDetails(
  store: Store,
  input: z.infer<typeof DishIdInput>,
) {
  const dish = findDish(store, input.dishId);
  return {
    id: dish.id,
    name: dish.name,
    category: dish.category,
    price: dish.price,
    description: dish.description,
    ingredients: dish.ingredients.map(
      (u) => store.stock.get(u.ingredientId)?.name ?? u.ingredientId,
    ),
    allergens: dish.allergens,
    tags: dish.tags,
    availablePortions: availablePortions(store, dish),
  };
}

export function prepareOrder(
  store: Store,
  input: z.infer<typeof PrepareOrderInput>,
) {
  // Merge duplicate dishes into one line.
  const merged = new Map<string, number>();
  for (const item of input.items)
    merged.set(item.dishId, (merged.get(item.dishId) ?? 0) + item.quantity);

  const lines: OrderLine[] = [...merged].map(([dishId, quantity]) => {
    const dish = findDish(store, dishId);
    return { dishId, name: dish.name, quantity, unitPrice: dish.price };
  });

  const shortages = findShortages(store, lines);
  if (shortages.length) {
    throw new ToolError(
      `Not enough stock for this order (missing: ${shortages.join(", ")}). Suggest alternatives.`,
    );
  }

  const draft = {
    id: newId("D"),
    lines,
    total: round2(lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0)),
    createdAtTurn: store.turn,
  };
  store.drafts.set(draft.id, draft);

  return {
    draftId: draft.id,
    lines: draft.lines,
    total: draft.total,
    currency: "CHF",
    nextStep:
      "Show this summary to the guest and ask for explicit confirmation. Do NOT confirm in the same turn.",
  };
}

export function confirmOrder(
  store: Store,
  input: z.infer<typeof ConfirmOrderInput>,
) {
  const draft = store.drafts.get(input.draftId);
  if (!draft)
    throw new ToolError(
      `Unknown draftId "${input.draftId}". Create a draft with prepare_order first.`,
    );

  // Guardrail: the guest must have answered after seeing the draft.
  if (store.turn <= draft.createdAtTurn) {
    throw new ToolError(
      "The guest has not confirmed yet. Show the order summary and wait for the guest's reply.",
    );
  }

  // Stock may have changed since the draft was created.
  const shortages = findShortages(store, draft.lines);
  if (shortages.length) {
    store.drafts.delete(draft.id);
    throw new ToolError(
      `Stock changed, order cannot be fulfilled (missing: ${shortages.join(", ")}).`,
    );
  }

  for (const line of draft.lines) {
    for (const use of findDish(store, line.dishId).ingredients) {
      const item = store.stock.get(use.ingredientId)!;
      item.qty -= use.qty * line.quantity;
    }
  }

  const order = {
    id: newId("O"),
    lines: draft.lines,
    total: draft.total,
    createdAt: new Date().toISOString(),
  };
  store.orders.push(order);
  store.drafts.delete(draft.id);

  const lowStock = [...store.stock.values()]
    .filter((s) => s.qty < s.minQty)
    .map((s) => ({
      ingredient: s.name,
      qty: s.qty,
      minQty: s.minQty,
      unit: s.unit,
    }));

  return {
    orderId: order.id,
    total: order.total,
    currency: "CHF",
    lowStockAlerts: lowStock,
  };
}

// ---------------------------------------------------------------------------
// Registry: JSON schemas for the LLM + dispatcher with validation
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function" as const,
    function: {
      name: "search_menu",
      description:
        "Search the restaurant menu. Returns only real dishes. Use filters to respect the guest's diet, allergies and budget.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Free text, matched against name and description",
          },
          category: { type: "string", enum: [...CATEGORIES] },
          maxPrice: { type: "number", description: "Maximum price in CHF" },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "All tags must match, e.g. vegetarian, vegan, spicy, gluten-free, regional",
          },
          excludeAllergens: {
            type: "array",
            items: { type: "string", enum: [...ALLERGENS] },
          },
          onlyAvailable: {
            type: "boolean",
            description: "Default true: hide dishes that are out of stock",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_dish_details",
      description:
        "Get description, ingredients, allergens and available portions of one dish.",
      parameters: {
        type: "object",
        properties: { dishId: { type: "string" } },
        required: ["dishId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "prepare_order",
      description:
        "Create an order draft with prices and total. Checks stock. Does NOT place the order.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dishId: { type: "string" },
                quantity: { type: "integer", minimum: 1, maximum: 20 },
              },
              required: ["dishId", "quantity"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "confirm_order",
      description:
        "Place a previously prepared order. Only call this after the guest explicitly confirmed the draft in a later message.",
      parameters: {
        type: "object",
        properties: { draftId: { type: "string" } },
        required: ["draftId"],
        additionalProperties: false,
      },
    },
  },
];

const registry = {
  search_menu: { schema: SearchMenuInput, run: searchMenu },
  get_dish_details: { schema: DishIdInput, run: getDishDetails },
  prepare_order: { schema: PrepareOrderInput, run: prepareOrder },
  confirm_order: { schema: ConfirmOrderInput, run: confirmOrder },
} as const;

export type ToolName = keyof typeof registry;

/**
 * Validates the raw JSON arguments from the LLM and runs the tool.
 * Always returns a JSON string, errors included, so the model can recover.
 */
export function executeTool(
  store: Store,
  name: string,
  rawArgs: string,
): string {
  try {
    const tool = registry[name as ToolName];
    if (!tool) throw new ToolError(`Unknown tool "${name}".`);

    let args: unknown;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      throw new ToolError("Arguments are not valid JSON.");
    }

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      throw new ToolError(
        `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (tool.run as (s: Store, i: any) => unknown)(
      store,
      parsed.data,
    );
    return JSON.stringify({ ok: true, data });
  } catch (err) {
    if (err instanceof ToolError)
      return JSON.stringify({ ok: false, error: err.message });
    throw err;
  }
}
