import type { InventoryMovement, Product, SaleItem } from "../types";
import { packCostCents, productHasBundle } from "./format";

export type InventoryCostState = {
  quantity: number;
  valueCents: number;
  averageCostCents: number;
};

export const inventoryPoolId = (product: Pick<Product, "id" | "categoryKind">) =>
  product.categoryKind === "tobacco" ? "tobacco" : product.id;

/**
 * Converts the legacy product cost into the base inventory unit used by the
 * weighted-average ledger. Tobacco is stored in grams; everything else uses
 * the product's base unit (pack, piece, etc.).
 */
export const legacyBaseCostCents = (product: Pick<Product, "categoryKind" | "packCostCents" | "cartonCostCents" | "packsPerCarton" | "unitWeightGrams">) => {
  const sellingUnitCost = packCostCents(product);
  return product.categoryKind === "tobacco"
    ? Math.round(sellingUnitCost / Math.max(1, product.unitWeightGrams ?? 1))
    : sellingUnitCost;
};

const saleCostByMovement = (movement: InventoryMovement, saleItems: SaleItem[]) => {
  if (!movement.relatedSaleId) return 0;
  return saleItems
    .filter((item) => item.saleId === movement.relatedSaleId && item.productId === movement.productId)
    .reduce((sum, item) => sum + item.lineCostCents, 0);
};

export const movementCostValueDeltaCents = (
  movement: InventoryMovement,
  product: Product | undefined,
  saleItems: SaleItem[] = [],
) => {
  if (movement.costValueDeltaCents !== undefined) return movement.costValueDeltaCents;
  if (movement.reason === "restock") return movement.totalCostCents ?? 0;
  if (movement.reason === "sale") return -saleCostByMovement(movement, saleItems);
  if (movement.reason === "saleVoid") return saleCostByMovement(movement, saleItems);
  return product ? movement.quantityDeltaPacks * legacyBaseCostCents(product) : 0;
};

export const inventoryCostStates = (
  movements: InventoryMovement[],
  products: Product[],
  saleItems: SaleItem[] = [],
) => {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const states = new Map<string, InventoryCostState>();
  movements.filter((movement) => !movement.deletedAt).forEach((movement) => {
    const product = productsById.get(movement.productId);
    if (!product) return;
    const poolId = inventoryPoolId(product);
    const state = states.get(poolId) ?? { quantity: 0, valueCents: 0, averageCostCents: 0 };
    state.quantity += movement.quantityDeltaPacks;
    state.valueCents += movementCostValueDeltaCents(movement, product, saleItems);
    state.averageCostCents = state.quantity > 0 ? Math.round(state.valueCents / state.quantity) : 0;
    states.set(poolId, state);
  });
  return states;
};

export const averageCostCentsForProduct = (
  product: Product,
  states: Map<string, InventoryCostState>,
) => states.get(inventoryPoolId(product))?.averageCostCents ?? legacyBaseCostCents(product);

export const inventoryValueCentsAtAverage = (
  stock: number,
  product: Product,
  states: Map<string, InventoryCostState>,
) => Math.round(Math.max(0, stock) * averageCostCentsForProduct(product, states));

export const displayCostCentsAtAverage = (
  product: Product,
  states: Map<string, InventoryCostState>,
) => {
  const baseCost = averageCostCentsForProduct(product, states);
  if (product.categoryKind === "tobacco") return baseCost * 1000;
  return productHasBundle(product) ? baseCost * product.packsPerCarton : baseCost;
};
