export class ConnectorRegistry {
    factories = new Map();
    instances = new Map();
    configBuilders = new Map();
    registerFactory(type, factory) { this.factories.set(type, factory); }
    registerConfigBuilder(type, builder) { this.configBuilders.set(type, builder); }
    async initInstance(id, type, rawConfig) {
        const factory = this.factories.get(type);
        if (!factory)
            throw new Error(`Unknown connector type ${type}`);
        const builder = this.configBuilders.get(type);
        const configObj = builder ? await builder(rawConfig) : rawConfig;
        //console.log('[connector] config', configObj);
        if (configObj && typeof configObj.validate === "function")
            await configObj.validate();
        const spi = await factory({
            logger: console,
            config: configObj,
            instanceId: id,
            connectorId: type,
            type,
        });
        this.instances.set(id, { id, config: configObj, impl: spi });
        return this.instances.get(id);
        //const impl = await factory(configObj);
        //const inst: ConnectorInstance = { id, config: configObj, impl };
        //(inst.impl as any).id = id;
        //this.instances.set(id, inst);
        //return inst;
    }
    get(id) {
        const inst = this.instances.get(id);
        if (!inst)
            throw new Error(`Connector ${id} not found`);
        return inst;
    }
    /** True if a connector with this id is loaded */
    has(id) {
        return this.instances.has(id);
    }
    /** Iterator over loaded connector ids (matches Map.keys()) */
    keys() {
        return this.instances.keys();
    }
    /** Convenience: array of loaded connector ids */
    ids() {
        return Array.from(this.instances.keys());
    }
    /** (Optional) Get the SPI facade directly if you need it */
    getSpi(id) {
        return this.instances.get(id)?.impl;
    }
    /** (Optional) List full instances if needed for debugging/inspect */
    list() {
        return Array.from(this.instances.values());
    }
}
