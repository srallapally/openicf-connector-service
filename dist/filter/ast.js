export const and = (...nodes) => ({ type: "AND", nodes });
export const or = (...nodes) => ({ type: "OR", nodes });
export const not = (node) => ({ type: "NOT", node });
export const cmp = (op, path, value) => ({ type: "CMP", op, path, value });
