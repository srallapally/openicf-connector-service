export function toSql(node, map, startIndex = 1) {
    const params = [];
    let idx = startIndex;
    const colFor = (path) => {
        const key = path.join(".");
        const col = map[key];
        if (!col)
            throw new Error(`Unsupported filter path: ${key}`);
        if (!/^"[A-Za-z0-9_]+"$/.test(col))
            throw new Error("Unsafe column mapping");
        return col;
    };
    const walk = (n) => {
        switch (n.type) {
            case "CMP": {
                const col = colFor(n.path);
                if (n.op === "EXISTS")
                    return `${col} IS NOT NULL`;
                if (n.op === "IN" && Array.isArray(n.value)) {
                    const placeholders = n.value.map(() => `$${idx++}`);
                    params.push(...n.value);
                    return `${col} = ANY(ARRAY[${placeholders.join(",")}])`;
                }
                const p = `$${idx++}`;
                let op;
                let val = n.value;
                switch (n.op) {
                    case "EQ":
                        op = "=";
                        break;
                    case "GT":
                        op = ">";
                        break;
                    case "GTE":
                        op = ">=";
                        break;
                    case "LT":
                        op = "<";
                        break;
                    case "LTE":
                        op = "<=";
                        break;
                    case "CONTAINS":
                        op = "LIKE";
                        val = `%${n.value}%`;
                        break;
                    case "STARTS_WITH":
                        op = "LIKE";
                        val = `${n.value}%`;
                        break;
                    case "ENDS_WITH":
                        op = "LIKE";
                        val = `%${n.value}`;
                        break;
                    default: throw new Error(`Unsupported op ${n.op}`);
                }
                params.push(val);
                return `${col} ${op} ${p}`;
            }
            case "AND": return `(${n.nodes.map(walk).join(" AND ")})`;
            case "OR": return `(${n.nodes.map(walk).join(" OR ")})`;
            case "NOT": return `(NOT ${walk(n.node)})`;
        }
    };
    return { sql: walk(node), params, next: idx };
}
