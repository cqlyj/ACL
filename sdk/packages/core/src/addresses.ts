import type { Address } from "viem";

/**
 * Live testnet deployment of the ACL contracts. These are the addresses the
 * gateway and SDK consumers default to. Override per-call via the relevant
 * config object when running against a private deployment.
 */
export type AclDeployment = {
  /** Sepolia (where ENS lives). */
  ens: {
    chainId: number;
    /** ENS Registry on Sepolia. */
    registry: Address;
    /** Universal Resolver on Sepolia (latest deployment). */
    universalResolver: Address;
    /** ACLOffchainResolver — wildcard resolver for *.acl.eth. */
    aclOffchainResolver: Address;
    /** Parent ENS name owned by the project. */
    parentName: string;
  };
  /** 0G Galileo testnet, where the ACL business contracts live. */
  galileo: {
    chainId: number;
    /** Public RPC. Override per consumer if rate-limited. */
    rpcUrl: string;
    identityRegistry: Address;
    /**
     * Block at which {@link identityRegistry} was deployed. Consumers
     * that need to backfill `MetadataSet` events (e.g. the CCIP-Read
     * gateway's indexer) start scanning from this block instead of
     * genesis — the public 0G RPC is at ~30M blocks at the time of
     * writing, so a from-zero scan would take tens of minutes per
     * boot. Override per-deployment when running against a private
     * chain.
     */
    identityRegistryDeployBlock: bigint;
    reputationRegistry: Address;
    validationRegistry: Address;
    agenticCommerce: Address;
    aclEvaluator: Address;
    testUSDC: Address;
    /** ERC-7857 iNFT contract (ACLAgentNFT). */
    aclAgentNFT: Address;
    /** Trusted-party verifier bound to ACLAgentNFT. */
    trustedPartyVerifier: Address;
    /** ReputationHook (Flow 1 settlement). */
    reputationHook: Address;
    /** INFTDeliveryHook (Flow 2 settlement). */
    inftDeliveryHook: Address;
    /**
     * 0G Compute InferenceServing marketplace contract. ACLEvaluator
     * uses this to look up the registered TEE signing address per
     * provider when verifying the signature attached to a settle().
     */
    inferenceServing: Address;
  };
};

/** Default ACL testnet deployment (May 1st 2026). */
export const ACL_TESTNET: AclDeployment = {
  ens: {
    chainId: 11_155_111,
    registry: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
    universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
    aclOffchainResolver: "0x05B97e7E40BE8B04AE0F337C0Aefdd88eFe8fe20",
    parentName: "acl.eth",
  },
  galileo: {
    chainId: 16_602,
    rpcUrl: "https://evmrpc-testnet.0g.ai",
    identityRegistry: "0x963e7AA33A96A3eb1172F5B85c36402Dd645c4f4",
    identityRegistryDeployBlock: 30_749_328n,
    reputationRegistry: "0x47902DECbde0c63fbc6af67418b5B70f127459Cf",
    validationRegistry: "0x2DDdD6451487dcD89B48f8BE3Aa9009029d12cA1",
    agenticCommerce: "0x872C0E54035355bc179B5445E9104dfcaB827140",
    aclEvaluator: "0x5684ef7345FD14434128b2DA056332e2a7187615",
    testUSDC: "0xFa689366E2c4A257f5eEB1032adcd36FB12e63d1",
    aclAgentNFT: "0xf090Ea133b47D70f35e29368F1EE369dD3aE0Ae3",
    trustedPartyVerifier: "0x1ad28369Fb6708550e26ac0528B7266C3301dc35",
    reputationHook: "0x464d73b0BB6e44DB8fd9df3a584b508FF5C569c8",
    inftDeliveryHook: "0x229b54B8fD99EC9aBD71DbA4Df261344E9E8943E",
    inferenceServing: "0xa79F4c8311FF93C06b8CfB403690cc987c93F91E",
  },
};
