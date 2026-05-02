/* AUTO-GENERATED. Source: out/ACLValidationRegistry.sol/ACLValidationRegistry.json */
export const aclValidationRegistryAbi = [
  {
    type: "function",
    name: "getAgentValidations",
    inputs: [
      {
        name: "agentId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getIdentityRegistry",
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
    name: "getSummary",
    inputs: [
      {
        name: "agentId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "validatorAddresses",
        type: "address[]",
        internalType: "address[]",
      },
      {
        name: "tag",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [
      {
        name: "count",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "averageResponse",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getValidationStatus",
    inputs: [
      {
        name: "requestHash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "validatorAddress",
        type: "address",
        internalType: "address",
      },
      {
        name: "agentId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "response",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "responseHash",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "tag",
        type: "string",
        internalType: "string",
      },
      {
        name: "lastUpdate",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getValidatorRequests",
    inputs: [
      {
        name: "validatorAddress",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "initialize",
    inputs: [
      {
        name: "identityRegistry_",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "validationRequest",
    inputs: [
      {
        name: "validatorAddress",
        type: "address",
        internalType: "address",
      },
      {
        name: "agentId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "requestURI",
        type: "string",
        internalType: "string",
      },
      {
        name: "requestHash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "validationResponse",
    inputs: [
      {
        name: "requestHash",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "response",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "responseURI",
        type: "string",
        internalType: "string",
      },
      {
        name: "responseHash",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "tag",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "ValidationRequest",
    inputs: [
      {
        name: "validatorAddress",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "agentId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "requestURI",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "requestHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ValidationResponse",
    inputs: [
      {
        name: "validatorAddress",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "agentId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "requestHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "response",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "responseURI",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "responseHash",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "tag",
        type: "string",
        indexed: false,
        internalType: "string",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AlreadyInitialized",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidResponse",
    inputs: [],
  },
  {
    type: "error",
    name: "NotAuthorizedValidator",
    inputs: [],
  },
  {
    type: "error",
    name: "NotInitialized",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOwnerOrOperator",
    inputs: [],
  },
  {
    type: "error",
    name: "SafeCastOverflowedUintDowncast",
    inputs: [
      {
        name: "bits",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "value",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "UnknownAgent",
    inputs: [],
  },
  {
    type: "error",
    name: "UnknownRequest",
    inputs: [],
  },
] as const;
