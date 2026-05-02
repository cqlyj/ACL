import { describe, expect, test } from "bun:test";

import { JOB_STATUS } from "./job-status.js";

describe("JOB_STATUS", () => {
  test("matches the on-chain `AgenticCommerce.JobStatus` enum order", () => {
    // Solidity: enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }
    expect(JOB_STATUS.Open).toBe(0);
    expect(JOB_STATUS.Funded).toBe(1);
    expect(JOB_STATUS.Submitted).toBe(2);
    expect(JOB_STATUS.Completed).toBe(3);
    expect(JOB_STATUS.Rejected).toBe(4);
    expect(JOB_STATUS.Expired).toBe(5);
  });

  test("only carries the six expected entries", () => {
    expect(Object.keys(JOB_STATUS).sort()).toEqual([
      "Completed",
      "Expired",
      "Funded",
      "Open",
      "Rejected",
      "Submitted",
    ]);
  });
});
