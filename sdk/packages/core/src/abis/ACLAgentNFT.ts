/* AUTO-GENERATED. Source: out/ACLAgentNFT.sol/ACLAgentNFT.json */
export const aclAgentNFTAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "name_",
        type: "string",
        internalType: "string",
      },
      {
        name: "symbol_",
        type: "string",
        internalType: "string",
      },
      {
        name: "verifier_",
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
    name: "acceptOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "tokenId_",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "authorizeUsage",
    inputs: [
      {
        name: "_tokenId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "_user",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "authorizedUsersOf",
    inputs: [
      {
        name: "_tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address[]",
        internalType: "address[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [
      {
        name: "owner",
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
    stateMutability: "view",
  },
  {
    type: "function",
    name: "delegateAccess",
    inputs: [
      {
        name: "_assistant",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "delegateAssistants",
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
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "encryptedStorageURIs",
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
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getApproved",
    inputs: [
      {
        name: "tokenId_",
        type: "uint256",
        internalType: "uint256",
      },
    ],
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
    name: "getDelegateAccess",
    inputs: [
      {
        name: "_user",
        type: "address",
        internalType: "address",
      },
    ],
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
    name: "iClone",
    inputs: [
      {
        name: "_to",
        type: "address",
        internalType: "address",
      },
      {
        name: "_tokenId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "_proofs",
        type: "tuple[]",
        internalType: "struct TransferValidityProof[]",
        components: [
          {
            name: "accessProof",
            type: "tuple",
            internalType: "struct AccessProof",
            components: [
              {
                name: "oldDataHash",
                type: "bytes32",
                internalType: "bytes32",
              },
              {
                name: "newDataHash",
                type: "bytes32",
                internalType: "bytes32",
              },
              {
                name: "nonce",
                type: "bytes",
                internalType: "bytes",
              },
              {
                name: "encryptedPubKey",
                type: "bytes",
                internalType: "bytes",
              },
              {
                name: "proof",
                type: "bytes",
                internalType: "bytes",
              },
            ],
          },
          {
            name: "ownershipProof",
            type: "tuple",
            internalType: "struct OwnershipProof",
            components: [
              {
                name: "oracleType",
                type: "uint8",
                internalType: "enum OracleType",
              },
              {
                name: "oldDataHash",
                type: "bytes32",
                internalType: "bytes32",
              },
              {
                name: "newDataHash",
                type: "bytes32",
                internalType: "bytes32",
              },
              {
                name: "sealedKey",
                type: "bytes",
                internalType: "bytes",
              },
              {
                name: "encryptedPubKey",
                type: "bytes",
                internalType: "bytes",
              },
              {
                name: "nonce",
                type: "bytes",
                internalType: "bytes",
              },
              {
                name: "proof",
                type: "bytes",
                internalType: "bytes",
              },
            ],
          },
        ],
      },
    ],
    outputs: [
      {
        name: "_newTokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "iTransfer",
    inputs: [
      {
        name: "_to",
        type: "address",
        internalType: "address",
      },
      {
        name: "_tokenId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "_proofs",
        type: "tuple[]",
        internalType: "struct TransferValidityProof[]",
        components: [
          {
            name: "accessProof",
            type: "tuple",
            internalType: "struct AccessProof",
            components: [
              {
                name: "oldDataHash",
                type: "bytes32",
                internalType: "bytes32",
              },
              {
                name: "newDataHash",
                type: "bytes32",
                internalType: "bytes32",
              },
              {
                name: "nonce",
                type: "bytes",
                internalType: "bytes",
              },
              {
                name: "encryptedPubKey",
                type: "bytes",
                internalType: "bytes",
              },
              {
                name: "proof",
                type: "bytes",
                internalType: "bytes",
              },
            ],
          },
          {
            name: "ownershipProof",
            type: "tuple",
            internalType: "struct OwnershipProof",
            components: [
              {
                name: "oracleType",
                type: "uint8",
                internalType: "enum OracleType",
              },
              {
                name: "oldDataHash",
                type: "bytes32",
                internalType: "bytes32",
              },
              {
                name: "newDataHash",
                type: "bytes32",
                internalType: "bytes32",
              },
              {
                name: "sealedKey",
                type: "bytes",
                internalType: "bytes",
              },
              {
                name: "encryptedPubKey",
                type: "bytes",
                internalType: "bytes",
              },
              {
                name: "nonce",
                type: "bytes",
                internalType: "bytes",
              },
              {
                name: "proof",
                type: "bytes",
                internalType: "bytes",
              },
            ],
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "intelligentDataOf",
    inputs: [
      {
        name: "_tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct IntelligentData[]",
        components: [
          {
            name: "dataDescription",
            type: "string",
            internalType: "string",
          },
          {
            name: "dataHash",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isApprovedForAll",
    inputs: [
      {
        name: "owner_",
        type: "address",
        internalType: "address",
      },
      {
        name: "operator",
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
    type: "function",
    name: "mint",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "data_",
        type: "tuple[]",
        internalType: "struct IntelligentData[]",
        components: [
          {
            name: "dataDescription",
            type: "string",
            internalType: "string",
          },
          {
            name: "dataHash",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
      {
        name: "encryptedStorageURI_",
        type: "string",
        internalType: "string",
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
    name: "name",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextTokenId",
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
    name: "ownerOf",
    inputs: [
      {
        name: "tokenId_",
        type: "uint256",
        internalType: "uint256",
      },
    ],
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
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "revokeAuthorization",
    inputs: [
      {
        name: "_tokenId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "_user",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "safeTransferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "safeTransferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "data",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "sealedKeysOf",
    inputs: [
      {
        name: "_tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes[]",
        internalType: "bytes[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setApprovalForAll",
    inputs: [
      {
        name: "operator",
        type: "address",
        internalType: "address",
      },
      {
        name: "approved_",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "supportsInterface",
    inputs: [
      {
        name: "interfaceId",
        type: "bytes4",
        internalType: "bytes4",
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
    name: "symbol",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
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
    name: "update",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "newDatas",
        type: "tuple[]",
        internalType: "struct IntelligentData[]",
        components: [
          {
            name: "dataDescription",
            type: "string",
            internalType: "string",
          },
          {
            name: "dataHash",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
      {
        name: "newEncryptedStorageURI",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "verifier",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IERC7857DataVerifier",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "AgentMinted",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "encryptedStorageURI",
        type: "string",
        indexed: false,
        internalType: "string",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "approved",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "tokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ApprovalForAll",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "operator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "approved",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Authorization",
    inputs: [
      {
        name: "_from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "_to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "_tokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "AuthorizationRevoked",
    inputs: [
      {
        name: "_from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "_to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "_tokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Cloned",
    inputs: [
      {
        name: "_tokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "_newTokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "_from",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "_to",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DelegateAccess",
    inputs: [
      {
        name: "_user",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "_assistant",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "IntelligentDataUpdated",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
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
    name: "PublishedSealedKey",
    inputs: [
      {
        name: "_to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "_tokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "_sealedKeys",
        type: "bytes[]",
        indexed: false,
        internalType: "bytes[]",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      {
        name: "from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "tokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Transferred",
    inputs: [
      {
        name: "_tokenId",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "_from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "_to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AlreadyAuthorized",
    inputs: [],
  },
  {
    type: "error",
    name: "ERC721IncorrectOwner",
    inputs: [
      {
        name: "sender",
        type: "address",
        internalType: "address",
      },
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "ERC721InsufficientApproval",
    inputs: [
      {
        name: "operator",
        type: "address",
        internalType: "address",
      },
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "ERC721InvalidApprover",
    inputs: [
      {
        name: "approver",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "ERC721InvalidOperator",
    inputs: [
      {
        name: "operator",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "ERC721InvalidOwner",
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
    name: "ERC721InvalidReceiver",
    inputs: [
      {
        name: "receiver",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "ERC721InvalidSender",
    inputs: [
      {
        name: "sender",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "ERC721NonexistentToken",
    inputs: [
      {
        name: "tokenId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "EmptyIntelligentData",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidAccessAssistant",
    inputs: [],
  },
  {
    type: "error",
    name: "NotAuthorized",
    inputs: [],
  },
  {
    type: "error",
    name: "NotTokenOwnerOrApproved",
    inputs: [],
  },
  {
    type: "error",
    name: "OldDataHashMismatch",
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
    name: "ProofCountMismatch",
    inputs: [],
  },
  {
    type: "error",
    name: "TargetPubkeyMismatch",
    inputs: [],
  },
  {
    type: "error",
    name: "TokenDoesNotExist",
    inputs: [],
  },
] as const;
