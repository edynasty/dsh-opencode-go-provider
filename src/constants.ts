/** Shared grace-period constant, free of module cycles. */

/** Exact grace boundary: entries are evicted strictly after 14 days. */
export const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
