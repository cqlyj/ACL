import { shorten, state } from "./state.js";

export const TEST_USDC_DECIMALS = 6;

export function formatTokenAmount(raw, decimals = TEST_USDC_DECIMALS) {
  if (raw === null || raw === undefined) return "—";
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return s;
  if (decimals === 0) return s;
  if (s.length <= decimals) {
    return `0.${s.padStart(decimals, "0").replace(/0+$/, "") || "0"}`;
  }
  const intPart = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac.length > 0 ? `${intPart}.${frac}` : intPart;
}

export function displayBudget(amountRaw, paymentToken) {
  const amount = formatTokenAmount(amountRaw, TEST_USDC_DECIMALS);
  const symbol =
    state.configCache?.deployment?.galileo?.testUSDC &&
    paymentToken &&
    paymentToken.toLowerCase() === state.configCache.deployment.galileo.testUSDC.toLowerCase()
      ? "testUSDC"
      : paymentToken
        ? shorten(paymentToken)
        : "";
  return `${amount} ${symbol}`.trim();
}
