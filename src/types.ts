export const ALLERGENS = ["gluten", "lactose", "egg", "nuts", "peanuts", "sesame", "soy", "fish"] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const CATEGORIES = ["starter", "main", "dessert"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface IngredientUse {
  ingredientId: string;
  qty: number;
}

export interface Dish {
  id: string;
  name: string;
  category: Category;
  price: number;
  description: string;
  ingredients: IngredientUse[];
  allergens: Allergen[];
  tags: string[];
}

export interface StockItem {
  id: string;
  name: string;
  unit: string;
  qty: number;
  /** Below this level the item should be reordered. */
  minQty: number;
}

export interface OrderLine {
  dishId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderDraft {
  id: string;
  lines: OrderLine[];
  total: number;
  /** Conversation turn in which the draft was created (used by the confirmation guard). */
  createdAtTurn: number;
}

export interface Order {
  id: string;
  lines: OrderLine[];
  total: number;
  createdAt: string;
}
