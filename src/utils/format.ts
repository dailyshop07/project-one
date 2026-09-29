import type { InventoryMovement, Product, ProductKind, Sale, SaleItem, UnitType } from "../types";

export const formatMoney = (cents: number, symbol = "$") =>
  `${symbol}${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatStock = (packs: number, packsPerCarton: number) => {
  const negative = packs < 0;
  const absolute = Math.abs(packs);
  const cartons = Math.floor(absolute / packsPerCarton);
  const remainder = absolute % packsPerCarton;
  return `${negative ? "差 " : "余 "}${cartons} 条 ${remainder} 包`;
};

export const productKind = (product: Pick<Product, "categoryKind">): ProductKind => product.categoryKind ?? "cigarette";

export const productBaseUnitLabel = (product: Pick<Product, "categoryKind" | "baseUnitLabel">) =>
  product.baseUnitLabel ?? (productKind(product) === "vape" ? "支" : productKind(product) === "tobacco" ? "件" : "包");

export const productBundleUnitLabel = (product: Pick<Product, "categoryKind" | "bundleUnitLabel">) =>
  product.bundleUnitLabel ?? (productKind(product) === "cigarette" ? "条" : productBaseUnitLabel(product));

export const productHasBundle = (product: Pick<Product, "categoryKind" | "baseUnitLabel" | "bundleUnitLabel" | "packsPerCarton">) =>
  product.categoryKind === undefined
    ? product.packsPerCarton > 1 && Boolean(product.bundleUnitLabel && product.bundleUnitLabel !== product.baseUnitLabel)
    : productKind(product) === "cigarette" && product.packsPerCarton > 1;

export const productUnitLabel = (product: Pick<Product, "categoryKind" | "baseUnitLabel" | "bundleUnitLabel">, unitType: UnitType) =>
  unitType === "carton" ? productBundleUnitLabel(product) : productBaseUnitLabel(product);

export const formatProductStock = (stock: number, product: Pick<Product, "categoryKind" | "baseUnitLabel" | "bundleUnitLabel" | "packsPerCarton">) => {
  if (product.categoryKind === "tobacco") return `${stock < 0 ? "差 " : "余 "}${(Math.abs(stock) / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 })} 公斤`;
  if (productHasBundle(product)) return formatStock(stock, product.packsPerCarton);
  const negative = stock < 0;
  return `${negative ? "差 " : "余 "}${Math.abs(stock)} ${productBaseUnitLabel(product)}`;
};

export const cartonCostCents = (product: Pick<Product, "categoryKind" | "packCostCents" | "cartonCostCents" | "packsPerCarton">) =>
  product.cartonCostCents ?? product.packCostCents * product.packsPerCarton;

export const packCostCents = (product: Pick<Product, "categoryKind" | "packCostCents" | "cartonCostCents" | "packsPerCarton">) =>
  product.categoryKind === "tobacco" ? product.packCostCents : Math.round(cartonCostCents(product) / product.packsPerCarton);

export const inventoryValueCents = (stock: number, product: Pick<Product, "categoryKind" | "packCostCents" | "cartonCostCents" | "packsPerCarton" | "unitWeightGrams">) => {
  const availableStock = Math.max(0, stock);
  if (product.categoryKind === "tobacco") {
    return Math.round(availableStock / Math.max(1, product.unitWeightGrams ?? 1) * packCostCents(product));
  }
  return availableStock * packCostCents(product);
};

export const thresholdCartons = (thresholdPacks: number, packsPerCarton: number) =>
  Math.ceil(Math.max(0, thresholdPacks) / Math.max(1, packsPerCarton));

export const localDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const formatTime = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export const formatDateHeading = (date: Date) =>
  date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });

export const saleSummary = (items: SaleItem[]) =>
  items
    .map((item) => `${item.productNameSnapshot} · ${item.quantity} ${item.unitLabelSnapshot ?? (item.unitType === "carton" ? "条" : "包")}`)
    .join(" + ");

export const stockMap = (movements: InventoryMovement[], products: Pick<Product, "id" | "categoryKind">[] = []) => {
  const map = new Map<string, number>();
  movements.forEach((movement) => map.set(movement.productId, (map.get(movement.productId) ?? 0) + movement.quantityDeltaPacks));
  const tobaccoProductIds = new Set(products.filter((product) => product.categoryKind === "tobacco").map((product) => product.id));
  if (tobaccoProductIds.size) {
    const sharedTobaccoStock = movements.reduce((total, movement) => tobaccoProductIds.has(movement.productId) ? total + movement.quantityDeltaPacks : total, 0);
    products.filter((product) => tobaccoProductIds.has(product.id)).forEach((product) => map.set(product.id, sharedTobaccoStock));
  }
  return map;
};

export const activeSales = (sales: Sale[]) => sales.filter((sale) => !sale.voidedAt && !sale.deletedAt);

export const categoryName = (product: Product, categories: { id: string; name: string }[]) =>
  categories.find((category) => category.id === product.categoryId)?.name ?? "—";
