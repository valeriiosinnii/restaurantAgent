import { beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/store.js";
import { executeTool } from "../src/tools.js";

let store: Store;

function call(name: string, args: unknown) {
  return JSON.parse(executeTool(store, name, JSON.stringify(args))) as {
    ok: boolean;
    data?: any;
    error?: string;
  };
}

beforeEach(() => {
  store = createStore();
});

describe("search_menu", () => {
  it("filters by tag and price", () => {
    const res = call("search_menu", { tags: ["vegan"], maxPrice: 22 });
    expect(res.ok).toBe(true);
    for (const d of res.data) {
      expect(d.tags).toContain("vegan");
      expect(d.price).toBeLessThanOrEqual(22);
    }
    expect(res.data.map((d: any) => d.id)).toContain("falafel_bowl");
  });

  it("excludes dishes with the given allergens", () => {
    const res = call("search_menu", {
      excludeAllergens: ["gluten", "lactose"],
    });
    for (const d of res.data) {
      expect(d.allergens).not.toContain("gluten");
      expect(d.allergens).not.toContain("lactose");
    }
  });

  it("hides out-of-stock dishes by default", () => {
    const ids = call("search_menu", {}).data.map((d: any) => d.id);
    expect(ids).not.toContain("zuercher_geschnetzeltes"); // veal stock is 0
    const all = call("search_menu", { onlyAvailable: false }).data.map(
      (d: any) => d.id,
    );
    expect(all).toContain("zuercher_geschnetzeltes");
  });

  it("validates and returns available drinks by category", () => {
    const res = call("search_menu", { category: "drink" });
    expect(res.ok).toBe(true);
    expect(res.data.map((d: any) => d.id)).toEqual(
      expect.arrayContaining([
        "soda",
        "cola",
        "tea",
        "sparkling_water",
        "still_water",
        "coffee",
      ]),
    );
    expect(res.data.every((d: any) => d.available)).toBe(true);
    expect(call("search_menu", { category: "trinken" }).ok).toBe(false);
  });

  it("rejects unknown allergens and extra fields", () => {
    expect(call("search_menu", { excludeAllergens: ["unicorn"] }).ok).toBe(
      false,
    );
    expect(call("search_menu", { foo: 1 }).ok).toBe(false);
  });
});

describe("get_dish_details", () => {
  it("returns allergens and available portions", () => {
    const res = call("get_dish_details", { dishId: "salmon_fillet" });
    expect(res.ok).toBe(true);
    expect(res.data.allergens).toContain("fish");
    expect(res.data.availablePortions).toBe(1);
  });

  it("returns an error for invented dishes", () => {
    const res = call("get_dish_details", { dishId: "sushi_platter" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown dishId/);
  });
});

describe("order flow", () => {
  it("calculates the total and merges duplicate lines", () => {
    store.turn = 1;
    const res = call("prepare_order", {
      items: [
        { dishId: "pizza_margherita", quantity: 1 },
        { dishId: "pizza_margherita", quantity: 1 },
        { dishId: "tiramisu", quantity: 1 },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.data.lines).toHaveLength(2);
    expect(res.data.total).toBe(50); // 2 x 19.5 + 11
  });

  it("refuses to confirm in the same turn the draft was created", () => {
    store.turn = 1;
    const draft = call("prepare_order", {
      items: [{ dishId: "sorbet", quantity: 1 }],
    }).data;
    const res = call("confirm_order", { draftId: draft.draftId });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not confirmed/);
    expect(store.orders).toHaveLength(0);
  });

  it("places the order after the guest's next message and deducts stock", () => {
    store.turn = 1;
    const draft = call("prepare_order", {
      items: [{ dishId: "pizza_diavola", quantity: 2 }],
    }).data;
    store.turn = 2; // guest replied "yes"
    const res = call("confirm_order", { draftId: draft.draftId });
    expect(res.ok).toBe(true);
    expect(store.orders).toHaveLength(1);
    expect(store.stock.get("salami")!.qty).toBe(4);
    // salami (4) is now below minQty (5) -> purchasing alert
    expect(res.data.lowStockAlerts.map((a: any) => a.ingredient)).toContain(
      "Salami",
    );
  });

  it("rejects orders that exceed stock", () => {
    const res = call("prepare_order", {
      items: [{ dishId: "salmon_fillet", quantity: 2 }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Lachs/);
  });

  it("re-checks stock at confirmation time", () => {
    store.turn = 1;
    const draft = call("prepare_order", {
      items: [{ dishId: "salmon_fillet", quantity: 1 }],
    }).data;
    store.stock.get("salmon")!.qty = 0; // sold in the meantime
    store.turn = 2;
    const res = call("confirm_order", { draftId: draft.draftId });
    expect(res.ok).toBe(false);
    expect(store.orders).toHaveLength(0);
  });

  it("validates quantities", () => {
    expect(
      call("prepare_order", { items: [{ dishId: "sorbet", quantity: 0 }] }).ok,
    ).toBe(false);
    expect(
      call("prepare_order", { items: [{ dishId: "sorbet", quantity: 1.5 }] })
        .ok,
    ).toBe(false);
    expect(call("prepare_order", { items: [] }).ok).toBe(false);
  });
});

describe("executeTool", () => {
  it("handles invalid JSON and unknown tools without throwing", () => {
    expect(JSON.parse(executeTool(store, "search_menu", "{not json")).ok).toBe(
      false,
    );
    expect(JSON.parse(executeTool(store, "delete_database", "{}")).ok).toBe(
      false,
    );
  });
});
