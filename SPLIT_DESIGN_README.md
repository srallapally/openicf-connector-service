# OpenICF Connector Service - Split Architecture Design Package

This directory contains comprehensive design documentation for splitting the openicf-connector-service monolith into two independent packages.

## 📚 Documentation Index

### 1. **DESIGN_SPLIT_ARCHITECTURE.md** - Main Design Document
   - **Purpose**: Comprehensive architectural design
   - **Contents**:
     - Executive summary and goals
     - Current vs proposed architecture
     - Package structure and API surface
     - Dependencies and configuration
     - Migration path (4-week timeline)
     - Benefits and trade-offs
   - **Read this if**: You need to understand the overall architecture

### 2. **IMPLEMENTATION_PLAN.md** - Step-by-Step Guide
   - **Purpose**: Detailed implementation instructions
   - **Contents**:
     - Phase-by-phase implementation steps
     - Package configuration files
     - Code migration procedures
     - Build and test setup
     - Verification checklist
     - Troubleshooting guide
   - **Read this if**: You're implementing the split

### 3. **ARCHITECTURE_VISUAL.md** - Visual Guide
   - **Purpose**: Diagrams and visual comparisons
   - **Contents**:
     - Before/after architecture diagrams
     - File migration map
     - Data flow diagrams
     - Package dependency graph
     - Use case scenarios
     - Performance comparison matrix
   - **Read this if**: You learn best with visual aids

### 4. **QUICK_REFERENCE.md** - Developer Cheat Sheet
   - **Purpose**: Quick lookup for common tasks
   - **Contents**:
     - Installation commands
     - Usage examples
     - Common patterns
     - Environment variables
     - Troubleshooting tips
     - Migration checklist
   - **Read this if**: You need quick answers

## 🎯 Design Overview

### The Problem

The current openicf-connector-service is a monolithic application that:
- ❌ Requires a server for all connector operations
- ❌ Cannot be used for local/in-process connector invocation
- ❌ Tightly couples core logic with transport implementations
- ❌ Makes it difficult to add new transports

### The Solution

Split into two packages:

#### 1. **@openicf/connector-core** - Core Library
```typescript
import { ConnectorRegistry, ConnectorFacade } from '@openicf/connector-core';

const registry = new ConnectorRegistry();
// Register and use connectors locally (no server needed)
const facade = new ConnectorFacade(registry.get('my-connector').impl);
await facade.search('account', null);
```

**Use cases**:
- Embedded applications
- Local testing
- Transaction support (same process)
- Low latency requirements

#### 2. **@openicf/connector-websocket** - WebSocket Server
```bash
export REMOTE_CONNECTOR_WS_URL=wss://control-plane.example.com/ws
export OAUTH_CLIENT_ID=client-id
export OAUTH_CLIENT_SECRET=secret
npx openicf-websocket --connectors /path/to/connectors
```

**Use cases**:
- Multi-tenant SaaS platforms
- Centralized connector management
- Remote connector invocation
- Distributed systems

## 📊 Key Benefits

| Aspect | Current | After Split |
|--------|---------|-------------|
| **Local Use** | ❌ Not possible | ✅ Direct import |
| **Remote Use** | ✅ HTTP/WebSocket | ✅ WebSocket |
| **Dependencies** | 20+ packages | 2 (core) / 5+ (websocket) |
| **Network Overhead** | Always | Only when needed |
| **Test Complexity** | Mock network | Direct calls |
| **Deployment** | Server always | Embed or server |

## 🚀 Quick Start

### For Core Library Users

```bash
# Install
npm install @openicf/connector-core

# Use
import { ConnectorRegistry, ConnectorFacade } from '@openicf/connector-core';
```

### For WebSocket Server Users

```bash
# Install
npm install @openicf/connector-websocket

# Run
npx openicf-websocket
```

## 📅 Implementation Timeline

- **Week 1**: Package setup, code migration, build configuration
- **Week 2**: API refinement, testing, integration tests
- **Week 3**: Documentation, examples, migration guide
- **Week 4+**: Publishing, deprecation, consumer migration

## 🏗️ Package Structure

```
packages/
├── core/                   # @openicf/connector-core
│   ├── src/
│   │   ├── registry/       # ConnectorRegistry, ConnectorFacade
│   │   ├── infrastructure/ # CircuitBreaker, Cache, RateLimiter, Pool
│   │   ├── spi/            # Types, interfaces, schema
│   │   ├── filter/         # Filter parsing & SQL conversion
│   │   └── loader/         # External connector loading
│   └── package.json
│
└── websocket/              # @openicf/connector-websocket
    ├── src/
    │   ├── server/         # RemoteConnectorService, OAuthTokenProvider
    │   └── security/       # JWT, CSRF, hardening
    └── package.json
```

## 🎓 Learning Path

### For Architects
1. Read: `DESIGN_SPLIT_ARCHITECTURE.md`
2. Review: `ARCHITECTURE_VISUAL.md` (diagrams)
3. Consider: Use cases and deployment scenarios

### For Developers
1. Start: `QUICK_REFERENCE.md` (examples)
2. Implement: `IMPLEMENTATION_PLAN.md` (step-by-step)
3. Troubleshoot: Check troubleshooting sections

### For Managers
1. Review: Executive summary in `DESIGN_SPLIT_ARCHITECTURE.md`
2. Timeline: 4-week implementation plan
3. Benefits: Cost/performance comparison matrices

## 🔍 Key Design Decisions

### 1. Workspace Structure
- **Decision**: Use npm workspaces monorepo
- **Rationale**: Single repository, independent versioning, shared dependencies

### 2. Package Naming
- **Decision**: `@openicf/connector-core` and `@openicf/connector-websocket`
- **Rationale**: Clear scope namespace, extensible for future packages

### 3. Core Library Scope
- **Decision**: Include infrastructure (CircuitBreaker, Cache, etc.)
- **Rationale**: Production-ready out of the box, no need for additional libraries

### 4. WebSocket as Separate Package
- **Decision**: Standalone websocket package, not in core
- **Rationale**: Different dependencies, different security model, optional for core users

### 5. HTTP Server (Future)
- **Decision**: Create separate `@openicf/connector-http` package
- **Rationale**: Same pattern as websocket, users can choose transport

## 📈 Success Criteria

- [x] Design document completed
- [ ] Core library can be used independently
- [ ] WebSocket server uses core library successfully
- [ ] All existing tests pass
- [ ] New packages have >90% test coverage
- [ ] Documentation is complete
- [ ] Migration guide provided
- [ ] No performance regression

## 🛠️ Next Steps

1. **Review** these design documents with stakeholders
2. **Approve** the architectural approach
3. **Implement** following `IMPLEMENTATION_PLAN.md`
4. **Test** thoroughly before migration
5. **Deploy** incrementally with backward compatibility
6. **Migrate** consumers gradually
7. **Deprecate** old structure

## 📞 Support

- **Questions**: Review `QUICK_REFERENCE.md` first
- **Issues**: Check troubleshooting sections
- **Feedback**: Update design documents as needed

## 📄 License

Same as main project.

---

## Document Versions

- **v1.0** (2025-11-10): Initial design package
  - Created comprehensive design documentation
  - Defined package structure and API surface
  - Outlined migration path
  - Provided visual diagrams and examples

## Contributors

- Design: Claude AI Assistant
- Review: [Add reviewers here]
- Approval: [Add approvers here]

---

**Ready to proceed?** Start with `IMPLEMENTATION_PLAN.md` for step-by-step instructions!
