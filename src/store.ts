import { readFileSync } from "node:fs";
import type { Dish, Order, OrderDraft, StockItem } from "./types.js";

const DATA_DIR = new URL("../data/", import.meta.url);

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(file, DATA_DIR), "utf8")) as T;
}

/**
 * In-memory state of the restaurant. In a real deployment this would be
 * replaced by the POS / inventory system (e.g. an API adapter).
 */
export interface Store {
  menu: Dish[];
  stock: Map<string, StockItem>;
  drafts: Map<string, OrderDraft>;
  orders: Order[];
  /** Incremented once per guest message. */
  turn: number;
}

export function createStore(menu?: Dish[], stock?: StockItem[]): Store {
  const menuData = menu ?? loadJson<Dish[]>("menu.json");
  const stockData = stock ?? loadJson<StockItem[]>("inventory.json");
  return {
    menu: structuredClone(menuData),
    stock: new Map(structuredClone(stockData).map((s) => [s.id, s])),
    drafts: new Map(),
    orders: [],
    turn: 0,
  };
}

/** How many portions of a dish can be cooked with the current stock. */
export function availablePortions(store: Store, dish: Dish): number {
  let max = Number.POSITIVE_INFINITY;
  for (const use of dish.ingredients) {
    const item = store.stock.get(use.ingredientId);
    const possible = item ? Math.floor(item.qty / use.qty) : 0;
    max = Math.min(max, possible);
  }
  return Number.isFinite(max) ? max : 0;
}
