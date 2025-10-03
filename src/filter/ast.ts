export type Op = "EQ" | "CONTAINS" | "STARTS_WITH" | "ENDS_WITH" | "GT" | "GTE" | "LT" | "LTE" | "IN" | "EXISTS";
export type Path = string[];

export type Node =
    | {
    type: "CMP";
    op: Op;
    path: Path;
    // ⬇ ADD | undefined to align with Zod .optional() + exactOptionalPropertyTypes
    value?: string | number | boolean | Array<string | number> | undefined;
}
    | { type: "AND"; nodes: Node[] }
    | { type: "OR"; nodes: Node[] }
    | { type: "NOT"; node: Node };

export const and = (...nodes: Node[]): Node => ({ type: "AND", nodes });
export const or  = (...nodes: Node[]): Node => ({ type: "OR", nodes });
export const not = (node: Node): Node => ({ type: "NOT", node });
export const cmp = (op: Op, path: Path, value?: any): Node => ({ type: "CMP", op, path, value });
