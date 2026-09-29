import Dexie, { type EntityTable } from "dexie";
import type {
  Category,
  ConflictRecord,
  CurrentCart,
  DailyTurnover,
  DeviceRecord,
  InventoryMovement,
  OutboxEntry,
  PairingRecord,
  PeerRecord,
  ProcessedOperation,
  Product,
  Sale,
  SaleItem,
  SettingRecord,
  Supplier,
  LocalBackupRecord,
} from "../types";

export class ProjectOneDatabase extends Dexie {
  categories!: EntityTable<Category, "id">;
  suppliers!: EntityTable<Supplier, "id">;
  products!: EntityTable<Product, "id">;
  sales!: EntityTable<Sale, "id">;
  saleItems!: EntityTable<SaleItem, "id">;
  inventoryMovements!: EntityTable<InventoryMovement, "id">;
  dailyTurnovers!: EntityTable<DailyTurnover, "id">;
  currentCart!: EntityTable<CurrentCart, "id">;
  settings!: EntityTable<SettingRecord, "key">;
  devices!: EntityTable<DeviceRecord, "id">;
  pairing!: EntityTable<PairingRecord, "id">;
  syncOutbox!: EntityTable<OutboxEntry, "operationId">;
  processedOperations!: EntityTable<ProcessedOperation, "operationId">;
  peers!: EntityTable<PeerRecord, "deviceId">;
  conflicts!: EntityTable<ConflictRecord, "id">;
  localBackups!: EntityTable<LocalBackupRecord, "id">;

  constructor(name = "ProjectOne") {
    super(name);
    this.version(1).stores({
      categories: "id, name, sortOrder, updatedAt, deviceId, deletedAt",
      products: "id, categoryId, name, sortOrder, active, updatedAt, deviceId, deletedAt",
      sales: "id, completedAt, updatedAt, deviceId, voidedAt, deletedAt",
      saleItems: "id, saleId, productId",
      inventoryMovements: "id, &operationId, productId, occurredAt, relatedSaleId, deviceId",
      currentCart: "id, updatedAt",
      settings: "key",
      devices: "id, &deviceId",
      pairing: "id",
      syncOutbox: "&operationId, status, createdAt, deviceId, [status+createdAt]",
      processedOperations: "&operationId, processedAt, sourceDeviceId",
      peers: "&deviceId, lastSeenAt",
      conflicts: "id, entityType, entityId, recordedAt",
    });
    this.version(2).stores({
      suppliers: "id, name, updatedAt, deviceId, deletedAt",
    });
    this.version(3).stores({
    localBackups: "id, kind, localDate, createdAt",
    });
    this.version(4).stores({
      dailyTurnovers: "id, businessDate, updatedAt, deviceId",
    });
  }
}

export const db = new ProjectOneDatabase();
