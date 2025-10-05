import { describe, expect, it, vi } from "vitest";
import { ConnectorFacade } from "./ConnectorFacade.js";
import type { OperationOptions } from "../spi/types.js";

const objectClass = "user";
const uid = "123";
const options: OperationOptions = { attributesToGet: ["email", "name"] };

async function cacheHitThenInvalidate(
  facade: ConnectorFacade,
  impl: any,
  invalidate: () => Promise<void>
) {
  await facade.get(objectClass, uid, options);
  await facade.get(objectClass, uid, options);
  expect(impl.get).toHaveBeenCalledTimes(1);

  await invalidate();

  await facade.get(objectClass, uid, options);
  expect(impl.get).toHaveBeenCalledTimes(2);
}

describe("ConnectorFacade cache invalidation", () => {
  it("clears cached gets with attribute filters after create", async () => {
      const impl = {
          id: "create-cache-test",
          get: vi.fn(async () => ({ id: uid })),
          create: vi.fn(async () => ({ uid })),
      };
      const facade = new ConnectorFacade(impl);

      await cacheHitThenInvalidate(facade, impl, () => facade.create(objectClass, { name: "Alice" }));
  });

  it("clears cached gets with attribute filters after update", async () => {
      const impl = {
          id: "update-cache-test",
          get: vi.fn(async () => ({ id: uid })),
          update: vi.fn(async () => ({ uid })),
      };
      const facade = new ConnectorFacade(impl);

      await cacheHitThenInvalidate(facade, impl, () => facade.update(objectClass, uid, { name: "Bob" }));
  });

  it("clears cached gets with attribute filters after delete", async () => {
      const impl = {
          id: "delete-cache-test",
          get: vi.fn(async () => ({ id: uid })),
          delete: vi.fn(async () => undefined),
      };
      const facade = new ConnectorFacade(impl);

      await cacheHitThenInvalidate(facade, impl, () => facade.delete(objectClass, uid));
  });
});
