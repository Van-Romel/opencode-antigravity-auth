# ADR-0001: OpenCode v2 Lifecycle & Standalone Auth CLI

## Status
Accepted

## Context
In OpenCode v1, plugins could hook into the interactive terminal menu (`opencode auth login`) to present custom authentication flows directly in the terminal interface. 

Starting in OpenCode v2 (`2.0.32+`), the internal authentication subsystem was refactored:
1. `opencode auth login` strictly enumerates built-in first-party providers. Dynamic, third-party, or plugin-injected OAuth hooks no longer register in the terminal interactive menu.
2. The plugin runtime adopted an asynchronous lifecycle model: `export default { id: string, async setup(ctx) { ... } }`.
3. Relying on OpenCode's internal menu to authenticate Antigravity accounts caused confusion, as users reported that Antigravity was "missing" from `opencode auth login`.

## Decision
We decoupled authentication from OpenCode's internal terminal UI while fully adopting OpenCode v2's native plugin architecture:

1. **Native OpenCode v2 Lifecycle Export**:
   - Implemented `plugins/antigravity.js` exporting `{ id: "antigravity", async setup(ctx) { ... } }`.
   - The plugin hooks into `globalThis.fetch` during `setup()`, intercepting Google generative AI calls, attaching Antigravity tokens, injecting appropriate platform headers, and applying rate-limiting/recovery logic transparently.

2. **Standalone Multi-Account Auth CLI (`bin/auth-cli.mjs`)**:
   - Created a standalone CLI utility accessible via `node bin/auth-cli.mjs login` and `node bin/auth-cli.mjs list`.
   - Spawns a local loopback HTTP server on `http://localhost:51121/callback` using PKCE and OAuth 2.0 to capture Google authentication tokens via the user's default browser.
   - Persists credentials securely to `~/.config/opencode/antigravity-accounts.json`.

## Consequences

### Positive
- **Full OpenCode v2 Compatibility**: Works seamlessly with OpenCode v2 without requiring upstream changes to the OpenCode core repository.
- **Zero Confusion**: Eliminates dependency on `opencode auth login`. Users authenticate directly via browser with `node bin/auth-cli.mjs login`.
- **Backward Compatibility**: Maintains compatibility with OpenCode v1 environments and existing token file structures.

### Negative / Trade-offs
- Authentication requires running a separate CLI command (`node bin/auth-cli.mjs login`) once rather than selecting an option in `opencode auth login`.
