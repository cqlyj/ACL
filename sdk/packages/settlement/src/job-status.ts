/**
 * Numeric values of the on-chain `AgenticCommerce.JobStatus` enum,
 * exposed as a typed `as const` map so off-chain consumers don't have
 * to redeclare them inline.
 *
 * Ordered to match the Solidity enum:
 *
 * ```solidity
 * enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }
 * ```
 *
 * Use the named keys (`JOB_STATUS.Funded`, `JOB_STATUS.Submitted`, …)
 * instead of bare integer literals at every status comparison site so
 * a future reorder of the on-chain enum is a single-file change here.
 */
export const JOB_STATUS = {
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5,
} as const;

export type JobStatusName = keyof typeof JOB_STATUS;
export type JobStatusValue = (typeof JOB_STATUS)[JobStatusName];
