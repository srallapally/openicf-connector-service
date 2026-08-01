// src/testing/index.ts
//
// Test doubles the framework ships for connector authors and for services
// embedding it. ICF's test-common is the precedent: the people writing
// connectors need a credible target to write them against, and every one of
// them reinventing a fake is worse than shipping one.
//
// Reachable as `@governance-connector-framework/core/testing`.
//
// `clock` is deliberately NOT re-exported here. It imports vitest, and a
// barrel export loads it eagerly -- which made `makeFakeConnector` unusable
// from any process that is not a vitest worker, including the soak script this
// subpath exists to serve (BUG-6). Import it from
// `@governance-connector-framework/core/testing/clock` instead, which only a
// test running under vitest will ever do.

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


export type { FakeClock } from "./clock.js";
