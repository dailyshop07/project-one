import { afterEach, describe, expect, it, vi } from "vitest";
import { roomIdFromSecret } from "./identity";

describe("room id derivation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps deterministic room ids available on insecure local previews", async () => {
    vi.stubGlobal("crypto", {});
    await expect(roomIdFromSecret("example-secret")).resolves.toBe("IaD8gvKXEEjPbXGtOl2gCz3QQp0lQdaWDbjfQrFZNFo");
  });
});
