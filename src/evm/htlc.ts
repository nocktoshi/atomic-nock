import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { CHAIN, CHAIN_ID, tokenInfo, type TokenKey } from "../config.js";

/** Resolve the ERC20 + HTLC addresses for a swap's quote token (default USDC). */
function tokenCtx(token?: TokenKey): {
  tokenAddress: Address;
  htlcAddress: Address;
  symbol: string;
} {
  const t = tokenInfo(token);
  if (!t.htlc) {
    throw new Error(
      t.key === "WNOCK"
        ? "wNOCK HTLC not deployed — set VITE_HTLC_ADDRESS_WNOCK"
        : "Set VITE_HTLC_ADDRESS in .env at the repo root (see .env.example), then restart the dev server"
    );
  }
  return { tokenAddress: t.address, htlcAddress: t.htlc, symbol: t.symbol };
}

export const HTLC_ABI = [
  {
    name: "lock",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seller", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "hashlock", type: "bytes32" },
      { name: "timelock", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "bytes32" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "preimageJam", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "refund",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "swapId",
    type: "function",
    stateMutability: "pure",
    inputs: [
      { name: "seller", type: "address" },
      { name: "buyer", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "hashlock", type: "bytes32" },
      { name: "timelock", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "Withdrawn",
    type: "event",
    inputs: [
      { name: "swapId", type: "bytes32", indexed: true },
      { name: "seller", type: "address", indexed: true },
    ],
  },
  {
    name: "feeBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    name: "getLock",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "hashlock", type: "bytes32" },
      { name: "timelock", type: "uint256" },
      { name: "withdrawn", type: "bool" },
      { name: "refunded", type: "bool" },
    ],
  },
] as const;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function ethereum() {
  const eth = (window as Window & { ethereum?: object }).ethereum;
  if (!eth) throw new Error("No wallet (install MetaMask)");
  return eth as import("viem").EIP1193Provider;
}

export async function connectWallet(): Promise<Address> {
  const wallet = createWalletClient({
    chain: CHAIN,
    transport: custom(ethereum()),
  });
  const [address] = await wallet.requestAddresses();
  const chainId = await wallet.getChainId();
  if (chainId !== CHAIN_ID) {
    await wallet.switchChain({ id: CHAIN_ID });
  }
  return address;
}

export async function computeSwapId(
  params: {
    seller: Address;
    buyer: Address;
    amount: bigint;
    hashlock: Hex;
    timelock: bigint;
  },
  token?: TokenKey
): Promise<Hex> {
  const client = createPublicClient({
    chain: CHAIN,
    transport: custom(ethereum()),
  });
  const { htlcAddress } = tokenCtx(token);
  return client.readContract({
    address: htlcAddress,
    abi: HTLC_ABI,
    functionName: "swapId",
    args: [
      params.seller,
      params.buyer,
      params.amount,
      params.hashlock,
      params.timelock,
    ],
  });
}

export async function approveAndLock(params: {
  seller: Address;
  amountUsdc: string;
  hashlock: Hex;
  timelock: bigint;
  /** Quote token (default USDC). */
  token?: TokenKey;
}): Promise<{ swapId: Hex; lockHash: Hex; buyer: Address }> {
  const { tokenAddress, htlcAddress, symbol } = tokenCtx(params.token);
  const wallet = createWalletClient({
    chain: CHAIN,
    transport: custom(ethereum()),
  });
  const [account] = await wallet.getAddresses();
  const publicClient = createPublicClient({
    chain: CHAIN,
    transport: custom(ethereum()),
  });

  // Scale by the token's REAL decimals (Base USDC is 6, wNOCK is 16, and a mock
  // token used in a test deployment may differ — hardcoding made the amount look
  // like <0.000001 in the wallet).
  const decimals = await getTokenDecimals(params.token);
  const amountAtomic = toAtomic(params.amountUsdc, decimals);
  if (amountAtomic <= 0n) throw new Error(`${symbol} amount must be greater than 0`);

  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account],
  });
  if (balance < amountAtomic) {
    throw new Error(
      `Insufficient ${symbol}: have ${formatUnits(balance, decimals)}, need ${params.amountUsdc}`
    );
  }

  const swapId = await computeSwapId({
    seller: params.seller,
    buyer: account,
    amount: amountAtomic,
    hashlock: params.hashlock,
    timelock: params.timelock,
  }, params.token);

  // Approve only when the existing allowance is insufficient, and confirm the
  // approval is mined+successful BEFORE locking — otherwise lock's transferFrom
  // reverts (the "transaction was not approved" symptom).
  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account, htlcAddress],
  });
  if (allowance < amountAtomic) {
    const approveHash = await wallet.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [htlcAddress, amountAtomic],
      account,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveHash,
    });
    if (approveReceipt.status !== "success") {
      throw new Error(`${symbol} approve transaction failed — try again`);
    }
  }

  const lockHash = await wallet.writeContract({
    address: htlcAddress,
    abi: HTLC_ABI,
    functionName: "lock",
    args: [params.seller, amountAtomic, params.hashlock, params.timelock],
    account,
  });
  const lockReceipt = await publicClient.waitForTransactionReceipt({
    hash: lockHash,
  });
  if (lockReceipt.status !== "success") {
    throw new Error(`${symbol} lock transaction reverted`);
  }
  return { swapId, lockHash, buyer: account };
}

/** Buyer reclaims the locked quote token after the timelock (contract enforces it). */
export async function refundUsdc(swapId: Hex, token?: TokenKey): Promise<Hex> {
  const { htlcAddress } = tokenCtx(token);
  const wallet = createWalletClient({ chain: CHAIN, transport: custom(ethereum()) });
  const [account] = await wallet.getAddresses();
  return wallet.writeContract({
    address: htlcAddress,
    abi: HTLC_ABI,
    functionName: "refund",
    args: [swapId],
    account,
  });
}

export interface OnchainLock {
  buyer: Address;
  seller: Address;
  amount: bigint;
  withdrawn: boolean;
  refunded: boolean;
}

/** Read a swap's on-chain state (for refund availability + status). */
export async function getOnchainLock(
  swapId: Hex,
  token?: TokenKey
): Promise<OnchainLock | null> {
  const t = tokenInfo(token);
  if (!t.htlc) return null;
  const client = createPublicClient({ chain: CHAIN, transport: custom(ethereum()) });
  const [buyer, seller, amount, , , withdrawn, refunded] =
    await client.readContract({
      address: t.htlc,
      abi: HTLC_ABI,
      functionName: "getLock",
      args: [swapId],
    });
  return { buyer, seller, amount, withdrawn, refunded };
}

/** Current swap fee in basis points (for fee/net display). */
export async function getFeeBps(token?: TokenKey): Promise<number> {
  const t = tokenInfo(token);
  if (!t.htlc) return 50;
  const client = createPublicClient({ chain: CHAIN, transport: custom(ethereum()) });
  const bps = await client.readContract({
    address: t.htlc,
    abi: HTLC_ABI,
    functionName: "feeBps",
  });
  return Number(bps);
}

export async function withdrawUsdc(params: {
  swapId: Hex;
  preimageJam: Uint8Array;
  /** Quote token (default USDC). */
  token?: TokenKey;
}): Promise<Hex> {
  const { htlcAddress } = tokenCtx(params.token);
  const wallet = createWalletClient({
    chain: CHAIN,
    transport: custom(ethereum()),
  });
  const [account] = await wallet.getAddresses();
  return wallet.writeContract({
    address: htlcAddress,
    abi: HTLC_ABI,
    functionName: "withdraw",
    args: [
      params.swapId,
      ("0x" +
        [...params.preimageJam]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")) as Hex,
    ],
    account,
  });
}

/** Convert a human token amount string to atomic units for `decimals` places. */
export function toAtomic(amount: string, decimals: number): bigint {
  const [w, f = ""] = amount.trim().split(".");
  const frac = f.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

const cachedDecimals = new Map<string, number>();

/** Read (and cache) a quote token's decimals from chain (USDC 6, wNOCK 16, …). */
export async function getTokenDecimals(token?: TokenKey): Promise<number> {
  const { address } = tokenInfo(token);
  const hit = cachedDecimals.get(address);
  if (hit != null) return hit;
  const client = createPublicClient({ chain: CHAIN, transport: custom(ethereum()) });
  const d = await client.readContract({
    address,
    abi: ERC20_ABI,
    functionName: "decimals",
  });
  cachedDecimals.set(address, Number(d));
  return Number(d);
}

/** @deprecated alias for `getTokenDecimals()` (USDC). */
export function getUsdcDecimals(): Promise<number> {
  return getTokenDecimals();
}

/** Human quote amount → atomic units, using the token's real on-chain decimals. */
export async function usdcToAtomic(amount: string, token?: TokenKey): Promise<bigint> {
  return toAtomic(amount, await getTokenDecimals(token));
}

/** @deprecated assumes 6 decimals; prefer `usdcToAtomic`. Kept for tests/back-compat. */
export function parseUsdc(amount: string): bigint {
  return toAtomic(amount, 6);
}