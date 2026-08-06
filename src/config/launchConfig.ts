// src/config/launchConfig.ts
//
// Temporary launch-mode toggle. When true:
//   - The pain-recovery/MDT track's entry points (Landing's second CTA, Dashboard's
//     assessment hero/tiles) are hidden.
//   - The Paywall shows only the 12-Week DNS Program tier.
// Nothing about DECISION_TREE, the assessment flow, or any existing paywall-gating
// logic is touched or deleted — it's all still fully reachable in code, just not
// exposed as an entry point.
//
// To restore the full two-track experience later, flip this back to false (or
// delete this file's override) — no other code changes needed.
export const DNS_ONLY_LAUNCH = true;
