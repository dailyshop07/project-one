import Dexie from "dexie";
import { db, type ProjectOneDatabase } from "./database";
import { ensureIdentity, randomId, randomSecret, validPairingSecret } from "./identity";
import { localDateKey } from "../utils/format";
import { averageCostCentsForProduct, inventoryCostStates } from "../utils/cost";
import { BUILTIN_CATEGORIES } from "../types";
import type {
  AppSnapshot,
  BackupDocument,
  CartItem,
  Category,
  CurrentCart,
  DailyTurnover,
  InventoryMovement,
  LocalBackupKind,
  LocalBackupRecord,
  OutboxEntry,
  Product,
  Sale,
  SaleItem,
  Supplier,
  ProductKind,
  SyncFields,
  SyncEntityType,
  SyncOperation,
  UnitType,
} from "../types";

type ProductInput = {
  name: string;
  categoryName: string;
  categoryKind?: ProductKind;
  baseUnitLabel?: string;
  bundleUnitLabel?: string;
  categoryUnitsPerBundle?: number;
  unitWeightGrams?: number;
  packSalePriceCents: number;
  cartonSalePriceCents: number;
  cartonCostCents?: number;
  packCostCents?: number;
  openingCostCents?: number;
  packsPerCarton: number;
  lowStockThresholdCartons?: number;
  lowStockThresholdPacks?: number;
  openingStockPacks: number;
};

type CategoryInput = {
  name: string;
  baseUnitLabel?: string;
  bundleUnitLabel?: string;
  unitsPerBundle?: number;
};

type RestockInput = {
  productId: string;
  cartons: number;
  packs: number;
  supplierId?: string;
  totalCostCents?: number;
  note?: string;
  occurredAt: string;
};

type DailyTurnoverInput = {
  businessDate: string;
  cashCents: number;
  posCents: number;
  lotteryPayoutCents: number;
  note?: string;
};

const nowIso = () => new Date().toISOString();
const BACKUP_RETENTION: Record<LocalBackupKind, number> = { daily: 31, manual: 10, safety: 10 };
const clean = (value: string) => value.trim().replace(/\s+/g, " ");
const isBusinessDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && localDateKey(date) === value;
};
const weightFromNameGrams = (name: string) => {
  const match = name.match(/(\d+(?:\.\d+)?)\s*(kg|公斤|g|克)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.max(1, Math.round(value * (/kg|公斤/i.test(match[2]) ? 1000 : 1))) : undefined;
};
const legacyBaseCostFromInput = (categoryKind: ProductKind | undefined, cartonCostCents: number | undefined, packCostCentsValue: number | undefined, packsPerCarton: number, unitWeightGrams: number | undefined) => {
  if (categoryKind === "tobacco") {
    return cartonCostCents !== undefined
      ? Math.max(0, Math.round(cartonCostCents / 1000))
      : Math.max(0, Math.round((packCostCentsValue ?? 0) / Math.max(1, unitWeightGrams ?? 1)));
  }
  const cartonCost = cartonCostCents ?? (packCostCentsValue ?? 0) * packsPerCarton;
  return Math.max(0, Math.round(cartonCost / Math.max(1, packsPerCarton)));
};
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isSyncFields = (value: unknown): value is SyncFields => {
  const fields = value as Partial<SyncFields> | null;
  return Boolean(
    fields
    && nonEmptyString(fields.id)
    && nonEmptyString(fields.createdAt)
    && nonEmptyString(fields.updatedAt)
    && nonEmptyString(fields.deviceId)
    && Number.isInteger(fields.version)
    && fields.version! > 0,
  );
};

function normalizeLegacySyncPayload(
  entityType: SyncEntityType,
  payload: SyncOperation["payload"],
  deviceId: string,
  timestamp: string,
): SyncOperation["payload"] {
  const legacy = payload as Partial<SyncFields> & SyncOperation["payload"];
  const eventTimestamp = "completedAt" in payload
    ? payload.completedAt
    : "occurredAt" in payload
      ? payload.occurredAt
      : undefined;
  const createdAt = nonEmptyString(legacy.createdAt)
    ? legacy.createdAt
    : nonEmptyString(eventTimestamp)
      ? eventTimestamp
      : timestamp;
  const normalized = {
    ...payload,
    createdAt,
    updatedAt: nonEmptyString(legacy.updatedAt) ? legacy.updatedAt : createdAt,
    deviceId: nonEmptyString(legacy.deviceId) ? legacy.deviceId : deviceId,
    version: Number.isInteger(legacy.version) && legacy.version! > 0 ? legacy.version : 1,
  } as SyncOperation["payload"];
  if (entityType === "inventoryMovement" && !nonEmptyString((normalized as InventoryMovement).operationId)) {
    (normalized as InventoryMovement).operationId = `legacy-movement:${normalized.id}`;
  }
  return normalized;
}

function operationFor(
  entityType: SyncEntityType,
  payload: SyncOperation["payload"],
  deviceId: string,
  forcedOperationId?: string,
): OutboxEntry {
  const entityVersion = isSyncFields(payload) ? payload.version : 1;
  return {
    operationId: forcedOperationId ?? randomId(),
    entityType,
    entityId: payload.id,
    action: "deletedAt" in payload && payload.deletedAt ? "tombstone" : "upsert",
    payload,
    createdAt: nowIso(),
    deviceId,
    entityVersion,
    status: "pending",
    attempts: 0,
  };
}

// A full-sync operation is derived from the record instead of from the
// outbox entry. This lets a device that already acknowledged an operation
// still provide the current record to a newly installed peer.
function snapshotOperationFor(entityType: SyncEntityType, payload: SyncOperation["payload"]): SyncOperation {
  return {
    operationId: `snapshot:${entityType}:${payload.id}:${payload.version}:${payload.updatedAt}:${payload.deviceId}`,
    entityType,
    entityId: payload.id,
    action: payload.deletedAt ? "tombstone" : "upsert",
    payload,
    createdAt: payload.updatedAt,
    deviceId: payload.deviceId,
    entityVersion: payload.version,
  };
}

function compareVersions(local: { version?: number; updatedAt?: string; deviceId?: string }, incoming: { version?: number; updatedAt?: string; deviceId?: string }) {
  const localVersion = Number.isFinite(local.version) ? local.version! : 0;
  const incomingVersion = Number.isFinite(incoming.version) ? incoming.version! : 0;
  if (incomingVersion !== localVersion) return incomingVersion - localVersion;
  const timeOrder = (incoming.updatedAt ?? "").localeCompare(local.updatedAt ?? "");
  if (timeOrder !== 0) return timeOrder;
  return (incoming.deviceId ?? "").localeCompare(local.deviceId ?? "");
}

export class Repository {
  private listeners = new Set<() => void>();

  constructor(public readonly database: ProjectOneDatabase = db) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  async initialize(invitedSecret?: string) {
    await this.database.open();
    let identity = await ensureIdentity(invitedSecret, this.database);
    if (identity.inviteIgnored && invitedSecret && await this.isEmptyInstallation()) {
      await this.replacePairingSecret(invitedSecret);
      identity = { ...identity, pairing: { id: "pairing", secret: invitedSecret, createdAt: nowIso() }, inviteIgnored: false };
    }
    await this.database.transaction("rw", this.database.currentCart, this.database.syncOutbox, async () => {
      if (!(await this.database.currentCart.get("current"))) {
        await this.database.currentCart.add({ id: "current", items: [], updatedAt: nowIso() });
      }
      await this.database.syncOutbox.where("status").equals("sending").modify({ status: "pending" });
    });
    await this.backfillLegacySyncFields(identity.device.deviceId);
    await this.database.transaction("rw", [this.database.categories, this.database.products, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.ensureBuiltinCategories(identity.device.deviceId);
    });
    return identity;
  }

  private async backfillLegacySyncFields(deviceId: string) {
    const tables = [
      { entityType: "category", table: this.database.categories },
      { entityType: "supplier", table: this.database.suppliers },
      { entityType: "product", table: this.database.products },
      { entityType: "sale", table: this.database.sales },
      { entityType: "saleItem", table: this.database.saleItems },
      { entityType: "inventoryMovement", table: this.database.inventoryMovements },
      { entityType: "dailyTurnover", table: this.database.dailyTurnovers },
    ] as const;
    const timestamp = nowIso();
    await this.database.transaction(
      "rw",
      [
        this.database.categories,
        this.database.suppliers,
        this.database.products,
        this.database.sales,
        this.database.saleItems,
        this.database.inventoryMovements,
        this.database.dailyTurnovers,
        this.database.syncOutbox,
        this.database.processedOperations,
      ],
      async () => {
        for (const { entityType, table } of tables) {
          const records = await table.toArray() as SyncOperation["payload"][];
          for (const record of records) {
            const missingMovementId = entityType === "inventoryMovement" && !nonEmptyString((record as InventoryMovement).operationId);
            if (isSyncFields(record) && !missingMovementId) continue;
            const normalized = normalizeLegacySyncPayload(entityType, record, deviceId, timestamp);
            await table.put(normalized as never);
            await this.recordLocalOperation(operationFor(entityType, normalized, deviceId));
          }
        }
      },
    );
  }

  private async isEmptyInstallation() {
    const [products, suppliers, sales, inventoryMovements, dailyTurnovers, cart] = await Promise.all([
      this.database.products.count(),
      this.database.suppliers.count(),
      this.database.sales.count(),
      this.database.inventoryMovements.count(),
      this.database.dailyTurnovers.count(),
      this.database.currentCart.get("current"),
    ]);
    return products + suppliers + sales + inventoryMovements + dailyTurnovers === 0 && !(cart?.items.length);
  }

  async replacePairingSecret(secret: string) {
    if (!validPairingSecret(secret)) throw new Error("邀请链接无效，请重新复制完整链接。");
    const current = await this.database.pairing.get("pairing");
    if (current?.secret === secret) return;
    await this.database.transaction("rw", [this.database.pairing, this.database.peers, this.database.syncOutbox], async () => {
      await this.database.pairing.put({ id: "pairing", secret, createdAt: nowIso() });
      await this.database.peers.clear();
      await this.database.syncOutbox.where("status").equals("sending").modify({ status: "pending" });
    });
    this.emit();
  }

  async snapshot(): Promise<AppSnapshot> {
    const [categories, suppliers, products, sales, saleItems, inventoryMovements, dailyTurnovers, cart, device, pairing, peers, settings, pendingCount, conflictCount] =
      await Promise.all([
        this.database.categories.toArray(),
        this.database.suppliers.toArray(),
        this.database.products.toArray(),
        this.database.sales.toArray(),
        this.database.saleItems.toArray(),
        this.database.inventoryMovements.toArray(),
        this.database.dailyTurnovers.toArray(),
        this.database.currentCart.get("current"),
        this.database.devices.get("local"),
        this.database.pairing.get("pairing"),
        this.database.peers.toArray(),
        this.database.settings.toArray(),
        this.database.syncOutbox.where("status").anyOf("pending", "sending").count(),
        this.database.conflicts.count(),
      ]);
    if (!device || !pairing) throw new Error("Local identity is not initialized.");
    return {
      categories,
      suppliers,
      products,
      sales,
      saleItems,
      inventoryMovements,
      dailyTurnovers,
      cart: cart ?? { id: "current", items: [], updatedAt: nowIso() },
      device,
      pairing,
      peers,
      settings,
      pendingCount,
      conflictCount,
    };
  }

  async setSetting(key: string, value: unknown) {
    await this.database.settings.put({ key, value });
    this.emit();
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const record = await this.database.settings.get(key);
    return (record?.value as T | undefined) ?? fallback;
  }

  async saveDailyTurnover(input: DailyTurnoverInput) {
    const device = await this.database.devices.get("local");
    const businessDate = String(input.businessDate ?? "").trim();
    const amounts = [input.cashCents, input.posCents, input.lotteryPayoutCents];
    if (!device) throw new Error("Device is not initialized.");
    if (!isBusinessDate(businessDate)) throw new Error("请输入有效的营业日期。");
    if (amounts.some((amount) => !Number.isFinite(amount) || amount < 0)) throw new Error("金额不能小于 0。");
    const existing = await this.database.dailyTurnovers.get(`turnover:${businessDate}`);
    const timestamp = nowIso();
    const turnover: DailyTurnover = {
      id: existing?.id ?? `turnover:${businessDate}`,
      businessDate,
      cashCents: Math.round(input.cashCents),
      posCents: Math.round(input.posCents),
      lotteryPayoutCents: Math.round(input.lotteryPayoutCents),
      note: clean(input.note ?? "") || undefined,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      deviceId: device.deviceId,
      version: (existing?.version ?? 0) + 1,
    };
    await this.database.transaction("rw", [this.database.dailyTurnovers, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.database.dailyTurnovers.put(turnover);
      await this.recordLocalOperation(operationFor("dailyTurnover", turnover, device.deviceId));
    });
    this.emit();
    return turnover;
  }

  private async recordLocalOperation(operation: OutboxEntry) {
    await this.database.syncOutbox.put(operation);
    await this.database.processedOperations.put({
      operationId: operation.operationId,
      processedAt: nowIso(),
      sourceDeviceId: operation.deviceId,
    });
  }

  private async ensureBuiltinCategories(deviceId: string) {
    for (const definition of BUILTIN_CATEGORIES) {
      let category = await this.database.categories.get(definition.id);
      if (!category) {
        const legacy = await this.database.categories.filter((entry) => !entry.deletedAt && entry.name === definition.name).first();
        if (legacy) {
          const timestamp = nowIso();
          category = { ...legacy, id: definition.id, name: definition.name, kind: definition.kind, baseUnitLabel: definition.baseUnitLabel, bundleUnitLabel: definition.bundleUnitLabel, sortOrder: definition.sortOrder, active: true, updatedAt: timestamp, deviceId, version: legacy.version + 1 };
          await this.database.categories.put(category);
          const products = await this.database.products.where("categoryId").equals(legacy.id).toArray();
          for (const product of products) {
            const migratedProduct: Product = { ...product, categoryId: definition.id, categoryKind: definition.kind, updatedAt: timestamp, deviceId, version: product.version + 1 };
            await this.database.products.put(migratedProduct);
            await this.recordLocalOperation(operationFor("product", migratedProduct, deviceId));
          }
          const tombstone: Category = { ...legacy, active: false, deletedAt: timestamp, updatedAt: timestamp, deviceId, version: legacy.version + 2 };
          await this.database.categories.put(tombstone);
          await this.recordLocalOperation(operationFor("category", tombstone, deviceId));
          await this.recordLocalOperation(operationFor("category", category, deviceId));
          continue;
        }
        const timestamp = nowIso();
        category = { id: definition.id, name: definition.name, kind: definition.kind, baseUnitLabel: definition.baseUnitLabel, bundleUnitLabel: definition.bundleUnitLabel, sortOrder: definition.sortOrder, active: true, createdAt: timestamp, updatedAt: timestamp, deviceId, version: 1 };
        await this.database.categories.put(category);
        await this.recordLocalOperation(operationFor("category", category, deviceId));
        continue;
      }
      if (category.deletedAt || category.name !== definition.name || category.kind !== definition.kind || category.baseUnitLabel !== definition.baseUnitLabel || category.bundleUnitLabel !== definition.bundleUnitLabel || !category.active || category.sortOrder !== definition.sortOrder) {
        const updated: Category = { ...category, name: definition.name, kind: definition.kind, baseUnitLabel: definition.baseUnitLabel, bundleUnitLabel: definition.bundleUnitLabel, sortOrder: definition.sortOrder, active: true, deletedAt: undefined, updatedAt: nowIso(), deviceId, version: category.version + 1 };
        await this.database.categories.put(updated);
        await this.recordLocalOperation(operationFor("category", updated, deviceId));
      }
    }
  }

  private async categoryForName(name: string, deviceId: string, attributes?: Omit<CategoryInput, "name">): Promise<Category> {
    const normalized = clean(name);
    const definition = BUILTIN_CATEGORIES.find((entry) => entry.name === normalized);
    const existing = await this.database.categories.filter((category) => !category.deletedAt && category.name.toLocaleLowerCase() === normalized.toLocaleLowerCase()).first();
    if (existing) return existing;
    const timestamp = nowIso();
    const baseUnitLabel = clean(attributes?.baseUnitLabel ?? definition?.baseUnitLabel ?? "").slice(0, 12) || undefined;
    const bundleUnitLabel = clean(attributes?.bundleUnitLabel ?? definition?.bundleUnitLabel ?? "").slice(0, 12) || undefined;
    const unitsPerBundle = attributes?.unitsPerBundle && attributes.unitsPerBundle > 0 ? Math.round(attributes.unitsPerBundle) : undefined;
    const category: Category = {
      id: definition?.id ?? randomId(),
      name: normalized,
      sortOrder: definition?.sortOrder ?? await this.database.categories.count(),
      active: true,
      kind: definition?.kind,
      baseUnitLabel,
      bundleUnitLabel,
      unitsPerBundle,
      createdAt: timestamp,
      updatedAt: timestamp,
      deviceId,
      version: 1,
    };
    await this.database.categories.add(category);
    await this.recordLocalOperation(operationFor("category", category, deviceId));
    return category;
  }

  async createCategory(input: CategoryInput | string) {
    const device = await this.database.devices.get("local");
    const source = typeof input === "string" ? { name: input } : input;
    const normalized = clean(source.name).slice(0, 40);
    if (!device || !normalized) throw new Error("Category name is required.");
    const existing = await this.database.categories.filter((category) => !category.deletedAt && category.name.toLocaleLowerCase() === normalized.toLocaleLowerCase()).first();
    if (existing) throw new Error("This category already exists.");
    let category: Category | undefined;
    await this.database.transaction("rw", [this.database.categories, this.database.syncOutbox, this.database.processedOperations], async () => {
      category = await this.categoryForName(normalized, device.deviceId, source);
    });
    this.emit();
    return category;
  }

  async updateCategory(categoryId: string, name: string) {
    const [device, existing] = await Promise.all([this.database.devices.get("local"), this.database.categories.get(categoryId)]);
    const normalized = clean(name).slice(0, 40);
    if (!device || !existing || !normalized) throw new Error("Category name is required.");
    const duplicate = await this.database.categories.filter((category) => !category.deletedAt && category.id !== categoryId && category.name.toLocaleLowerCase() === normalized.toLocaleLowerCase()).first();
    if (duplicate) throw new Error("This category already exists.");
    const updated: Category = { ...existing, name: normalized, updatedAt: nowIso(), deviceId: device.deviceId, version: existing.version + 1 };
    await this.database.transaction("rw", [this.database.categories, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.database.categories.put(updated);
      await this.recordLocalOperation(operationFor("category", updated, device.deviceId));
    });
    this.emit();
    return updated;
  }

  async deleteCategory(categoryId: string) {
    const [device, existing] = await Promise.all([this.database.devices.get("local"), this.database.categories.get(categoryId)]);
    if (!device || !existing) throw new Error("Category not found.");
    if (existing.kind) throw new Error("内置分类不能删除。");
    if (existing.deletedAt) return;
    const timestamp = nowIso();
    const deleted: Category = {
      ...existing,
      active: false,
      deletedAt: timestamp,
      updatedAt: timestamp,
      deviceId: device.deviceId,
      version: existing.version + 1,
    };
    await this.database.transaction("rw", [this.database.categories, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.database.categories.put(deleted);
      await this.recordLocalOperation(operationFor("category", deleted, device.deviceId));
    });
    this.emit();
  }

  async createSupplier(name: string) {
    const device = await this.database.devices.get("local");
    const normalized = clean(name).slice(0, 60);
    if (!device || !normalized) throw new Error("Supplier name is required.");
    const existing = await this.database.suppliers.filter((supplier) => !supplier.deletedAt && supplier.name.toLocaleLowerCase() === normalized.toLocaleLowerCase()).first();
    if (existing) throw new Error("This supplier already exists.");
    const timestamp = nowIso();
    const supplier: Supplier = { id: randomId(), name: normalized, createdAt: timestamp, updatedAt: timestamp, deviceId: device.deviceId, version: 1 };
    await this.database.transaction("rw", [this.database.suppliers, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.database.suppliers.add(supplier);
      await this.recordLocalOperation(operationFor("supplier", supplier, device.deviceId));
    });
    this.emit();
    return supplier;
  }

  async deleteSupplier(supplierId: string) {
    const [device, existing] = await Promise.all([this.database.devices.get("local"), this.database.suppliers.get(supplierId)]);
    if (!device || !existing || existing.deletedAt) return;
    const timestamp = nowIso();
    const deleted: Supplier = { ...existing, deletedAt: timestamp, updatedAt: timestamp, deviceId: device.deviceId, version: existing.version + 1 };
    await this.database.transaction("rw", [this.database.suppliers, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.database.suppliers.put(deleted);
      await this.recordLocalOperation(operationFor("supplier", deleted, device.deviceId));
    });
    this.emit();
  }

  async saveProduct(input: ProductInput, productId?: string) {
    const device = await this.database.devices.get("local");
    const normalizedName = clean(input.name);
    if (!device) throw new Error("Device is not initialized.");
    if (!normalizedName || !clean(input.categoryName)) throw new Error("Name and category are required.");
    if (input.packsPerCarton < 1) throw new Error("Packs per carton must be at least 1.");
    const categoryDefinition = BUILTIN_CATEGORIES.find((entry) => entry.name === clean(input.categoryName));

    await this.database.transaction(
      "rw",
      [this.database.products, this.database.categories, this.database.inventoryMovements, this.database.syncOutbox, this.database.processedOperations],
      async () => {
        const existing = productId ? await this.database.products.get(productId) : undefined;
        const duplicate = await this.database.products
          .filter((candidate) => !candidate.deletedAt && candidate.id !== productId && candidate.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())
          .first();
        if (duplicate) throw new Error("商品名称已存在，不能重复。");
        const category = await this.categoryForName(input.categoryName, device.deviceId);
        const categoryKind = input.categoryKind ?? category.kind ?? categoryDefinition?.kind;
        const packsPerCarton = categoryKind === "cigarette"
          ? Math.max(1, Math.round(input.packsPerCarton))
          : categoryKind
            ? 1
            : Math.max(1, Math.round(input.categoryUnitsPerBundle ?? category.unitsPerBundle ?? input.packsPerCarton ?? 1));
        const unitWeightGrams = categoryKind === "tobacco"
          ? Math.max(1, Math.round(input.unitWeightGrams ?? weightFromNameGrams(normalizedName) ?? 1))
          : undefined;
        const baseUnitLabel = input.baseUnitLabel ?? category.baseUnitLabel ?? (categoryKind === "vape" ? "支" : categoryKind === "tobacco" ? "件" : "单位");
        const bundleUnitLabel = input.bundleUnitLabel ?? category.bundleUnitLabel ?? (categoryKind === "cigarette" ? "条" : baseUnitLabel);
        const legacyBaseCost = legacyBaseCostFromInput(categoryKind, input.cartonCostCents, input.packCostCents, packsPerCarton, unitWeightGrams);
        const openingQuantity = Math.round(input.openingStockPacks);
        const openingCost = input.openingCostCents === undefined
          ? Math.max(0, Math.round(openingQuantity * legacyBaseCost))
          : Math.max(0, Math.round(input.openingCostCents));
        if (!existing && openingQuantity > 0 && input.openingCostCents === undefined && input.cartonCostCents === undefined && input.packCostCents === undefined) {
          throw new Error("有期初库存时，请输入期初库存总成本。");
        }
        const initialBaseCost = openingQuantity > 0
          ? Math.max(0, Math.round(openingCost / openingQuantity))
          : legacyBaseCost;
        const derivedPackCost = categoryKind === "tobacco"
          ? Math.round(initialBaseCost * (unitWeightGrams ?? 1))
          : initialBaseCost;
        const derivedCartonCost = categoryKind === "tobacco"
          ? Math.round(initialBaseCost * 1000)
          : Math.round(initialBaseCost * packsPerCarton);
        const saleUnitCost = existing?.packCostCents ?? derivedPackCost;
        const cartonCost = existing?.cartonCostCents ?? derivedCartonCost;
        const thresholdPacks = input.lowStockThresholdCartons !== undefined
          ? Math.max(0, Math.round(input.lowStockThresholdCartons)) * packsPerCarton
          : Math.max(0, Math.round(input.lowStockThresholdPacks ?? 0));
        const timestamp = nowIso();
        const product: Product = {
          id: existing?.id ?? randomId(),
          name: normalizedName,
          categoryId: category.id,
          categoryKind,
          baseUnitLabel,
          bundleUnitLabel,
          unitWeightGrams,
          packSalePriceCents: Math.max(0, Math.round(input.packSalePriceCents)),
          cartonSalePriceCents: Math.max(0, Math.round(input.cartonSalePriceCents)),
          // These fields remain as a legacy display fallback. New cost
          // calculations come from inventory movement cost values.
          packCostCents: saleUnitCost,
          cartonCostCents: cartonCost,
          packsPerCarton,
          lowStockThresholdPacks: thresholdPacks,
          active: existing?.active ?? true,
          sortOrder: existing?.sortOrder ?? (await this.database.products.count()),
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          deviceId: device.deviceId,
          version: (existing?.version ?? 0) + 1,
          deletedAt: existing?.deletedAt,
        };
        await this.database.products.put(product);
        await this.recordLocalOperation(operationFor("product", product, device.deviceId));

        if (!existing && openingQuantity !== 0) {
          const movementId = randomId();
          const movement: InventoryMovement = {
            id: movementId,
            operationId: movementId,
            productId: product.id,
            quantityDeltaPacks: Math.round(input.openingStockPacks),
            reason: "opening",
            occurredAt: timestamp,
            costValueDeltaCents: openingCost,
            unitCostCents: openingQuantity > 0 ? Math.round(openingCost / openingQuantity) : undefined,
            createdAt: timestamp,
            updatedAt: timestamp,
            deviceId: device.deviceId,
            version: 1,
          };
          await this.database.inventoryMovements.add(movement);
          await this.recordLocalOperation(operationFor("inventoryMovement", movement, device.deviceId, movementId));
        }
      },
    );
    this.emit();
  }

  async setProductActive(productId: string, active: boolean) {
    const [device, existing] = await Promise.all([this.database.devices.get("local"), this.database.products.get(productId)]);
    if (!device || !existing) throw new Error("Product not found.");
    const product: Product = { ...existing, active, updatedAt: nowIso(), deviceId: device.deviceId, version: existing.version + 1 };
    await this.database.transaction("rw", [this.database.products, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.database.products.put(product);
      await this.recordLocalOperation(operationFor("product", product, device.deviceId));
    });
    this.emit();
  }

  async deleteProduct(productId: string) {
    const [device, existing, cart] = await Promise.all([
      this.database.devices.get("local"),
      this.database.products.get(productId),
      this.database.currentCart.get("current"),
    ]);
    if (!device || !existing) throw new Error("Product not found.");
    if (cart?.items.some((item) => item.productId === productId)) {
      throw new Error("当前本单包含这个商品，请先完成或清空本单。");
    }
    if (existing.deletedAt) return;
    const timestamp = nowIso();
    const deleted: Product = {
      ...existing,
      active: false,
      deletedAt: timestamp,
      updatedAt: timestamp,
      deviceId: device.deviceId,
      version: existing.version + 1,
    };
    await this.database.transaction("rw", [this.database.products, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.database.products.put(deleted);
      await this.recordLocalOperation(operationFor("product", deleted, device.deviceId));
    });
    this.emit();
  }

  async updateDeviceLabel(label: string) {
    const device = await this.database.devices.get("local");
    if (!device) throw new Error("Device is not initialized.");
    const nextLabel = clean(label).slice(0, 40) || "本机";
    if (nextLabel === device.label) return device;
    const updated = { ...device, label: nextLabel };
    await this.database.devices.put(updated);
    this.emit();
    return updated;
  }

  async moveProduct(productId: string, direction: "up" | "down") {
    const device = await this.database.devices.get("local");
    if (!device) throw new Error("Device is not initialized.");
    const allProducts = await this.database.products
      .filter((product) => product.active && !product.deletedAt)
      .sortBy("sortOrder");
    const index = allProducts.findIndex((product) => product.id === productId);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= allProducts.length) return;

    const current = allProducts[index];
    const target = allProducts[targetIndex];
    const timestamp = nowIso();
    const currentUpdated: Product = { ...current, sortOrder: target.sortOrder, updatedAt: timestamp, deviceId: device.deviceId, version: current.version + 1 };
    const targetUpdated: Product = { ...target, sortOrder: current.sortOrder, updatedAt: timestamp, deviceId: device.deviceId, version: target.version + 1 };
    await this.database.transaction("rw", [this.database.products, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.database.products.bulkPut([currentUpdated, targetUpdated]);
      await this.recordLocalOperation(operationFor("product", currentUpdated, device.deviceId));
      await this.recordLocalOperation(operationFor("product", targetUpdated, device.deviceId));
    });
    this.emit();
  }

  async addToCart(productId: string, unitType: UnitType) {
    await this.database.transaction("rw", [this.database.products, this.database.currentCart], async () => {
      const product = await this.database.products.get(productId);
      if (!product || product.deletedAt || !product.active) throw new Error("Product is unavailable.");
      const cart = (await this.database.currentCart.get("current")) ?? { id: "current" as const, items: [], updatedAt: nowIso() };
      const existing = cart.items.find((item) => item.productId === productId && item.unitType === unitType);
      const items: CartItem[] = existing
        ? cart.items.map((item) => (item === existing ? { ...item, quantity: item.quantity + 1 } : item))
        : [...cart.items, { productId, unitType, quantity: 1 }];
      await this.database.currentCart.put({ ...cart, items, totalOverrideCents: undefined, updatedAt: nowIso() });
    });
    this.emit();
  }

  async updateCartQuantity(productId: string, unitType: UnitType, quantity: number) {
    const cart = (await this.database.currentCart.get("current")) ?? { id: "current" as const, items: [], updatedAt: nowIso() };
    const items = cart.items
      .map((item) => (item.productId === productId && item.unitType === unitType ? { ...item, quantity: Math.max(0, Math.round(quantity)) } : item))
      .filter((item) => item.quantity > 0);
    await this.database.currentCart.put({ ...cart, items, totalOverrideCents: undefined, updatedAt: nowIso() });
    this.emit();
  }

  async setCartItemPrice(productId: string, unitType: UnitType, unitPriceCents: number) {
    const cart = (await this.database.currentCart.get("current")) ?? { id: "current" as const, items: [], updatedAt: nowIso() };
    if (!cart.items.some((item) => item.productId === productId && item.unitType === unitType)) throw new Error("This item is not in the current sale.");
    if (!Number.isFinite(unitPriceCents) || unitPriceCents < 0) throw new Error("请输入有效的成交价。");
    const items = cart.items.map((item) => item.productId === productId && item.unitType === unitType ? { ...item, unitPriceCents: Math.round(unitPriceCents) } : item);
    await this.database.currentCart.put({ ...cart, items, totalOverrideCents: undefined, updatedAt: nowIso() });
    this.emit();
  }

  async setCartTotal(totalCents: number) {
    const cart = (await this.database.currentCart.get("current")) ?? { id: "current" as const, items: [], updatedAt: nowIso() };
    if (!cart.items.length) throw new Error("The current sale is empty.");
    if (!Number.isFinite(totalCents) || totalCents < 0) throw new Error("请输入有效的本单总金额。");
    await this.database.currentCart.put({ ...cart, totalOverrideCents: Math.round(totalCents), updatedAt: nowIso() });
    this.emit();
  }

  async clearCart() {
    await this.database.currentCart.put({ id: "current", items: [], updatedAt: nowIso() });
    this.emit();
  }

  async completeSale() {
    const device = await this.database.devices.get("local");
    if (!device) throw new Error("Device is not initialized.");
    let completedSale: Sale | undefined;
    await this.database.transaction(
      "rw",
      [
        this.database.currentCart,
        this.database.products,
        this.database.sales,
        this.database.saleItems,
        this.database.inventoryMovements,
        this.database.syncOutbox,
        this.database.processedOperations,
      ],
      async () => {
        const cart = await this.database.currentCart.get("current");
        if (!cart?.items.length) throw new Error("The current sale is empty.");
        const products = new Map((await this.database.products.bulkGet(cart.items.map((item) => item.productId))).filter(Boolean).map((product) => [product!.id, product!]));
        if (products.size !== new Set(cart.items.map((item) => item.productId)).size) throw new Error("A product in this sale no longer exists.");
        const allProducts = await this.database.products.toArray();
        const existingMovements = await this.database.inventoryMovements.toArray();
        const existingSaleItems = await this.database.saleItems.toArray();
        const costStates = inventoryCostStates(existingMovements, allProducts, existingSaleItems);
        const saleId = randomId();
        const timestamp = nowIso();
        let items: SaleItem[] = cart.items.map((cartItem) => {
          const product = products.get(cartItem.productId)!;
          const unitsInPacks = cartItem.unitType === "carton"
            ? product.packsPerCarton
            : product.categoryKind === "tobacco" ? product.unitWeightGrams ?? 1 : 1;
          const unitSalePriceCents = cartItem.unitPriceCents ?? (cartItem.unitType === "carton" ? product.cartonSalePriceCents : product.packSalePriceCents);
          const baseCostCents = averageCostCentsForProduct(product, costStates);
          const unitCostCents = baseCostCents * unitsInPacks;
          const lineRevenueCents = unitSalePriceCents * cartItem.quantity;
          const lineCostCents = unitCostCents * cartItem.quantity;
          return {
            id: randomId(),
            saleId,
            productId: product.id,
            productNameSnapshot: product.name,
            unitType: cartItem.unitType,
            unitLabelSnapshot: cartItem.unitType === "carton" ? product.bundleUnitLabel ?? "条" : product.baseUnitLabel ?? "包",
            quantity: cartItem.quantity,
            unitsInPacks,
            unitSalePriceCents,
            unitCostCents,
            lineRevenueCents,
            lineCostCents,
            lineProfitCents: lineRevenueCents - lineCostCents,
            createdAt: timestamp,
            updatedAt: timestamp,
            deviceId: device.deviceId,
            version: 1,
          };
        });
        if (cart.totalOverrideCents !== undefined) {
          const targetTotal = Math.round(cart.totalOverrideCents);
          const defaultTotal = items.reduce((sum, item) => sum + item.lineRevenueCents, 0);
          let allocated = 0;
          items = items.map((item, index) => {
            const remaining = Math.max(0, targetTotal - allocated);
            const lineRevenueCents = index === items.length - 1
              ? remaining
              : Math.min(remaining, defaultTotal > 0 ? Math.max(0, Math.round(targetTotal * item.lineRevenueCents / defaultTotal)) : 0);
            allocated += lineRevenueCents;
            const unitSalePriceCents = item.quantity > 0 ? Math.round(lineRevenueCents / item.quantity) : 0;
            return {
              ...item,
              unitSalePriceCents,
              lineRevenueCents,
              lineProfitCents: lineRevenueCents - item.lineCostCents,
            };
          });
        }
        const sale: Sale = {
          id: saleId,
          completedAt: timestamp,
          deviceLabelSnapshot: device.label,
          revenueCents: items.reduce((sum, item) => sum + item.lineRevenueCents, 0),
          costCents: items.reduce((sum, item) => sum + item.lineCostCents, 0),
          profitCents: items.reduce((sum, item) => sum + item.lineProfitCents, 0),
          itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
          createdAt: timestamp,
          updatedAt: timestamp,
          deviceId: device.deviceId,
          version: 1,
        };
        await this.database.sales.add(sale);
        await this.database.saleItems.bulkAdd(items);
        await this.recordLocalOperation(operationFor("sale", sale, device.deviceId));
        for (const item of items) {
          await this.recordLocalOperation(operationFor("saleItem", item, device.deviceId));
          const movementId = randomId();
          const movement: InventoryMovement = {
            id: movementId,
            operationId: movementId,
            productId: item.productId,
            quantityDeltaPacks: -(item.unitsInPacks * item.quantity),
            reason: "sale",
            relatedSaleId: sale.id,
            occurredAt: timestamp,
            costValueDeltaCents: -item.lineCostCents,
            unitCostCents: item.unitsInPacks > 0 ? Math.round(item.lineCostCents / (item.unitsInPacks * item.quantity)) : 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            deviceId: device.deviceId,
            version: 1,
          };
          await this.database.inventoryMovements.add(movement);
          await this.recordLocalOperation(operationFor("inventoryMovement", movement, device.deviceId, movementId));
        }
        await this.database.currentCart.put({ id: "current", items: [], updatedAt: timestamp });
        completedSale = sale;
      },
    );
    this.emit();
    return completedSale!;
  }

  async updateSaleItemPrice(saleId: string, saleItemId: string, unitPriceCents: number) {
    const device = await this.database.devices.get("local");
    if (!device) throw new Error("Device is not initialized.");
    if (!Number.isFinite(unitPriceCents) || unitPriceCents < 0) throw new Error("请输入有效的成交价。");
    let updatedSale: Sale | undefined;
    await this.database.transaction(
      "rw",
      [this.database.sales, this.database.saleItems, this.database.syncOutbox, this.database.processedOperations],
      async () => {
        const sale = await this.database.sales.get(saleId);
        if (!sale) throw new Error("Sale not found.");
        if (sale.voidedAt) throw new Error("作废交易不能改价。");
        const items = await this.database.saleItems.where("saleId").equals(saleId).toArray();
        const existingItem = items.find((item) => item.id === saleItemId);
        if (!existingItem) throw new Error("Sale item not found.");
        const timestamp = nowIso();
        const nextPrice = Math.round(unitPriceCents);
        const updatedItem: SaleItem = {
          ...existingItem,
          unitSalePriceCents: nextPrice,
          lineRevenueCents: nextPrice * existingItem.quantity,
          lineProfitCents: nextPrice * existingItem.quantity - existingItem.lineCostCents,
          updatedAt: timestamp,
          deviceId: device.deviceId,
          version: (existingItem.version ?? 0) + 1,
        };
        const nextItems = items.map((item) => item.id === saleItemId ? updatedItem : item);
        updatedSale = {
          ...sale,
          revenueCents: nextItems.reduce((sum, item) => sum + item.lineRevenueCents, 0),
          costCents: nextItems.reduce((sum, item) => sum + item.lineCostCents, 0),
          profitCents: nextItems.reduce((sum, item) => sum + item.lineProfitCents, 0),
          itemCount: nextItems.reduce((sum, item) => sum + item.quantity, 0),
          updatedAt: timestamp,
          deviceId: device.deviceId,
          version: sale.version + 1,
        };
        await this.database.saleItems.put(updatedItem);
        await this.database.sales.put(updatedSale);
        await this.recordLocalOperation(operationFor("saleItem", updatedItem, device.deviceId));
        await this.recordLocalOperation(operationFor("sale", updatedSale, device.deviceId));
      },
    );
    this.emit();
    return updatedSale!;
  }

  async restock(input: RestockInput) {
    const [device, product, supplier] = await Promise.all([
      this.database.devices.get("local"),
      this.database.products.get(input.productId),
      input.supplierId ? this.database.suppliers.get(input.supplierId) : Promise.resolve(undefined),
    ]);
    if (!device || !product) throw new Error("Product not found.");
    if (input.supplierId && (!supplier || supplier.deletedAt)) throw new Error("供应商不存在或已删除。");
    const quantityDeltaPacks = Math.round(input.cartons) * product.packsPerCarton + Math.round(input.packs);
    if (quantityDeltaPacks <= 0) throw new Error("Restock quantity must be greater than zero.");
    const totalCostCents = input.totalCostCents === undefined ? undefined : Math.max(0, Math.round(input.totalCostCents));
    const movementId = randomId();
    const movement: InventoryMovement = {
      id: movementId,
      operationId: movementId,
      productId: product.id,
      quantityDeltaPacks,
      reason: "restock",
      supplierId: supplier?.id,
      supplierNameSnapshot: supplier?.name,
      totalCostCents,
      costValueDeltaCents: totalCostCents,
      unitCostCents: totalCostCents === undefined ? undefined : Math.round(totalCostCents / quantityDeltaPacks),
      note: clean(input.note ?? "") || undefined,
      occurredAt: new Date(input.occurredAt).toISOString(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deviceId: device.deviceId,
      version: 1,
    };
    await this.database.transaction("rw", [this.database.inventoryMovements, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.database.inventoryMovements.add(movement);
      await this.recordLocalOperation(operationFor("inventoryMovement", movement, device.deviceId, movementId));
    });
    this.emit();
  }

  async adjustStock(productId: string, quantityDeltaPacks: number, note: string) {
    const [device, product] = await Promise.all([this.database.devices.get("local"), this.database.products.get(productId)]);
    if (!device || !product || !Number.isInteger(quantityDeltaPacks) || quantityDeltaPacks === 0) throw new Error("Enter a non-zero whole-pack adjustment.");
    const timestamp = nowIso();
    const movementId = randomId();
    const [movements, products, saleItems] = await Promise.all([
      this.database.inventoryMovements.toArray(),
      this.database.products.toArray(),
      this.database.saleItems.toArray(),
    ]);
    const averageCostCents = averageCostCentsForProduct(product, inventoryCostStates(movements, products, saleItems));
    const movement: InventoryMovement = {
      id: movementId,
      operationId: movementId,
      productId,
      quantityDeltaPacks,
      reason: "manualAdjustment",
      note: clean(note) || undefined,
      occurredAt: timestamp,
      costValueDeltaCents: quantityDeltaPacks * averageCostCents,
      unitCostCents: averageCostCents,
      createdAt: timestamp,
      updatedAt: timestamp,
      deviceId: device.deviceId,
      version: 1,
    };
    await this.database.transaction("rw", [this.database.inventoryMovements, this.database.syncOutbox, this.database.processedOperations], async () => {
      await this.database.inventoryMovements.add(movement);
      await this.recordLocalOperation(operationFor("inventoryMovement", movement, device.deviceId, movementId));
    });
    this.emit();
  }

  async countStock(productId: string, actualStockPacks: number, note: string) {
    const [device, product] = await Promise.all([
      this.database.devices.get("local"),
      this.database.products.get(productId),
    ]);
    if (!device || !product || !Number.isInteger(actualStockPacks) || actualStockPacks < 0) throw new Error("盘点库存必须是大于等于 0 的整数。");
    let result = { currentStockPacks: 0, quantityDeltaPacks: 0 };
    let changed = false;
    await this.database.transaction("rw", [this.database.products, this.database.inventoryMovements, this.database.saleItems, this.database.syncOutbox, this.database.processedOperations], async () => {
      const stockProductIds = product.categoryKind === "tobacco"
        ? new Set((await this.database.products.toArray()).filter((entry) => entry.categoryKind === "tobacco").map((entry) => entry.id))
        : new Set([productId]);
      const allProducts = await this.database.products.toArray();
      const allMovements = await this.database.inventoryMovements.toArray();
      const saleItems = await this.database.saleItems.toArray();
      const movements = allMovements.filter((movement) => stockProductIds.has(movement.productId));
      const currentStockPacks = movements.reduce((sum, movement) => sum + movement.quantityDeltaPacks, 0);
      const quantityDeltaPacks = actualStockPacks - currentStockPacks;
      result = { currentStockPacks, quantityDeltaPacks };
      if (quantityDeltaPacks === 0) return;

      const timestamp = nowIso();
      const movementId = randomId();
      const averageCostCents = averageCostCentsForProduct(product, inventoryCostStates(allMovements, allProducts, saleItems));
      const movement: InventoryMovement = {
        id: movementId,
        operationId: movementId,
        productId,
        quantityDeltaPacks,
        reason: "stocktake",
        note: clean(note) || "库存盘点",
        occurredAt: timestamp,
        costValueDeltaCents: quantityDeltaPacks * averageCostCents,
        unitCostCents: averageCostCents,
        createdAt: timestamp,
        updatedAt: timestamp,
        deviceId: device.deviceId,
        version: 1,
      };
      await this.database.inventoryMovements.add(movement);
      await this.recordLocalOperation(operationFor("inventoryMovement", movement, device.deviceId, movementId));
      changed = true;
    });
    if (changed) this.emit();
    return result;
  }

  async voidSale(saleId: string) {
    const [device, originalSale, items] = await Promise.all([
      this.database.devices.get("local"),
      this.database.sales.get(saleId),
      this.database.saleItems.where("saleId").equals(saleId).toArray(),
    ]);
    if (!device || !originalSale) throw new Error("Sale not found.");
    if (originalSale.voidedAt) return;
    await this.database.transaction(
      "rw",
      [this.database.sales, this.database.inventoryMovements, this.database.syncOutbox, this.database.processedOperations],
      async () => {
        const timestamp = nowIso();
        const sale: Sale = {
          ...originalSale,
          voidedAt: timestamp,
          voidedByDeviceId: device.deviceId,
          updatedAt: timestamp,
          deviceId: device.deviceId,
          version: originalSale.version + 1,
        };
        await this.database.sales.put(sale);
        await this.recordLocalOperation(operationFor("sale", sale, device.deviceId));
        for (const item of items) {
          const movementId = `void:${sale.id}:${item.id}`;
          const movement: InventoryMovement = {
            id: movementId,
            operationId: movementId,
            productId: item.productId,
            quantityDeltaPacks: item.unitsInPacks * item.quantity,
            reason: "saleVoid",
            relatedSaleId: sale.id,
            occurredAt: timestamp,
            costValueDeltaCents: item.lineCostCents,
            unitCostCents: item.unitsInPacks > 0 ? Math.round(item.lineCostCents / (item.unitsInPacks * item.quantity)) : 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            deviceId: device.deviceId,
            version: 1,
          };
          await this.database.inventoryMovements.add(movement);
          await this.recordLocalOperation(operationFor("inventoryMovement", movement, device.deviceId, movementId));
        }
      },
    );
    this.emit();
  }

  async pendingOperations(limit = 100) {
    return this.database.syncOutbox.where("status").equals("pending").sortBy("createdAt").then((items) => items.slice(0, limit));
  }

  /**
   * Return the current durable data as idempotent operations.
   *
   * The outbox is acknowledged after a peer receives an operation. It
   * therefore cannot be used as a source of truth for a peer installed later
   * (for example an iOS Home Screen Web App). A full snapshot handshake fills
   * that gap without copying browser storage between Safari and the
   * standalone app.
   */
  async snapshotOperations(): Promise<SyncOperation[]> {
    const [categories, suppliers, products, sales, saleItems, inventoryMovements, dailyTurnovers] = await Promise.all([
      this.database.categories.toArray(),
      this.database.suppliers.toArray(),
      this.database.products.toArray(),
      this.database.sales.toArray(),
      this.database.saleItems.toArray(),
      this.database.inventoryMovements.toArray(),
      this.database.dailyTurnovers.toArray(),
    ]);
    const entries: Array<[SyncEntityType, SyncOperation["payload"]]> = [
      ...categories.map((payload) => ["category", payload] as [SyncEntityType, SyncOperation["payload"]]),
      ...suppliers.map((payload) => ["supplier", payload] as [SyncEntityType, SyncOperation["payload"]]),
      ...products.map((payload) => ["product", payload] as [SyncEntityType, SyncOperation["payload"]]),
      ...sales.map((payload) => ["sale", payload] as [SyncEntityType, SyncOperation["payload"]]),
      ...saleItems.map((payload) => ["saleItem", payload] as [SyncEntityType, SyncOperation["payload"]]),
      ...inventoryMovements.map((payload) => ["inventoryMovement", payload] as [SyncEntityType, SyncOperation["payload"]]),
      ...dailyTurnovers.map((payload) => ["dailyTurnover", payload] as [SyncEntityType, SyncOperation["payload"]]),
    ];
    return entries.map(([entityType, payload]) => snapshotOperationFor(entityType, payload));
  }

  async markSending(operationIds: string[]) {
    if (!operationIds.length) return;
    const timestamp = nowIso();
    await this.database.syncOutbox.where("operationId").anyOf(operationIds).modify((entry) => {
      entry.status = "sending";
      entry.attempts += 1;
      entry.lastAttemptAt = timestamp;
    });
    this.emit();
  }

  async acknowledgeOperations(operationIds: string[]) {
    if (!operationIds.length) return;
    await this.database.syncOutbox.where("operationId").anyOf(operationIds).modify({ status: "acknowledged", acknowledgedAt: nowIso() });
    this.emit();
  }

  async requeueOperations(operationIds: string[]) {
    if (!operationIds.length) return;
    await this.database.syncOutbox.where("operationId").anyOf(operationIds).modify({ status: "pending" });
    this.emit();
  }

  async requeueStaleSending(maxAgeMs = 4_000) {
    const cutoff = Date.now() - maxAgeMs;
    const stale = (await this.database.syncOutbox.where("status").equals("sending").toArray())
      .filter((entry) => !entry.lastAttemptAt || new Date(entry.lastAttemptAt).getTime() <= cutoff)
      .map((entry) => entry.operationId);
    if (!stale.length) return 0;
    await this.requeueOperations(stale);
    return stale.length;
  }

  async rememberPeer(deviceId: string, label: string) {
    const existing = await this.database.peers.get(deviceId);
    const timestamp = nowIso();
    await this.database.peers.put({
      deviceId,
      label: clean(label).slice(0, 40) || "iPhone",
      firstSeenAt: existing?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
      lastSyncedAt: existing?.lastSyncedAt,
    });
    this.emit();
  }

  async markPeerSynced(deviceId: string) {
    const timestamp = nowIso();
    await this.database.peers.where("deviceId").equals(deviceId).modify({ lastSeenAt: timestamp, lastSyncedAt: timestamp });
    this.emit();
  }

  async forgetPeer(deviceId: string) {
    await this.database.peers.delete(deviceId);
    this.emit();
  }

  async applyRemoteOperations(operations: SyncOperation[]) {
    const acknowledged: string[] = [];
    let changed = false;
    await this.database.transaction(
      "rw",
      [
        this.database.categories,
        this.database.suppliers,
        this.database.products,
        this.database.sales,
        this.database.saleItems,
        this.database.inventoryMovements,
        this.database.dailyTurnovers,
        this.database.processedOperations,
        this.database.conflicts,
      ],
      async () => {
        for (const operation of operations.slice(0, 100)) {
          if (!operation?.operationId || !operation.entityId || !operation.deviceId || !operation.payload) continue;
          if (await this.database.processedOperations.get(operation.operationId)) {
            acknowledged.push(operation.operationId);
            continue;
          }
          const payload = operation.payload;
          if (payload.id !== operation.entityId) continue;
          let applied = false;
          if (operation.entityType === "inventoryMovement") {
            const movement = payload as InventoryMovement;
            if (!(await this.database.inventoryMovements.where("operationId").equals(movement.operationId).first())) {
              await this.database.inventoryMovements.add(movement);
              applied = true;
            }
          } else if (operation.entityType === "dailyTurnover") {
            const turnover = payload as DailyTurnover;
            const local = await this.database.dailyTurnovers.get(turnover.id);
            if (!local || compareVersions(local, turnover) > 0) {
              await this.database.dailyTurnovers.put(turnover);
              applied = true;
            }
            if (local && local.version === turnover.version && JSON.stringify(local) !== JSON.stringify(turnover)) {
              const incomingWins = compareVersions(local, turnover) > 0;
              await this.database.conflicts.put({
                id: `${operation.entityType}:${operation.entityId}:${operation.operationId}`,
                entityType: operation.entityType,
                entityId: operation.entityId,
                localVersion: local.version,
                incomingVersion: turnover.version,
                winningDeviceId: incomingWins ? turnover.deviceId : local.deviceId,
                recordedAt: nowIso(),
              });
            }
          } else {
            const table = operation.entityType === "product"
              ? this.database.products
              : operation.entityType === "category"
                ? this.database.categories
                : operation.entityType === "supplier"
                  ? this.database.suppliers
                  : operation.entityType === "saleItem"
                    ? this.database.saleItems
                    : this.database.sales;
            const incoming = payload as Product | Category | Supplier | Sale | SaleItem;
            const local = await table.get(incoming.id as never) as Product | Category | Supplier | Sale | SaleItem | undefined;
            if (!local || compareVersions(local, incoming) > 0) {
              await table.put(incoming as never);
              applied = true;
            }
            if (local && local.version === incoming.version && JSON.stringify(local) !== JSON.stringify(incoming)) {
              const incomingWins = compareVersions(local, incoming) > 0;
              await this.database.conflicts.put({
                id: `${operation.entityType}:${operation.entityId}:${operation.operationId}`,
                entityType: operation.entityType,
                entityId: operation.entityId,
                localVersion: local.version,
                incomingVersion: incoming.version,
                winningDeviceId: incomingWins ? incoming.deviceId : local.deviceId,
                recordedAt: nowIso(),
              });
            }
          }
          // A full snapshot can be retried or arrive at the same time as a
          // second relay delivery. `put` keeps that retry idempotent.
          await this.database.processedOperations.put({
            operationId: operation.operationId,
            processedAt: nowIso(),
            sourceDeviceId: operation.deviceId,
          });
          acknowledged.push(operation.operationId);
          changed ||= applied;
        }
      },
    );
    if (changed) this.emit();
    return acknowledged;
  }

  async exportBackup(): Promise<BackupDocument> {
    const [categories, suppliers, products, sales, saleItems, inventoryMovements, dailyTurnovers, currentCart, settings, outbox, processedOperations, peers] = await Promise.all([
      this.database.categories.toArray(),
      this.database.suppliers.toArray(),
      this.database.products.toArray(),
      this.database.sales.toArray(),
      this.database.saleItems.toArray(),
      this.database.inventoryMovements.toArray(),
      this.database.dailyTurnovers.toArray(),
      this.database.currentCart.toArray(),
      this.database.settings.toArray(),
      this.database.syncOutbox.toArray(),
      this.database.processedOperations.toArray(),
      this.database.peers.toArray(),
    ]);
    return {
      format: "project-one-backup",
      version: 1,
      exportedAt: nowIso(),
      data: { categories, suppliers, products, sales, saleItems, inventoryMovements, dailyTurnovers, currentCart, settings, outbox, processedOperations, peers },
    };
  }

  async createLocalBackup(kind: LocalBackupKind = "daily", localDate = localDateKey(new Date()), label?: string): Promise<LocalBackupRecord> {
    if (kind === "daily") {
      const existing = await this.database.localBackups.get(`daily-${localDate}`);
      if (existing) return existing;
    }
    const record: LocalBackupRecord = {
      id: kind === "daily" ? `daily-${localDate}` : `${kind}-${randomId()}`,
      kind,
      localDate,
      createdAt: nowIso(),
      label,
      backup: await this.exportBackup(),
    };
    await this.database.localBackups.put(record);
    await this.pruneLocalBackups(kind);
    this.emit();
    return record;
  }

  async ensureDailyBackup(localDate = localDateKey(new Date())) {
    return this.createLocalBackup("daily", localDate, "每天 20:00 后自动备份");
  }

  async listLocalBackups(): Promise<LocalBackupRecord[]> {
    return this.database.localBackups.orderBy("createdAt").reverse().toArray();
  }

  private async pruneLocalBackups(kind: LocalBackupKind) {
    const records = await this.database.localBackups.where("kind").equals(kind).sortBy("createdAt");
    const remove = records.slice(0, Math.max(0, records.length - BACKUP_RETENTION[kind]));
    if (remove.length) await this.database.localBackups.bulkDelete(remove.map((record) => record.id));
  }

  async restoreLocalBackup(id: string) {
    const record = await this.database.localBackups.get(id);
    if (!record) throw new Error("找不到这份本地备份。");
    await this.createLocalBackup("safety", localDateKey(new Date()), "恢复前自动保护");
    await this.importBackup(record.backup);
    return record;
  }

  async importBackup(backup: BackupDocument) {
    if (backup?.format !== "project-one-backup" || backup.version !== 1 || !backup.data) throw new Error("This is not a valid Project One backup.");
    const currentCart = backup.data.currentCart?.length
      ? backup.data.currentCart
      : [{ id: "current" as const, items: [], updatedAt: nowIso() }];
    await this.database.transaction(
      "rw",
      [
        this.database.categories,
        this.database.suppliers,
        this.database.products,
        this.database.sales,
        this.database.saleItems,
        this.database.inventoryMovements,
        this.database.dailyTurnovers,
        this.database.currentCart,
        this.database.settings,
        this.database.syncOutbox,
        this.database.processedOperations,
        this.database.peers,
        this.database.conflicts,
      ],
      async () => {
        await Promise.all([
          this.database.categories.clear(),
          this.database.suppliers.clear(),
          this.database.products.clear(),
          this.database.sales.clear(),
          this.database.saleItems.clear(),
          this.database.inventoryMovements.clear(),
          this.database.dailyTurnovers.clear(),
          this.database.currentCart.clear(),
          this.database.settings.clear(),
          this.database.syncOutbox.clear(),
          this.database.processedOperations.clear(),
          this.database.peers.clear(),
          this.database.conflicts.clear(),
        ]);
        await Promise.all([
          this.database.categories.bulkPut(backup.data.categories ?? []),
          this.database.suppliers.bulkPut(backup.data.suppliers ?? []),
          this.database.products.bulkPut(backup.data.products ?? []),
          this.database.sales.bulkPut(backup.data.sales ?? []),
          this.database.saleItems.bulkPut(backup.data.saleItems ?? []),
          this.database.inventoryMovements.bulkPut(backup.data.inventoryMovements ?? []),
          this.database.dailyTurnovers.bulkPut(backup.data.dailyTurnovers ?? []),
          this.database.currentCart.bulkPut(currentCart),
          this.database.settings.bulkPut(backup.data.settings ?? []),
          this.database.syncOutbox.bulkPut((backup.data.outbox ?? []).map((entry) => ({ ...entry, status: "pending" as const, acknowledgedAt: undefined }))),
          this.database.processedOperations.bulkPut(backup.data.processedOperations ?? []),
          this.database.peers.bulkPut(backup.data.peers ?? []),
        ]);
      },
    );
    this.emit();
  }

  async resetBusinessData() {
    await this.database.transaction(
      "rw",
      [
        this.database.categories,
        this.database.suppliers,
        this.database.products,
        this.database.sales,
        this.database.saleItems,
        this.database.inventoryMovements,
        this.database.dailyTurnovers,
        this.database.currentCart,
        this.database.settings,
        this.database.syncOutbox,
        this.database.processedOperations,
        this.database.peers,
        this.database.conflicts,
        this.database.pairing,
      ],
      async () => {
        await Promise.all([
          this.database.categories.clear(),
          this.database.suppliers.clear(),
          this.database.products.clear(),
          this.database.sales.clear(),
          this.database.saleItems.clear(),
          this.database.inventoryMovements.clear(),
          this.database.dailyTurnovers.clear(),
          this.database.settings.clear(),
          this.database.syncOutbox.clear(),
          this.database.processedOperations.clear(),
          this.database.peers.clear(),
          this.database.conflicts.clear(),
          this.database.pairing.clear(),
        ]);
        await this.database.currentCart.put({ id: "current", items: [], updatedAt: nowIso() });
        await this.database.pairing.put({ id: "pairing", secret: randomSecret(), createdAt: nowIso() });
      },
    );
    this.emit();
  }
}

export const repository = new Repository();

export const stockByProduct = (movements: InventoryMovement[]) => {
  const result = new Map<string, number>();
  for (const movement of movements) result.set(movement.productId, (result.get(movement.productId) ?? 0) + movement.quantityDeltaPacks);
  return result;
};

export const isSameLocalDay = (iso: string, date: Date) => {
  const value = new Date(iso);
  return value.getFullYear() === date.getFullYear() && value.getMonth() === date.getMonth() && value.getDate() === date.getDate();
};

export { Dexie };
