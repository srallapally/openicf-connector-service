// src/testing/index.ts
//
// Test doubles the framework ships for connector authors and for services
// embedding it. ICF's test-common is the precedent: the people writing
// connectors need a credible target to write them against, and every one of
// them reinventing a fake is worse than shipping one.
//
// Reachable as `@governance-connector-framework/core/testing`.
//
// `clock` imports vitest, which is declared as an optional peer dependency.
// Nothing in the main entry point touches it, so a consumer that never imports
// this subpath never needs vitest installed.

export {
  makeFakeConnector,
  FakeTarget,
  DEFAULT_NAME_ATTRIBUTE,
  DEFAULT_OBJECT_CLASS,
} from "./FakeConnector.js";
export type {
  FakeConnector,
  FakeConnectorOptions,
  FakeConnectorControls,
  CallRecord,
} from "./FakeConnector.js";

export { deferred, barrier, flushMicrotasks, until } from "./async.js";
export type { Deferred } from "./async.js";

export { useFakeClock, CLOCK_ORIGIN } from "./clock.js";
export type { FakeClock } from "./clock.js";
