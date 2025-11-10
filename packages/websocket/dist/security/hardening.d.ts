import { z } from "zod";
import type { RequestHandler } from "express";
export declare const securityMiddleware: RequestHandler[];
export declare const bodyLimit: (size?: string) => import("connect").NextHandleFunction[];
export declare const requestTimeout: RequestHandler;
export declare function sanitize(obj: unknown): unknown;
export declare const attributeValueSchema: z.ZodType<any>;
export declare const attributesRecordSchema: z.ZodRecord<z.ZodString, z.ZodType<any, z.ZodTypeDef, any>>;
export declare const createPayloadSchema: z.ZodObject<{
    attrs: z.ZodRecord<z.ZodString, z.ZodType<any, z.ZodTypeDef, any>>;
    options: z.ZodOptional<z.ZodObject<{
        attributesToGet: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        pageSize: z.ZodOptional<z.ZodNumber>;
        pagedResultsOffset: z.ZodOptional<z.ZodNumber>;
        pagedResultsCookie: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sortKeys: z.ZodOptional<z.ZodArray<z.ZodObject<{
            field: z.ZodString;
            ascending: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            field: string;
            ascending?: boolean | undefined;
        }, {
            field: string;
            ascending?: boolean | undefined;
        }>, "many">>;
        container: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            objectClass: z.ZodString;
            uid: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            objectClass: string;
            uid: string;
        }, {
            objectClass: string;
            uid: string;
        }>>>;
        scope: z.ZodOptional<z.ZodEnum<["OBJECT", "ONE_LEVEL", "SUBTREE"]>>;
        totalPagedResultsPolicy: z.ZodOptional<z.ZodEnum<["NONE", "ESTIMATE", "EXACT"]>>;
        runAsUser: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        runWithPassword: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        requireSerial: z.ZodOptional<z.ZodBoolean>;
        failOnError: z.ZodOptional<z.ZodBoolean>;
        sortBy: z.ZodOptional<z.ZodString>;
        sortOrder: z.ZodOptional<z.ZodEnum<["ASC", "DESC"]>>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    }, {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    attrs: Record<string, any>;
    options?: {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    } | undefined;
}, {
    attrs: Record<string, any>;
    options?: {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    } | undefined;
}>;
export declare const updatePayloadSchema: z.ZodObject<{
    attrs: z.ZodRecord<z.ZodString, z.ZodType<any, z.ZodTypeDef, any>>;
    options: z.ZodOptional<z.ZodObject<{
        attributesToGet: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        pageSize: z.ZodOptional<z.ZodNumber>;
        pagedResultsOffset: z.ZodOptional<z.ZodNumber>;
        pagedResultsCookie: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sortKeys: z.ZodOptional<z.ZodArray<z.ZodObject<{
            field: z.ZodString;
            ascending: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            field: string;
            ascending?: boolean | undefined;
        }, {
            field: string;
            ascending?: boolean | undefined;
        }>, "many">>;
        container: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            objectClass: z.ZodString;
            uid: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            objectClass: string;
            uid: string;
        }, {
            objectClass: string;
            uid: string;
        }>>>;
        scope: z.ZodOptional<z.ZodEnum<["OBJECT", "ONE_LEVEL", "SUBTREE"]>>;
        totalPagedResultsPolicy: z.ZodOptional<z.ZodEnum<["NONE", "ESTIMATE", "EXACT"]>>;
        runAsUser: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        runWithPassword: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        requireSerial: z.ZodOptional<z.ZodBoolean>;
        failOnError: z.ZodOptional<z.ZodBoolean>;
        sortBy: z.ZodOptional<z.ZodString>;
        sortOrder: z.ZodOptional<z.ZodEnum<["ASC", "DESC"]>>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    }, {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    attrs: Record<string, any>;
    options?: {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    } | undefined;
}, {
    attrs: Record<string, any>;
    options?: {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    } | undefined;
}>;
export declare const searchPayloadSchema: z.ZodObject<{
    filter: z.ZodAny;
    options: z.ZodOptional<z.ZodObject<{
        attributesToGet: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        pageSize: z.ZodOptional<z.ZodNumber>;
        pagedResultsOffset: z.ZodOptional<z.ZodNumber>;
        pagedResultsCookie: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sortKeys: z.ZodOptional<z.ZodArray<z.ZodObject<{
            field: z.ZodString;
            ascending: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            field: string;
            ascending?: boolean | undefined;
        }, {
            field: string;
            ascending?: boolean | undefined;
        }>, "many">>;
        container: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            objectClass: z.ZodString;
            uid: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            objectClass: string;
            uid: string;
        }, {
            objectClass: string;
            uid: string;
        }>>>;
        scope: z.ZodOptional<z.ZodEnum<["OBJECT", "ONE_LEVEL", "SUBTREE"]>>;
        totalPagedResultsPolicy: z.ZodOptional<z.ZodEnum<["NONE", "ESTIMATE", "EXACT"]>>;
        runAsUser: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        runWithPassword: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        requireSerial: z.ZodOptional<z.ZodBoolean>;
        failOnError: z.ZodOptional<z.ZodBoolean>;
        sortBy: z.ZodOptional<z.ZodString>;
        sortOrder: z.ZodOptional<z.ZodEnum<["ASC", "DESC"]>>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    }, {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    filter?: any;
    options?: {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    } | undefined;
}, {
    filter?: any;
    options?: {
        scope?: "OBJECT" | "ONE_LEVEL" | "SUBTREE" | undefined;
        attributesToGet?: string[] | undefined;
        pageSize?: number | undefined;
        pagedResultsOffset?: number | undefined;
        pagedResultsCookie?: string | null | undefined;
        sortKeys?: {
            field: string;
            ascending?: boolean | undefined;
        }[] | undefined;
        container?: {
            objectClass: string;
            uid: string;
        } | null | undefined;
        totalPagedResultsPolicy?: "NONE" | "ESTIMATE" | "EXACT" | undefined;
        runAsUser?: string | null | undefined;
        runWithPassword?: string | null | undefined;
        requireSerial?: boolean | undefined;
        failOnError?: boolean | undefined;
        sortBy?: string | undefined;
        sortOrder?: "ASC" | "DESC" | undefined;
        timeoutMs?: number | undefined;
    } | undefined;
}>;
//# sourceMappingURL=hardening.d.ts.map