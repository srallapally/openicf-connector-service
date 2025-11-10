import type { OperationOptions } from "../spi/types.js";
import { CircuitBreaker } from "../infra/CircuitBreaker.js";
export declare class ConnectorFacade {
    private impl;
    private breaker;
    constructor(impl: any, breaker?: CircuitBreaker);
    private invalidateCache;
    private call;
    test(): Promise<void>;
    schema(): Promise<any>;
    create(objectClass: string, attrs: Record<string, any>, options?: OperationOptions): Promise<unknown>;
    get(objectClass: string, uid: string, options?: OperationOptions): Promise<any>;
    update(objectClass: string, uid: string, attrs: Record<string, any>, options?: OperationOptions): Promise<unknown>;
    delete(objectClass: string, uid: string, options?: OperationOptions): Promise<unknown>;
    addAttributeValues(objectClass: string, uid: string, add: Record<string, any>, options?: OperationOptions): Promise<unknown>;
    removeAttributeValues(objectClass: string, uid: string, remove: Record<string, any>, options?: OperationOptions): Promise<unknown>;
    search(objectClass: string, filter: any, options?: OperationOptions): Promise<unknown>;
    sync(objectClass: string, token: any, options?: OperationOptions): Promise<unknown>;
    scriptOnConnector(ctx: {
        language: string;
        script: string;
        params?: Record<string, unknown>;
    }): Promise<unknown>;
}
//# sourceMappingURL=ConnectorFacade.d.ts.map