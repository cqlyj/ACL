/**
 * Pre-parsed `AgenticCommerce` lifecycle events. Defined once at module
 * scope so both `JobOrchestrator` (writers) and `watchJobLifecycle`
 * (readers) decode against the same `parseAbiItem` output. Extracting
 * here also keeps each event signature spelled exactly once — a typo
 * in any of these would silently miss the event everywhere.
 */
import { type AbiEvent, parseAbiItem } from "viem";

export const JOB_CREATED_EVENT = parseAbiItem(
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
);

export const PROVIDER_SET_EVENT = parseAbiItem(
  "event ProviderSet(uint256 indexed jobId, address indexed provider)",
);

export const BUDGET_SET_EVENT = parseAbiItem(
  "event BudgetSet(uint256 indexed jobId, uint256 amount)",
);

export const JOB_FUNDED_EVENT = parseAbiItem(
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)",
);

export const JOB_SUBMITTED_EVENT = parseAbiItem(
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
);

export const JOB_COMPLETED_EVENT = parseAbiItem(
  "event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)",
);

export const JOB_REJECTED_EVENT = parseAbiItem(
  "event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason)",
);

export const JOB_EXPIRED_EVENT = parseAbiItem("event JobExpired(uint256 indexed jobId)");

/**
 * Lifecycle order used by `watchJobLifecycle` when stitching events
 * back into chronological order across multiple `eth_getLogs` calls.
 */
export const ORDERED_LIFECYCLE_EVENTS: ReadonlyArray<AbiEvent> = [
  JOB_CREATED_EVENT,
  PROVIDER_SET_EVENT,
  BUDGET_SET_EVENT,
  JOB_FUNDED_EVENT,
  JOB_SUBMITTED_EVENT,
  JOB_COMPLETED_EVENT,
  JOB_REJECTED_EVENT,
  JOB_EXPIRED_EVENT,
];
