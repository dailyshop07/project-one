export type UnitType = "pack" | "carton";
export type ProductKind = "cigarette" | "vape" | "tobacco";

export const BUILTIN_CATEGORIES: ReadonlyArray<{ id: string; name: string; kind: ProductKind; sortOrder: number; baseUnitLabel: string; bundleUnitLabel: string }> = [
  { id: "builtin-cigarette", name: "香烟", kind: "cigarette", sortOrder: 0, baseUnitLabel: "包", bundleUnitLabel: "条" },
  { id: "builtin-vape", name: "电子烟", kind: "vape", sortOrder: 1, baseUnitLabel: "支", bundleUnitLabel: "支" },
  { id: "builtin-tobacco", name: "烟丝", kind: "tobacco", sortOrder: 2, baseUnitLabel: "件", bundleUnitLabel: "件" },
];

export interface SyncFields {
  id: string;
  createdAt: string;
  updatedAt: string;
  deviceId: string;
  version: number;
  deletedAt?: string;
}

export interface Category extends SyncFields {
  name: string;
  sortOrder: number;
  active: boolean;
  kind?: ProductKind;
  baseUnitLabel?: string;
  bundleUnitLabel?: string;
  unitsPerBundle?: number;
}

export interface Supplier extends SyncFields {
  name: string;
}

export interface Product extends SyncFields {
  name: string;
  categoryId: string;
  categoryKind?: ProductKind;
  baseUnitLabel?: string;
  bundleUnitLabel?: string;
  unitWeightGrams?: number;
  packSalePriceCents: number;
  cartonSalePriceCents: number;
  packCostCents: number;
  cartonCostCents?: number;
  packsPerCarton: number;
  lowStockThresholdPacks: number;
  active: boolean;
  sortOrder: number;
}

export interface CartItem {
  productId: string;
  unitType: UnitType;
  quantity: number;
  /** Optional negotiated unit price for this customer's current cart, in cents. */
  unitPriceCents?: number;
}

export interface CurrentCart {
  id: "current";
  items: CartItem[];
  totalOverrideCents?: number;
  updatedAt: string;
}

export interface SaleItem extends SyncFields {
  id: string;
  saleId: string;
  productId: string;
  productNameSnapshot: string;
  unitType: UnitType;
  unitLabelSnapshot?: string;
  quantity: number;
  unitsInPacks: number;
  unitSalePriceCents: number;
  unitCostCents: number;
  lineRevenueCents: number;
  lineCostCents: number;
  lineProfitCents: number;
}

export interface Sale extends SyncFields {
  completedAt: string;
  deviceLabelSnapshot?: string;
  revenueCents: number;
  costCents: number;
  profitCents: number;
  itemCount: number;
  voidedAt?: string;
  voidedByDeviceId?: string;
}

export interface DailyTurnover extends SyncFields {
  businessDate: string;
  cashCents: number;
  posCents: number;
  lotteryPayoutCents: number;
  note?: string;
}

export type InventoryMovementReason =
  | "opening"
  | "restock"
  | "sale"
  | "manualAdjustment"
  | "stocktake"
  | "saleVoid";

export interface InventoryMovement extends SyncFields {
  operationId: string;
  productId: string;
  quantityDeltaPacks: number;
  reason: InventoryMovementReason;
  supplierId?: string;
  supplierNameSnapshot?: string;
  relatedSaleId?: string;
  note?: string;
  occurredAt: string;
  totalCostCents?: number;
  /** Signed change in the inventory carrying value for this movement. */
  costValueDeltaCents?: number;
  /** Cost per base inventory unit at the time of this movement. */
  unitCostCents?: number;
}

export type SyncEntityType = "category" | "product" | "supplier" | "sale" | "saleItem" | "inventoryMovement" | "dailyTurnover";

export interface SyncOperation {
  operationId: string;
  /** Globally unique durable-sync event id. Older local records use operationId as a fallback. */
  eventId?: string;
  entityType: SyncEntityType;
  entityId: string;
  action: "upsert" | "tombstone";
  payload: Category | Product | Supplier | Sale | SaleItem | InventoryMovement | DailyTurnover;
  createdAt: string;
  deviceId: string;
  entityVersion: number;
}

export interface OutboxEntry extends SyncOperation {
  status: "pending" | "sending" | "acknowledged";
  attempts: number;
  lastAttemptAt?: string;
  acknowledgedAt?: string;
}

export interface ProcessedOperation {
  operationId: string;
  eventId?: string;
  processedAt: string;
  sourceDeviceId: string;
}

export interface StoredSyncEvent {
  sequence: number;
  eventId: string;
  senderDeviceId: string;
  createdAt: string;
  encrypted: boolean;
  payload: string;
}

export interface AppliedSyncEvent {
  sequence: number;
  eventId: string;
  operation: SyncOperation;
}

export interface DeviceRecord {
  id: "local";
  deviceId: string;
  createdAt: string;
  label: string;
}

export interface PairingRecord {
  id: "pairing";
  secret: string;
  createdAt: string;
}

export interface PeerRecord {
  deviceId: string;
  label: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSyncedAt?: string;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface ConflictRecord {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  localVersion: number;
  incomingVersion: number;
  winningDeviceId: string;
  recordedAt: string;
}

export interface BackupDocument {
  format: "project-one-backup";
  version: 1;
  exportedAt: string;
  data: {
    categories: Category[];
    suppliers: Supplier[];
    products: Product[];
    sales: Sale[];
    saleItems: SaleItem[];
    inventoryMovements: InventoryMovement[];
    dailyTurnovers?: DailyTurnover[];
    currentCart: CurrentCart[];
    settings: SettingRecord[];
    outbox: OutboxEntry[];
    processedOperations: ProcessedOperation[];
    peers: PeerRecord[];
  };
}

export type LocalBackupKind = "daily" | "manual" | "safety";

export interface LocalBackupRecord {
  id: string;
  kind: LocalBackupKind;
  localDate: string;
  createdAt: string;
  label?: string;
  backup: BackupDocument;
}

export interface AppSnapshot {
  categories: Category[];
  suppliers: Supplier[];
  products: Product[];
  sales: Sale[];
  saleItems: SaleItem[];
  inventoryMovements: InventoryMovement[];
  dailyTurnovers: DailyTurnover[];
  cart: CurrentCart;
  device: DeviceRecord;
  pairing: PairingRecord;
  peers: PeerRecord[];
  settings: SettingRecord[];
  pendingCount: number;
  conflictCount: number;
}

export interface DashboardMetrics {
  revenueCents: number;
  profitCents: number;
  customerCount: number;
  packsSold: number;
  cartonsSold: number;
}
