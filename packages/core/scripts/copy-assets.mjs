// Copy non-TypeScript build assets into dist.
//
// tsc only emits what it compiles, so schema.sql would otherwise never reach
// the published package and OPERATIONS_SCHEMA_PATH would resolve to a file
// that does not exist.
import { cp, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const ASSETS = [["src/ops/schema.sql", "dist/ops/schema.sql"]];

for (const [from, to] of ASSETS) {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
}
