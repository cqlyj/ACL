/* AUTO-GENERATED. Source: out/AgenticCommerce.sol/AgenticCommerce.json */
export const agenticCommerceAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "paymentToken_",
        type: "address",
        internalType: "address",
      },
      {
        name: "treasury_",
        type: "address",
        internalType: "address",
      },
      {
        name: "owner_",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "HOOK_GAS_LIMIT",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "acceptOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimRefund",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "complete",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "reason",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "optParams",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "createJob",
    inputs: [
      {
        name: "provider",
        type: "address",
        internalType: "address",
      },
      {
        name: "evaluator",
        type: "address",
        internalType: "address",
      },
      {
        name: "expiredAt",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "description",
        type: "string",
        internalType: "string",
      },
      {
        name: "hook",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "evaluatorFeeBps",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "fund",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "expectedBudget",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "optParams",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getJob",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct AgenticCommerce.Job",
        components: [
          {
            name: "id",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "client",
            type: "address",
            internalType: "address",
          },
          {
            name: "provider",
            type: "address",
            internalType: "address",
          },
          {
            name: "evaluator",
            type: "address",
            internalType: "address",
          },
          {
            name: "description",
            type: "string",
            internalType: "string",
          },
          {
            name: "budget",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "expiredAt",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "status",
            type: "uint8",
            internalType: "enum AgenticCommerce.JobStatus",
          },
          {
            name: "hook",
            type: "address",
            internalType: "address",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "jobCounter",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "jobHasBudget",
    inputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "paymentToken",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IERC20",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pendingOwner",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "platformFeeBps",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "platformTreasury",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "reject",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "reason",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "optParams",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setBudget",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "optParams",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setEvaluatorFee",
    inputs: [
      {
        name: "feeBps_",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setHookWhitelist",
    inputs: [
      {
        name: "hook",
        type: "address",
        internalType: "address",
      },
      {
        name: "status",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setPlatformFee",
    inputs: [
      {
        name: "feeBps_",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "treasury_",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setProvider",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "provider_",
        type: "address",
        internalType: "address",
      },
      {
        name: "optParams",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "submit",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "deliverable",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "optParams",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [
      {
        name: "newOwner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "whitelistedHooks",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "BudgetSet",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "EvaluatorFeePaid",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "evaluator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "HookWhitelistUpdated",
    inputs: [
      {
        name: "hook",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "status",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobCompleted",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "evaluator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "reason",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobCreated",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "client",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "provider",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "evaluator",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "expiredAt",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "hook",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobExpired",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobFunded",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "client",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobRejected",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "rejector",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "reason",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobSubmitted",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "provider",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "deliverable",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipTransferStarted",
    inputs: [
      {
        name: "previousOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      {
        name: "previousOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PaymentReleased",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "provider",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ProviderSet",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "provider",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "client",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "BudgetMismatch",
    inputs: [],
  },
  {
    type: "error",
    name: "ExpiryTooShort",
    inputs: [],
  },
  {
    type: "error",
    name: "FeesTooHigh",
    inputs: [],
  },
  {
    type: "error",
    name: "HookInterfaceUnsupported",
    inputs: [],
  },
  {
    type: "error",
    name: "HookNotWhitelisted",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidJob",
    inputs: [],
  },
  {
    type: "error",
    name: "NotExpired",
    inputs: [],
  },
  {
    type: "error",
    name: "OwnableInvalidOwner",
    inputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "ProviderAlreadySet",
    inputs: [],
  },
  {
    type: "error",
    name: "ProviderNotSet",
    inputs: [],
  },
  {
    type: "error",
    name: "ReentrancyGuardReentrantCall",
    inputs: [],
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "Unauthorized",
    inputs: [],
  },
  {
    type: "error",
    name: "WrongStatus",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroBudget",
    inputs: [],
  },
] as const;
