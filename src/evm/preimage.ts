import {
  createPublicClient,
  custom,
  decodeFunctionData,
  type Hex,
} from "viem";
import { CHAIN, HTLC_ADDRESS } from "../config.js";
import { HTLC_ABI } from "./htlc.js";
import { hexToBytes } from "../swap.js";

function ethereum() {
  const eth = (window as Window & { ethereum?: object }).ethereum;
  if (!eth) throw new Error("No wallet (install MetaMask)");
  return eth as import("viem").EIP1193Provider;
}

function publicClient() {
  return createPublicClient({
    chain: CHAIN,
    transport: custom(ethereum()),
  });
}

/** Decode preimageJam from a Base HTLC withdraw transaction calldata. */
export async function getPreimageFromWithdrawTx(
  txHash: Hex
): Promise<Uint8Array> {
  if (!HTLC_ADDRESS) throw new Error("VITE_HTLC_ADDRESS not set");
  const client = publicClient();
  const tx = await client.getTransaction({ hash: txHash });
  if (!tx?.to || tx.to.toLowerCase() !== HTLC_ADDRESS.toLowerCase()) {
    throw new Error("Transaction is not a call to the OTC HTLC contract");
  }
  const decoded = decodeFunctionData({
    abi: HTLC_ABI,
    data: tx.input,
  });
  if (decoded.functionName !== "withdraw") {
    throw new Error("Transaction is not withdraw()");
  }
  const preimageHex = decoded.args[1] as Hex;
  return hexToBytes(preimageHex);
}

/** Find the latest withdraw for swapId and return preimage from that tx. */
export async function findPreimageFromSwapWithdraw(swapId: Hex): Promise<{
  txHash: Hex;
  preimageJam: Uint8Array;
}> {
  if (!HTLC_ADDRESS) throw new Error("VITE_HTLC_ADDRESS not set");
  const client = publicClient();
  const head = await client.getBlockNumber();
  const fromBlock = head > 500_000n ? head - 500_000n : 0n;

  const logs = await client.getContractEvents({
    address: HTLC_ADDRESS,
    abi: HTLC_ABI,
    eventName: "Withdrawn",
    args: { swapId },
    fromBlock,
    toBlock: "latest",
  });

  if (!logs.length) {
    throw new Error(
      "No Withdrawn event for this swapId — seller must withdraw USDC on Base first"
    );
  }

  const txHash = logs[logs.length - 1]!.transactionHash;
  const preimageJam = await getPreimageFromWithdrawTx(txHash);
  return { txHash, preimageJam };
}