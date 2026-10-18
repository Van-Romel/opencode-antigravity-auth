# ADR-0003: Host-Aware Fingerprinting & Windows Anti-Mismatch

## Status
Accepted

## Context
Google APIs and Cloud Code infrastructure inspect client metadata, User-Agent strings, and transport-level characteristics (`X-Goog-Api-Client`, `Client-Metadata`, TLS client hello, and TCP window characteristics).

In early versions of third-party Antigravity plugins:
1. Static header templates were often copied from macOS developer environments (e.g., hardcoded `darwin/arm64` or `Macintosh; Intel Mac OS X 10_15_7`).
2. When executed on Windows or Linux workstations, this created an **Anti-Mismatch violation**: the underlying OS TCP/IP stack and Node.js TLS cipher suite order identified as Windows (`Win64; x64`), while the HTTP headers claimed to be macOS Darwin.
3. This divergence is a textbook fingerprint heuristic used by Web Application Firewalls (WAFs) and bot detection algorithms to flag automated reverse-engineered tooling.

## Decision
We implemented host-aware dynamic platform header generation in `src/constants.ts` and `plugins/antigravity.js`:

1. **Dynamic Platform Detection (`getHostPlatformHeaders()`)**:
   - Evaluates `os.platform()` and `os.arch()` at runtime.
   - Computes matching header values for User-Agent, API client tags, and OS metadata.

2. **Windows NT 10.0 Fingerprint**:
   - `platform`: `windows/amd64` (or `windows/arm64`)
   - `User-Agent`: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36`
   - `Client-Metadata`: `{"ideType":"VSCODE","platform":"WINDOWS"}`

3. **macOS & Linux Support**:
   - `darwin/arm64` or `darwin/x64` with valid Apple Silicon / Intel Mac OS X strings on macOS.
   - `linux/amd64` or `linux/arm64` with standard X11 Linux strings on Linux distributions.

## Consequences

### Positive
- **Eliminates Anti-Mismatch Heuristics**: TCP/TLS fingerprint and HTTP headers match consistently across Windows, macOS, and Linux.
- **Universal Multi-Platform Support**: No manual configuration or toggles required when running on different operating systems.
- **Stealth and Stability**: Outgoing telemetry conforms to legitimate developer IDE usage on the host OS.

### Negative / Trade-offs
- None identified. Runtime overhead of reading `os.platform()` and `os.arch()` is negligible (<1ms during startup).
