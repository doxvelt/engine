# Retired TypeScript persistence reference

Production persistence and archive validation live in `api/src/storage` and
`api/src/archive`. These adapters remain only for reference and interoperability
tests; the maintained CLI, API and DSH plugin do not load them.

Do not extend these adapters for new product behavior. The native dependency
boundary audit rejects importing them from maintained runtime entry points.
