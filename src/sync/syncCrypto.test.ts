import { describe, expect, it } from "vitest";
import { createSyncCipher } from "./syncCrypto";
import type { SyncOperation } from "../types";

describe("durable sync payload encryption", () => {
  it("round-trips event and checkpoint payloads without exposing the operation JSON", async () => {
    const cipher = await createSyncCipher("A".repeat(43));
    const operation: SyncOperation = {
      operationId: "event-1",
      eventId: "event-1",
      entityType: "category",
      entityId: "category-1",
      action: "upsert",
      payload: {
        id: "category-1",
        name: "Private category",
        sortOrder: 0,
        active: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deviceId: "device-a",
        version: 1,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      deviceId: "device-a",
      entityVersion: 1,
    };

    expect(cipher.available).toBe(true);
    const event = await cipher.encryptOperation("event-1", operation);
    expect(event.encrypted).toBe(true);
    expect(event.payload).not.toContain("Private category");
    await expect(cipher.decryptOperation("event-1", event.encrypted, event.payload)).resolves.toEqual(operation);

    const checkpoint = await cipher.encryptCheckpoint(12, [operation]);
    await expect(cipher.decryptCheckpoint(checkpoint)).resolves.toEqual({ baseSequence: 12, operations: [operation] });
  });
});
