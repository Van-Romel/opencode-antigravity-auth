# Architecture Decision Records (ADRs)

This directory documents the architectural and design decisions made in this fork of **OpenCode Antigravity Auth**. 

If you are extending, maintaining, or forking this project, consult these records to understand the rationale, security constraints, and anti-abuse safeguards governing its implementation.

---

## Index of Records

| ADR | Title | Status | Date |
| :--- | :--- | :--- | :--- |
| [ADR-0001](0001-opencode-v2-lifecycle-and-plugin-architecture.md) | OpenCode v2 Lifecycle & Standalone Auth CLI | Accepted | 2026-10 |
| [ADR-0002](0002-strict-quota-protocol-and-anti-shadowban.md) | Strict Quota Protocol (SQP) & Anti-Shadowban Lock | Accepted | 2026-10 |
| [ADR-0003](0003-host-aware-fingerprinting-and-windows-anti-mismatch.md) | Host-Aware Fingerprinting & Windows Anti-Mismatch | Accepted | 2026-10 |
| [ADR-0004](0004-canonical-model-naming-and-resolver-transparency.md) | Canonical Model Naming & Resolver Transparency | Accepted | 2026-10 |
| [ADR-0005](0005-zero-leak-security-and-environment-agnosticism.md) | Zero-Leak Security & Generic Environment Resolution | Accepted | 2026-10 |

---

## About ADRs

We follow the lightweight Architecture Decision Record format based on Michael Nygard's template:
- **Title**: Sequential identifier and human-readable title.
- **Status**: Proposed, Accepted, Deprecated, or Superseded.
- **Context**: The problem statement, historical context, and technical constraints.
- **Decision**: The architectural choice made and implementation details.
- **Consequences**: The positive, negative, and neutral trade-offs resulting from the decision.
