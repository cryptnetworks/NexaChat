# ADR 0001: application language and runtime

- Status: accepted
- Date: 2026-07-17

## Context

The project needs real-time text, later WebRTC media, web and Tauri clients, and an installation path manageable by a small team. A modular monolith should preserve extraction boundaries without introducing distributed operations prematurely.

## Options

| Criterion                  | TypeScript throughout                                                    | TypeScript clients, Rust backend                          | TypeScript clients, Elixir backend                        |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------- |
| Real-time communication    | Mature WebSocket ecosystem; one runtime is straightforward               | Capable, with more explicit concurrency design            | Excellent process and supervision model                   |
| WebRTC integration         | Strong browser and Node/SFU SDK availability                             | Good native libraries; bindings can add friction          | Signaling is strong; media typically remains external     |
| Cross-platform development | Shared language and contracts across web, server, and Tauri shell        | Tauri alignment is strong, but two languages              | Two languages and build ecosystems                        |
| Self-hosting complexity    | Familiar single application runtime                                      | Native artifacts can be efficient but target-specific     | BEAM release adds a distinct runtime model                |
| Contributor accessibility  | Broadest likely contributor pool                                         | Higher ownership and memory-model learning curve          | Smaller specialist pool                                   |
| Performance                | Adequate for control plane and text workloads; profile before extraction | Strong latency and resource efficiency                    | Strong concurrency and fault isolation                    |
| Operational burden         | Lowest initial burden                                                    | Cross-compilation and native diagnostics add work         | BEAM operations are mature but specialized                |
| Long-term maintainability  | Shared schemas reduce drift; discipline required at boundaries           | Strong correctness properties; language boundary persists | Excellent real-time semantics; language boundary persists |

## Decision

Use TypeScript throughout for the initial modular monolith. Use React for the web client and a Node.js structured HTTP service. Keep media behind a provider interface and use an SFU rather than implementing media forwarding in the application server.

This choice favors delivery speed, shared contracts, and contributor accessibility over Rust's resource efficiency and Elixir's native concurrency model. High-load event fan-out, search, and media orchestration may be extracted after measurement. A later service may use another language when an ADR documents a demonstrated need and ownership plan.

## Dependency direction

Applications may depend on contracts and domain packages. Contracts contain schemas and serializable types. The domain contains business rules and ports, and must not depend on HTTP, databases, UI frameworks, or infrastructure adapters. Infrastructure adapters depend inward on domain ports.
