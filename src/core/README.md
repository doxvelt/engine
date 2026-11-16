# Retired TypeScript reference

The authoritative engine is the Rust crate in `api/`. These modules remain as an
independent reference for behavior fixtures and cross-language interoperability
tests. The maintained CLI, API and DSH plugin do not load this implementation.

Add new simulation behavior and persistence contracts in Rust. Keep shared wire
types and output-schema constants compatible while the reference tests use them.
`scripts/check-native-boundary.mjs` checks runtime entry-point dependencies.
