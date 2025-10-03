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
        if (configObj && typeof configObj.validate === "function")
            await configObj.validate();
        const impl = await factory(configObj);
        const inst = { id, config: configObj, impl };
        inst.impl.id = id;
        this.instances.set(id, inst);
        return inst;
    }
    get(id) {
        const inst = this.instances.get(id);
        if (!inst)
            throw new Error(`Connector ${id} not found`);
        return inst;
    }
}
