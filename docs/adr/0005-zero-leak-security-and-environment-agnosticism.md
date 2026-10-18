# ADR-0005: Zero-Leak Security & Generic Environment Resolution

## Status
Accepted

## Context
When maintaining or distributing public forks of authentication utilities:
1. Hardcoded developer credentials, personal API keys (`AIzaSy*`, `AQ.*`), email addresses, and absolute workstation paths (`C:\Users\<username>`) represent critical security vulnerabilities and privacy leaks.
2. If code relies on personal workstation paths or unique environment variable names specific to one developer's machine, the fork becomes brittle and unusable for other developers who clone the repository.
3. Tests that interact with real configuration files or real Windows Registry keys risk reading private tokens into test logs or corrupting developer environments.

## Decision
We implemented a strict **Zero-Leak Security Architecture** across all components:

1. **Generic & Standards-Compliant Environment Resolution**:
   - The plugin resolves industry-standard environment variable names:
     - OAuth Tokens: `ANTIGRAVITY_REFRESH_TOKEN`, `OPENCODE_ANTIGRAVITY_TOKEN`
     - Gemini API Keys: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENCODE_GEMINI_KEY`
   - Aliases are evaluated generically without requiring specific naming conventions on end-user machines.

2. **Dynamic Filesystem Resolution**:
   - Hardcoded paths are strictly prohibited. All configuration directories are resolved at runtime via `os.homedir()`:
     ```javascript
     const configDir = path.join(os.homedir(), '.config', 'opencode');
     ```

3. **Hermetic In-Memory Automated Testing**:
   - The test suite (`test/suite.mjs`) operates exclusively on in-memory mock objects.
   - It never reads or writes to real user token files (`antigravity-accounts.json`), real Windows Registry hives, or external network services.
   - Continuous integration and local tests run in 100% isolated sandbox environments.

4. **Strict Repository Hygiene**:
   - Comprehensive `.gitignore` covering:
     - `antigravity-accounts.json`, `antigravity-accounts.json.backup`
     - `.dev-local/` (local developer notes, backlogs, scratchpad files)
     - `.env`, `.env.*`
     - Disk-based cache files (`.signature-cache/`, `.quota-cache.json`)
   - Pre-commit audits verifying zero occurrences of credential prefixes (`AIzaSy`, `AQ.`) and private path fragments in git history.

5. **Canonical Git Attribution**:
   - Repository commits are authored under the canonical contributor identity `Antigravity <antigravity@deepmind.google.com>` to ensure no personal developer metadata is exposed in public commit logs.

## Consequences

### Positive
- **Guaranteed Privacy**: Zero risk of personal credentials, tokens, or private paths leaking into public GitHub repositories.
- **Universal Portability**: Anyone can clone and run the repository on Windows, macOS, or Linux without path modifications.
- **CI/CD Readiness**: Automated test suite passes deterministically in any environment with zero external dependencies.

### Negative / Trade-offs
- None.
