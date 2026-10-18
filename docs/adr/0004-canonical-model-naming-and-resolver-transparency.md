# ADR-0004: Canonical Model Naming & Resolver Transparency

## Status
Accepted

## Context
When interacting with Google Antigravity and Cloud Code Assist endpoints, model identification occurs at two distinct layers:
1. **The Client Presentation Layer**: OpenCode configuration files (`opencode.json`), CLI arguments, and documentation.
2. **The Wire Payload Layer**: The JSON payload dispatched over HTTP to Google's backend API (`streamGenerateContent`).

During rapid model releases, developer tooling often displays specific version or checkpoint numbers (such as `gemini-3.8-flash` in Antigravity CLI banners). 

However:
- Google's Cloud Code Assist API schema strictly validates model identifier parameters and accepts canonical aliases such as `gemini-3-flash` and `gemini-3-pro`.
- Transmitting experimental or build-specific strings (e.g., `gemini-3.8-flash`) in the outbound request body risks schema rejection errors, premature breakage when Google increments internal checkpoints, and anomalous telemetry flags.

## Decision
We standardized model naming conventions and implemented transparent resolver normalization:

1. **Canonical Public Model Names**:
   - The official, documented OpenCode model identifier is **`antigravity-gemini-3-flash`** (and `antigravity-gemini-3-pro`).
   - All documentation, example configurations, and schema definitions reference this canonical identifier.

2. **Transparent Resolver Normalization (`src/plugin/transform/model-resolver.ts`)**:
   - The plugin includes automatic translation rules that normalize aliases and variant strings to their canonical API equivalents before generating request payloads:
     ```typescript
     "gemini-3.8-flash": "gemini-3-flash",
     "gemini-3.8-flash-minimal": "gemini-3-flash",
     "gemini-3.8-flash-low": "gemini-3-flash",
     "gemini-3.8-flash-medium": "gemini-3-flash",
     "gemini-3.8-flash-high": "gemini-3-flash"
     ```

## Consequences

### Positive
- **Future-Proof**: When Google updates backend checkpoints (e.g., from 3.8 to 3.9), users on `antigravity-gemini-3-flash` receive updates seamlessly without configuration changes or broken endpoints.
- **Payload Schema Conformance**: Outgoing requests strictly match Google's documented schema, preventing serialization rejections and suspicious payload signatures.
- **Backward Compatibility**: Existing scripts or configs referencing `gemini-3.8-flash` continue working transparently via the model resolver without hitting external API errors.

### Negative / Trade-offs
- None identified.
