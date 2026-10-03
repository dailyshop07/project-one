import { afterEach, describe, expect, it } from "vitest";
import { ProjectOneDatabase } from "./database";
import { Repository } from "./repository";
import { formatProductStock, formatStock, stockMap } from "../utils/format";

const databases: ProjectOneDatabase[] = [];

function makeRepository(label: string) {
  const database = new ProjectOneDatabase(`ProjectOneTest-${label}-${crypto.randomUUID()}`);
  databases.push(database);
  return new Repository(database);
}

const productInput = {
  name: "Item A",
  categoryName: "Category A",
  packSalePriceCents: 100,
  cartonSalePriceCents: 900,
  packCostCents: 10,
  packsPerCarton: 10,
  lowStockThresholdPacks: 5,
  openingStockPacks: 79,
};

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => {
    database.close();
    await database.delete();
  }));
});

describe("local-first business transactions", () => {
  it("initializes the three built-in categories and stores category-specific units", async () => {
    const repository = makeRepository("built-in-categories");
    await repository.initialize();
    let snapshot = await repository.snapshot();
    expect(snapshot.categories.filter((category) => category.kind).sort((a, b) => a.sortOrder - b.sortOrder).map((category) => category.name)).toEqual(["香烟", "电子烟", "烟丝"]);

    await repository.saveProduct({ ...productInput, name: "Item B", categoryName: "电子烟", categoryKind: "vape", openingStockPacks: 12, packsPerCarton: 99 });
    snapshot = await repository.snapshot();
    const vape = snapshot.products.find((product) => product.name === "Item B")!;
    expect(vape).toMatchObject({ categoryKind: "vape", baseUnitLabel: "支", bundleUnitLabel: "支", packsPerCarton: 1 });
    await repository.addToCart(vape.id, "pack");
    await repository.completeSale();
    snapshot = await repository.snapshot();
    expect(snapshot.saleItems[0].unitLabelSnapshot).toBe("支");
    expect(snapshot.inventoryMovements.filter((movement) => movement.productId === vape.id).reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0)).toBe(11);
  });

  it("keeps tobacco pricing per item while storing stock and cost in kilograms", async () => {
    const repository = makeRepository("tobacco-units");
    await repository.initialize();
    await repository.saveProduct({
      name: "40g",
      categoryName: "烟丝",
      categoryKind: "tobacco",
      packSalePriceCents: 500,
      cartonSalePriceCents: 500,
      cartonCostCents: 100000,
      packsPerCarton: 1,
      unitWeightGrams: 40,
      lowStockThresholdPacks: 500,
      openingStockPacks: 2000,
    });
    let snapshot = await repository.snapshot();
    const product = snapshot.products.find((entry) => entry.name === "40g")!;
    expect(product).toMatchObject({ categoryKind: "tobacco", baseUnitLabel: "件", unitWeightGrams: 40, packCostCents: 4000, cartonCostCents: 100000 });
    expect(formatProductStock(2000, product)).toBe("余 2 公斤");

    await repository.addToCart(product.id, "pack");
    await repository.completeSale();
    snapshot = await repository.snapshot();
    expect(snapshot.saleItems[0]).toMatchObject({ unitLabelSnapshot: "件", unitsInPacks: 40, unitCostCents: 4000, lineCostCents: 4000 });
    expect(snapshot.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0)).toBe(1960);
    expect(formatProductStock(1960, product)).toBe("余 1.96 公斤");
  });

  it("calculates moving average cost from each purchase and locks the sale cost", async () => {
    const repository = makeRepository("weighted-average-cost");
    await repository.initialize();
    await repository.saveProduct({
      name: "Weighted Item",
      categoryName: "Category A",
      packSalePriceCents: 1500,
      cartonSalePriceCents: 1500,
      packsPerCarton: 1,
      lowStockThresholdPacks: 5,
      openingStockPacks: 100,
      openingCostCents: 10000,
    });
    let snapshot = await repository.snapshot();
    const product = snapshot.products.find((entry) => entry.name === "Weighted Item")!;

    await repository.restock({ productId: product.id, cartons: 0, packs: 100, totalCostCents: 12000, occurredAt: new Date().toISOString() });
    await repository.restock({ productId: product.id, cartons: 0, packs: 200, totalCostCents: 26000, occurredAt: new Date().toISOString() });
    await repository.addToCart(product.id, "pack");
    await repository.completeSale();
    snapshot = await repository.snapshot();

    expect(snapshot.saleItems[0]).toMatchObject({ unitCostCents: 120, lineCostCents: 120, lineProfitCents: 1380 });
    expect(snapshot.inventoryMovements.filter((movement) => movement.reason === "restock").map((movement) => movement.unitCostCents).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([120, 130]);
    expect(snapshot.inventoryMovements.find((movement) => movement.reason === "sale")).toMatchObject({ costValueDeltaCents: -120, unitCostCents: 120 });
    expect(snapshot.products[0].packCostCents).toBe(100);
  });

  it("uses one moving average cost pool for all tobacco selling specifications", async () => {
    const repository = makeRepository("tobacco-weighted-cost");
    await repository.initialize();
    const tobacco = {
      categoryName: "烟丝",
      categoryKind: "tobacco" as const,
      packSalePriceCents: 500,
      cartonSalePriceCents: 500,
      packsPerCarton: 1,
      lowStockThresholdPacks: 500,
    };
    await repository.saveProduct({ ...tobacco, name: "烟丝 40克", unitWeightGrams: 40, openingStockPacks: 1000, openingCostCents: 10000 });
    await repository.saveProduct({ ...tobacco, name: "烟丝 25克", unitWeightGrams: 25, openingStockPacks: 0 });
    let snapshot = await repository.snapshot();
    const product = snapshot.products.find((entry) => entry.name === "烟丝 40克")!;
    const otherSpec = snapshot.products.find((entry) => entry.name === "烟丝 25克")!;

    await repository.restock({ productId: otherSpec.id, cartons: 0, packs: 1000, totalCostCents: 12000, occurredAt: new Date().toISOString() });
    await repository.addToCart(product.id, "pack");
    await repository.completeSale();
    snapshot = await repository.snapshot();

    expect(snapshot.saleItems[0]).toMatchObject({ unitsInPacks: 40, unitCostCents: 440, lineCostCents: 440, lineProfitCents: 60 });
    expect(snapshot.inventoryMovements.find((movement) => movement.reason === "sale")).toMatchObject({ costValueDeltaCents: -440, unitCostCents: 11 });
  });

  it("shares one tobacco stock pool across different selling specifications", async () => {
    const repository = makeRepository("shared-tobacco-stock");
    await repository.initialize();
    const tobaccoInput = {
      categoryName: "烟丝",
      categoryKind: "tobacco" as const,
      cartonSalePriceCents: 500,
      cartonCostCents: 100000,
      packsPerCarton: 1,
      lowStockThresholdPacks: 500,
    };
    await repository.saveProduct({ ...tobaccoInput, name: "烟丝 40克", packSalePriceCents: 500, unitWeightGrams: 40, openingStockPacks: 2000 });
    await repository.saveProduct({ ...tobaccoInput, name: "烟丝 25克", packSalePriceCents: 350, unitWeightGrams: 25, openingStockPacks: 0 });
    let snapshot = await repository.snapshot();
    const fortyGram = snapshot.products.find((product) => product.name === "烟丝 40克")!;
    const twentyFiveGram = snapshot.products.find((product) => product.name === "烟丝 25克")!;

    await repository.addToCart(fortyGram.id, "pack");
    await repository.completeSale();
    await repository.addToCart(twentyFiveGram.id, "pack");
    await repository.completeSale();
    snapshot = await repository.snapshot();

    expect(stockMap(snapshot.inventoryMovements, snapshot.products).get(fortyGram.id)).toBe(1935);
    expect(stockMap(snapshot.inventoryMovements, snapshot.products).get(twentyFiveGram.id)).toBe(1935);
    expect(snapshot.saleItems.map((item) => item.unitsInPacks).sort((a, b) => a - b)).toEqual([25, 40]);

    const result = await repository.countStock(twentyFiveGram.id, 1900, "盘点共用烟丝库存");
    expect(result).toEqual({ currentStockPacks: 1935, quantityDeltaPacks: -35 });
    snapshot = await repository.snapshot();
    expect(stockMap(snapshot.inventoryMovements, snapshot.products).get(fortyGram.id)).toBe(1900);
    expect(stockMap(snapshot.inventoryMovements, snapshot.products).get(twentyFiveGram.id)).toBe(1900);
  });

  it("stores stock as packs and commits one multi-item cart as one customer atomically", async () => {
    const repository = makeRepository("sale");
    await repository.initialize();
    await repository.updateDeviceLabel("Front Counter");
    await repository.saveProduct(productInput);
    let snapshot = await repository.snapshot();
    const product = snapshot.products[0];

    expect(snapshot.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0)).toBe(79);
    expect(formatStock(79, 10)).toBe("余 7 条 9 包");

    await repository.addToCart(product.id, "pack");
    await repository.addToCart(product.id, "carton");
    await repository.completeSale();
    snapshot = await repository.snapshot();

    expect(snapshot.sales).toHaveLength(1);
    expect(snapshot.sales[0]).toMatchObject({ itemCount: 2, revenueCents: 1000, costCents: 110, profitCents: 890, deviceLabelSnapshot: "Front Counter" });
    expect(snapshot.saleItems).toHaveLength(2);
    expect(snapshot.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0)).toBe(68);
    expect(snapshot.cart.items).toHaveLength(0);
    expect(snapshot.pendingCount).toBeGreaterThan(0);
  });

  it("keeps historical price snapshots after a product price changes", async () => {
    const repository = makeRepository("snapshots");
    await repository.initialize();
    await repository.saveProduct(productInput);
    const product = (await repository.snapshot()).products[0];
    await repository.addToCart(product.id, "pack");
    await repository.completeSale();

    await repository.saveProduct({ ...productInput, packSalePriceCents: 250, openingStockPacks: 0 }, product.id);
    const snapshot = await repository.snapshot();
    expect(snapshot.products[0].packSalePriceCents).toBe(250);
    expect(snapshot.saleItems[0].unitSalePriceCents).toBe(100);
    expect(snapshot.sales[0].revenueCents).toBe(100);
  });

  it("uses a negotiated current-cart price without changing the product price", async () => {
    const repository = makeRepository("negotiated-price");
    await repository.initialize();
    await repository.saveProduct(productInput);
    const product = (await repository.snapshot()).products[0];
    await repository.addToCart(product.id, "pack");
    await repository.setCartItemPrice(product.id, "pack", 75);
    let snapshot = await repository.snapshot();
    expect(snapshot.cart.items[0].unitPriceCents).toBe(75);
    await repository.completeSale();
    snapshot = await repository.snapshot();
    expect(snapshot.products[0].packSalePriceCents).toBe(100);
    expect(snapshot.saleItems[0]).toMatchObject({ unitSalePriceCents: 75, lineRevenueCents: 75 });
  });

  it("applies an edited total to the current sale while keeping quantity and stock changes", async () => {
    const repository = makeRepository("cart-total-override");
    await repository.initialize();
    await repository.saveProduct(productInput);
    const product = (await repository.snapshot()).products[0];
    await repository.addToCart(product.id, "pack");
    await repository.addToCart(product.id, "pack");
    await repository.setCartTotal(170);

    let snapshot = await repository.snapshot();
    expect(snapshot.cart).toMatchObject({ totalOverrideCents: 170, items: [{ productId: product.id, unitType: "pack", quantity: 2 }] });
    const sale = await repository.completeSale();
    snapshot = await repository.snapshot();
    expect(sale).toMatchObject({ revenueCents: 170, itemCount: 2, profitCents: 150 });
    expect(snapshot.saleItems[0]).toMatchObject({ quantity: 2, unitSalePriceCents: 85, lineRevenueCents: 170, lineProfitCents: 150 });
    expect(snapshot.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0)).toBe(77);
  });

  it("updates a completed sale price and totals without changing inventory", async () => {
    const repository = makeRepository("completed-sale-price");
    await repository.initialize();
    await repository.saveProduct(productInput);
    const product = (await repository.snapshot()).products[0];
    await repository.addToCart(product.id, "pack");
    const sale = await repository.completeSale();
    const before = await repository.snapshot();
    const item = before.saleItems[0];
    const stockBefore = before.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0);

    await repository.updateSaleItemPrice(sale.id, item.id, 75);
    const after = await repository.snapshot();

    expect(after.products[0].packSalePriceCents).toBe(100);
    expect(after.saleItems[0]).toMatchObject({ unitSalePriceCents: 75, lineRevenueCents: 75, lineProfitCents: 65 });
    expect(after.sales[0]).toMatchObject({ revenueCents: 75, costCents: 10, profitCents: 65 });
    expect(after.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0)).toBe(stockBefore);
    expect((await repository.pendingOperations(100)).filter((operation) => operation.entityType === "saleItem" || operation.entityType === "sale").length).toBeGreaterThanOrEqual(4);
  });

  it("rejects duplicate active product names but allows editing the same product", async () => {
    const repository = makeRepository("duplicate-product-name");
    await repository.initialize();
    await repository.saveProduct(productInput);
    const product = (await repository.snapshot()).products[0];

    await expect(repository.saveProduct({ ...productInput, name: " Item A " })).rejects.toThrow("商品名称已存在");
    await expect(repository.saveProduct({ ...productInput, name: "Item A", packSalePriceCents: 250 }, product.id)).resolves.toBeUndefined();
    expect((await repository.snapshot()).products[0].packSalePriceCents).toBe(250);
  });

  it("voids instead of deleting and restores inventory exactly once", async () => {
    const repository = makeRepository("void");
    await repository.initialize();
    await repository.saveProduct(productInput);
    const product = (await repository.snapshot()).products[0];
    await repository.addToCart(product.id, "carton");
    const sale = await repository.completeSale();
    await repository.voidSale(sale.id);
    await repository.voidSale(sale.id);
    const snapshot = await repository.snapshot();

    expect(snapshot.sales[0].voidedAt).toBeTruthy();
    expect(snapshot.inventoryMovements.filter((movement) => movement.reason === "saleVoid")).toHaveLength(1);
    expect(snapshot.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0)).toBe(79);
  });

  it("records restocks and manual corrections as append-only movements", async () => {
    const repository = makeRepository("inventory");
    await repository.initialize();
    await repository.saveProduct(productInput);
    const product = (await repository.snapshot()).products[0];
    await repository.restock({ productId: product.id, cartons: 2, packs: 3, totalCostCents: 5000, note: "Item A delivery", occurredAt: new Date().toISOString() });
    await repository.adjustStock(product.id, -2, "Count correction");
    const snapshot = await repository.snapshot();

    expect(snapshot.inventoryMovements).toHaveLength(3);
    expect(snapshot.inventoryMovements.map((movement) => movement.reason)).toEqual(expect.arrayContaining(["opening", "restock", "manualAdjustment"]));
    expect(snapshot.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0)).toBe(100);
  });

  it("records a stocktake as the difference between system and actual stock", async () => {
    const repository = makeRepository("stocktake");
    await repository.initialize();
    await repository.saveProduct(productInput);
    const product = (await repository.snapshot()).products[0];

    const result = await repository.countStock(product.id, 64, "损坏 1 包");
    let snapshot = await repository.snapshot();

    expect(result).toEqual({ currentStockPacks: 79, quantityDeltaPacks: -15 });
    expect(snapshot.inventoryMovements.find((movement) => movement.reason === "stocktake")).toMatchObject({ quantityDeltaPacks: -15, note: "损坏 1 包" });
    expect(snapshot.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0)).toBe(64);
    await repository.countStock(product.id, 64, "再次盘点");
    expect((await repository.snapshot()).inventoryMovements).toHaveLength(2);
  });

  it("persists the current cart across repository reloads", async () => {
    const database = new ProjectOneDatabase(`ProjectOneTest-cart-${crypto.randomUUID()}`);
    databases.push(database);
    const first = new Repository(database);
    await first.initialize();
    await first.saveProduct(productInput);
    const product = (await first.snapshot()).products[0];
    await first.addToCart(product.id, "pack");

    const reopened = new Repository(database);
    const snapshot = await reopened.snapshot();
    expect(snapshot.cart.items).toEqual([{ productId: product.id, unitType: "pack", quantity: 1 }]);
  });

  it("moves active products up and down and records the order changes", async () => {
    const repository = makeRepository("ordering");
    await repository.initialize();
    await repository.saveProduct(productInput);
    await repository.saveProduct({ ...productInput, name: "Item B", openingStockPacks: 0 });
    let snapshot = await repository.snapshot();
    const [first, second] = snapshot.products.sort((a, b) => a.sortOrder - b.sortOrder);

    await repository.moveProduct(second.id, "up");
    snapshot = await repository.snapshot();
    expect(snapshot.products.sort((a, b) => a.sortOrder - b.sortOrder).map((product) => product.id)).toEqual([second.id, first.id]);

    await repository.moveProduct(second.id, "down");
    snapshot = await repository.snapshot();
    expect(snapshot.products.sort((a, b) => a.sortOrder - b.sortOrder).map((product) => product.id)).toEqual([first.id, second.id]);
  });

  it("tombstones a product instead of deleting its history", async () => {
    const repository = makeRepository("delete-product");
    await repository.initialize();
    await repository.saveProduct(productInput);
    const product = (await repository.snapshot()).products[0];

    await repository.deleteProduct(product.id);
    const snapshot = await repository.snapshot();

    expect(snapshot.products[0]).toMatchObject({ id: product.id, active: false });
    expect(snapshot.products[0].deletedAt).toBeTruthy();
    expect((await repository.pendingOperations(100)).some((operation) => operation.entityType === "product" && operation.action === "tombstone")).toBe(true);
  });

  it("creates and renames categories without changing product links", async () => {
    const repository = makeRepository("categories");
    await repository.initialize();
    await repository.createCategory("Category B");
    await repository.saveProduct({ ...productInput, categoryName: "Category A", openingStockPacks: 0 });
    let snapshot = await repository.snapshot();
    const category = snapshot.categories.find((item) => item.name === "Category A");
    const product = snapshot.products[0];
    expect(category).toBeTruthy();
    await repository.updateCategory(category!.id, "Category Renamed");
    snapshot = await repository.snapshot();
    expect(snapshot.categories.find((item) => item.id === category!.id)?.name).toBe("Category Renamed");
    expect(snapshot.products[0].categoryId).toBe(product.categoryId);
  });

  it("creates custom categories with optional unit attributes", async () => {
    const repository = makeRepository("custom-category");
    await repository.initialize();
    const category = await repository.createCategory({ name: "Category C", baseUnitLabel: "件", bundleUnitLabel: "盒", unitsPerBundle: 6 });
    expect(category).toMatchObject({ name: "Category C", baseUnitLabel: "件", bundleUnitLabel: "盒", unitsPerBundle: 6 });
    await repository.saveProduct({ ...productInput, name: "Item C", categoryName: "Category C", openingStockPacks: 0, packsPerCarton: 1 });
    const product = (await repository.snapshot()).products.find((entry) => entry.name === "Item C");
    expect(product).toMatchObject({ categoryKind: undefined, baseUnitLabel: "件", bundleUnitLabel: "盒", packsPerCarton: 6 });
  });

  it("deletes a category with a tombstone while preserving products", async () => {
    const repository = makeRepository("delete-category");
    await repository.initialize();
    await repository.saveProduct({ ...productInput, openingStockPacks: 0 });
    let snapshot = await repository.snapshot();
    const category = snapshot.categories.find((item) => item.name === "Category A");
    expect(category).toBeTruthy();

    await repository.deleteCategory(category!.id);
    snapshot = await repository.snapshot();

    expect(snapshot.products[0].categoryId).toBe(category!.id);
    expect(snapshot.categories.find((item) => item.id === category!.id)).toMatchObject({ active: false });
    expect(snapshot.categories.find((item) => item.id === category!.id)?.deletedAt).toBeTruthy();
    expect((await repository.pendingOperations(100)).some((operation) => operation.entityType === "category" && operation.action === "tombstone")).toBe(true);
  });

  it("stores suppliers and keeps a deletion tombstone", async () => {
    const repository = makeRepository("suppliers");
    await repository.initialize();
    const supplier = await repository.createSupplier("Supplier A");
    let snapshot = await repository.snapshot();
    expect(snapshot.suppliers).toHaveLength(1);
    expect(snapshot.suppliers[0].name).toBe("Supplier A");
    await repository.deleteSupplier(supplier!.id);
    snapshot = await repository.snapshot();
    expect(snapshot.suppliers[0].deletedAt).toBeTruthy();
    expect((await repository.pendingOperations(100)).some((operation) => operation.entityType === "supplier" && operation.action === "tombstone")).toBe(true);
  });

  it("keeps one daily backup per day and restores it after business data is reset", async () => {
    const repository = makeRepository("automatic-backups");
    await repository.initialize();
    await repository.saveProduct(productInput);

    const first = await repository.ensureDailyBackup("2026-09-28");
    const second = await repository.ensureDailyBackup("2026-09-28");
    expect(second.id).toBe(first.id);
    expect(await repository.listLocalBackups()).toHaveLength(1);

    await repository.resetBusinessData();
    expect((await repository.snapshot()).products).toHaveLength(0);

    await repository.restoreLocalBackup(first.id);
    expect((await repository.snapshot()).products.map((product) => product.name)).toEqual(["Item A"]);
    expect((await repository.listLocalBackups()).map((backup) => backup.kind)).toEqual(["safety", "daily"]);
  });

  it("records the selected supplier on restock movements", async () => {
    const repository = makeRepository("restock-supplier");
    await repository.initialize();
    await repository.saveProduct(productInput);
    const product = (await repository.snapshot()).products[0];
    const supplier = await repository.createSupplier("Supplier B");
    await repository.restock({ productId: product.id, cartons: 1, packs: 0, supplierId: supplier.id, totalCostCents: 1200, note: "Delivery", occurredAt: new Date().toISOString() });
    const snapshot = await repository.snapshot();
    const movement = snapshot.inventoryMovements.find((entry) => entry.reason === "restock");
    expect(movement).toMatchObject({ supplierId: supplier.id, supplierNameSnapshot: "Supplier B", quantityDeltaPacks: 10 });
  });

  it("stores one editable daily turnover record and includes it in backups", async () => {
    const repository = makeRepository("daily-turnover");
    await repository.initialize();

    await repository.saveDailyTurnover({ businessDate: "2026-09-29", cashCents: 86000, posCents: 72000, lotteryPayoutCents: 16000, note: "当天结算" });
    await repository.saveDailyTurnover({ businessDate: "2026-09-29", cashCents: 90000, posCents: 70000, lotteryPayoutCents: 10000 });
    let snapshot = await repository.snapshot();

    expect(snapshot.dailyTurnovers).toHaveLength(1);
    expect(snapshot.dailyTurnovers[0]).toMatchObject({ businessDate: "2026-09-29", cashCents: 90000, posCents: 70000, lotteryPayoutCents: 10000 });
    expect((await repository.pendingOperations(100)).filter((operation) => operation.entityType === "dailyTurnover")).toHaveLength(2);

    const backup = await repository.exportBackup();
    expect(backup.data.dailyTurnovers).toHaveLength(1);
    await repository.resetBusinessData();
    await repository.importBackup(backup);
    snapshot = await repository.snapshot();
    expect(snapshot.dailyTurnovers[0].businessDate).toBe("2026-09-29");
  });
});

describe("pairing recovery", () => {
  it("adopts an invitation when a newly installed app only has an empty local identity", async () => {
    const repository = makeRepository("empty-invite-adoption");
    const original = await repository.initialize();
    const invitedSecret = "A".repeat(43);

    const identity = await repository.initialize(invitedSecret);

    expect(identity.inviteIgnored).toBe(false);
    expect(identity.pairing.secret).toBe(invitedSecret);
    expect(identity.pairing.secret).not.toBe(original.pairing.secret);
    expect((await repository.snapshot()).pairing.secret).toBe(invitedSecret);
  });

  it("does not silently switch an installation that already contains business data", async () => {
    const repository = makeRepository("used-invite-protection");
    const original = await repository.initialize();
    await repository.saveProduct(productInput);

    const identity = await repository.initialize("B".repeat(43));

    expect(identity.inviteIgnored).toBe(true);
    expect(identity.pairing.secret).toBe(original.pairing.secret);
  });

  it("allows an explicit pairing repair and clears remembered peers", async () => {
    const repository = makeRepository("explicit-pairing-repair");
    await repository.initialize();
    await repository.rememberPeer("old-peer", "Old phone");

    const invitedSecret = "C".repeat(43);
    await repository.replacePairingSecret(invitedSecret);
    const snapshot = await repository.snapshot();

    expect(snapshot.pairing.secret).toBe(invitedSecret);
    expect(snapshot.peers).toEqual([]);
  });
});

describe("idempotent two-device operation sync", () => {
  it("can bootstrap a new device from acknowledged history", async () => {
    const source = makeRepository("snapshot-source");
    const target = makeRepository("snapshot-target");
    await Promise.all([source.initialize(), target.initialize()]);
    await source.saveProduct(productInput);
    const productId = (await source.snapshot()).products[0].id;
    await source.addToCart(productId, "pack");
    await source.completeSale();

    const acknowledged = await source.pendingOperations(500);
    await source.acknowledgeOperations(acknowledged.map((operation) => operation.operationId));
    expect(await source.pendingOperations(500)).toHaveLength(0);

    const snapshotOperations = await source.snapshotOperations();
    await target.applyRemoteOperations(snapshotOperations.slice(0, 50));
    await target.applyRemoteOperations(snapshotOperations.slice(0, 50));
    const targetState = await target.snapshot();

    expect(targetState.products).toEqual(expect.arrayContaining([expect.objectContaining({ id: productId, name: "Item A" })]));
    expect(targetState.sales).toHaveLength(1);
    expect(targetState.saleItems).toHaveLength(1);
    expect(targetState.inventoryMovements.some((movement) => movement.reason === "sale")).toBe(true);
  });

  it("bootstraps a second new device after an earlier peer already received the history", async () => {
    const source = makeRepository("snapshot-multi-source");
    const wifePhone = makeRepository("snapshot-multi-wife");
    const sparePhone = makeRepository("snapshot-multi-spare");
    await Promise.all([source.initialize(), wifePhone.initialize(), sparePhone.initialize()]);
    await source.saveProduct(productInput);
    const productId = (await source.snapshot()).products[0].id;
    await source.addToCart(productId, "pack");
    await source.completeSale();

    const history = await source.snapshotOperations();
    await wifePhone.applyRemoteOperations(history);
    await sparePhone.applyRemoteOperations(history);

    const [wifeState, spareState] = await Promise.all([wifePhone.snapshot(), sparePhone.snapshot()]);
    expect(wifeState.products).toEqual(expect.arrayContaining([expect.objectContaining({ id: productId, name: "Item A" })]));
    expect(spareState.products).toEqual(expect.arrayContaining([expect.objectContaining({ id: productId, name: "Item A" })]));
    expect(wifeState.sales).toHaveLength(1);
    expect(spareState.sales).toHaveLength(1);
    expect(spareState.inventoryMovements.some((movement) => movement.reason === "sale")).toBe(true);
  });

  it("repairs legacy records without sync metadata before bootstrapping a new phone", async () => {
    const source = makeRepository("legacy-snapshot-source");
    const target = makeRepository("legacy-snapshot-target");
    await Promise.all([source.initialize(), target.initialize()]);
    await source.saveProduct(productInput);
    const productId = (await source.snapshot()).products[0].id;
    await source.addToCart(productId, "pack");
    await source.completeSale();

    const stripSyncMetadata = <T extends object>(record: T, stripOperationId = false) => {
      const legacy = { ...record } as Record<string, unknown>;
      delete legacy.createdAt;
      delete legacy.updatedAt;
      delete legacy.deviceId;
      delete legacy.version;
      if (stripOperationId) delete legacy.operationId;
      return legacy;
    };
    await source.database.products.bulkPut((await source.database.products.toArray()).map((record) => stripSyncMetadata(record)) as never);
    await source.database.sales.bulkPut((await source.database.sales.toArray()).map((record) => stripSyncMetadata(record)) as never);
    await source.database.saleItems.bulkPut((await source.database.saleItems.toArray()).map((record) => stripSyncMetadata(record)) as never);
    await source.database.inventoryMovements.bulkPut((await source.database.inventoryMovements.toArray()).map((record) => stripSyncMetadata(record, true)) as never);

    await source.initialize();
    const history = await source.snapshotOperations();
    expect(history.every((operation) => operation.deviceId && operation.entityVersion > 0 && operation.createdAt)).toBe(true);
    await target.applyRemoteOperations(history);
    const targetState = await target.snapshot();

    expect(targetState.products).toEqual(expect.arrayContaining([expect.objectContaining({ id: productId, name: "Item A" })]));
    expect(targetState.sales).toHaveLength(1);
    expect(targetState.saleItems).toHaveLength(1);
    expect(targetState.inventoryMovements.some((movement) => movement.reason === "sale")).toBe(true);
  });

  it("ignores duplicate operations and converges after both devices sell offline", async () => {
    const a = makeRepository("device-a");
    const b = makeRepository("device-b");
    await Promise.all([a.initialize(), b.initialize()]);
    await a.saveProduct(productInput);

    const bootstrap = await a.pendingOperations(100);
    await b.applyRemoteOperations(bootstrap);
    await a.acknowledgeOperations(bootstrap.map((operation) => operation.operationId));
    const productId = (await a.snapshot()).products[0].id;

    await a.addToCart(productId, "pack");
    await b.addToCart(productId, "carton");
    await Promise.all([a.completeSale(), b.completeSale()]);

    const aOperations = await a.pendingOperations(100);
    const bOperations = await b.pendingOperations(100);
    await b.applyRemoteOperations(aOperations);
    await b.applyRemoteOperations(aOperations);
    await a.applyRemoteOperations(bOperations);

    const [aState, bState] = await Promise.all([a.snapshot(), b.snapshot()]);
    const stockA = aState.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0);
    const stockB = bState.inventoryMovements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0);

    expect(aState.sales).toHaveLength(2);
    expect(bState.sales).toHaveLength(2);
    expect(stockA).toBe(68);
    expect(stockB).toBe(68);
    expect(new Set(bState.inventoryMovements.map((movement) => movement.operationId)).size).toBe(bState.inventoryMovements.length);
  });

  it("syncs a completed-sale price correction idempotently", async () => {
    const a = makeRepository("price-sync-a");
    const b = makeRepository("price-sync-b");
    await Promise.all([a.initialize(), b.initialize()]);
    await a.saveProduct(productInput);
    const bootstrap = await a.pendingOperations(100);
    await b.applyRemoteOperations(bootstrap);
    const productId = (await a.snapshot()).products[0].id;
    await a.addToCart(productId, "pack");
    const sale = await a.completeSale();
    const saleOperations = await a.pendingOperations(100);
    await b.applyRemoteOperations(saleOperations);
    const item = (await a.snapshot()).saleItems.find((entry) => entry.saleId === sale.id)!;

    await a.updateSaleItemPrice(sale.id, item.id, 75);
    const correctionOperations = await a.pendingOperations(100);
    await b.applyRemoteOperations(correctionOperations);
    await b.applyRemoteOperations(correctionOperations);
    const bState = await b.snapshot();

    expect(bState.saleItems.find((entry) => entry.id === item.id)).toMatchObject({ unitSalePriceCents: 75, lineRevenueCents: 75, lineProfitCents: 65 });
    expect(bState.sales.find((entry) => entry.id === sale.id)).toMatchObject({ revenueCents: 75, profitCents: 65 });
  });

  it("persists the applied sequence and does not replay a durable event twice", async () => {
    const source = makeRepository("durable-sequence-source");
    const target = makeRepository("durable-sequence-target");
    await Promise.all([source.initialize(), target.initialize()]);
    await source.saveProduct(productInput);
    const bootstrap = await source.pendingOperations(500);
    await target.applyRemoteEvents(bootstrap.map((operation, index) => ({ sequence: index + 1, eventId: operation.eventId ?? operation.operationId, operation })));
    await source.acknowledgeOperations(bootstrap.map((operation) => operation.operationId));

    const productId = (await source.snapshot()).products.find((product) => product.name === "Item A")!.id;
    await source.addToCart(productId, "pack");
    await source.completeSale();
    const saleOperations = await source.pendingOperations(500);
    const startSequence = bootstrap.length + 1;
    const events = saleOperations.map((operation, index) => ({ sequence: startSequence + index, eventId: operation.eventId ?? operation.operationId, operation }));

    const first = await target.applyRemoteEvents(events);
    const second = await target.applyRemoteEvents(events);
    const targetState = await target.snapshot();

    expect(first.gap).toBe(false);
    expect(second.lastAppliedSequence).toBe(startSequence + saleOperations.length - 1);
    expect(await target.getLastAppliedSequence()).toBe(startSequence + saleOperations.length - 1);
    expect(targetState.sales).toHaveLength(1);
    expect(targetState.inventoryMovements.filter((movement) => movement.reason === "sale")).toHaveLength(1);
  });
});
