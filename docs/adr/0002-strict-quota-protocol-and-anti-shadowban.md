# ADR-0002: Strict Quota Protocol (SQP) & Anti-Shadowban Lock

## Status
Accepted

## Context
Google Cloud Code Assist and Antigravity endpoints enforce rate limits and daily request quotas per authenticated Google account. 

In earlier implementations:
1. Requests continued until the remote server returned an `HTTP 429 Too Many Requests` error.
2. Under heavy workloads, repeated HTTP 429 occurrences against Google's internal endpoints risk triggering anti-scraping filters, automated telemetry flags, or silent rate-limiting ("shadowbans" where responses are delayed, degraded, or tokens revoked).
3. Hard quota exhaustion degrades user experience when mid-turn code generation fails unexpectedly.

## Decision
We implemented the **Strict Quota Protocol (SQP)** with an 80% proactive threshold:

1. **80% Proactive Threshold (`soft_quota_threshold_percent: 80`)**:
   - The plugin monitors the `remainingFraction` returned by quota inspection responses.
   - Any account with `remainingFraction <= 0.20` (i.e., 80% or more of quota consumed) is immediately marked as exhausted for that quota window.

2. **Proactive Account Rotation**:
   - When Account 1 hits the 80% soft ceiling, the plugin rotates traffic to Account 2 *before* receiving any HTTP 429 from Google.

3. **Hermetic Local Lockout**:
   - If all configured accounts exceed the 80% threshold, the plugin **blocks subsequent outgoing requests locally**.
   - No HTTP request is dispatched to Google, preventing any HTTP 429 error from being recorded on Google's edge proxies.
   - The plugin calculates and displays a local countdown to the nearest reset timestamp (e.g., `[SQP 80%] All accounts exhausted. Nearest quota reset in 4h 12m`).

## Consequences

### Positive
- **Zero HTTP 429 Exposure**: Google servers never observe quota exhaustion, eliminating the primary trigger for rate-limit flags and shadowbans.
- **Predictable Behavior**: Clear, formatted countdowns inform users when quota will replenish instead of cryptic network failure messages.
- **Safety Margin**: Retains a 20% buffer for emergency, low-volume, or single-turn completions if manually overridden.

### Negative / Trade-offs
- Users who intentionally want to consume 100% of their daily quota must adjust `soft_quota_threshold_percent` in configuration, as 20% remains reserved by default.
