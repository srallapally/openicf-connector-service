export type Op = "EQ" | "CONTAINS" | "STARTS_WITH" | "ENDS_WITH" | "GT" | "GTE" | "LT" | "LTE" | "IN" | "EXISTS";
export type Path = string[];
export type Node = {
    type: "CMP";
    op: Op;
    path: Path;
    value?: string | number | boolean | Array<string | number> | undefined;
} | {
    type: "AND";
    nodes: Node[];
} | {
    type: "OR";
    nodes: Node[];
} | {
    type: "NOT";
    node: Node;
};
export declare const and: (...nodes: Node[]) => Node;
export declare const or: (...nodes: Node[]) => Node;
export declare const not: (node: Node) => Node;
export declare const cmp: (op: Op, path: Path, value?: any) => Node;
//# sourceMappingURL=ast.d.ts.map