import type { Node } from "./ast.js";
export type ColumnMap = Record<string, string>;
export declare function toSql(node: Node, map: ColumnMap, startIndex?: number): {
    sql: string;
    params: any[];
    next: number;
};
//# sourceMappingURL=sql.d.ts.map