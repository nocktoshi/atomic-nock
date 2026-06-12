import {
  decodeFunctionData,
  type Hex,
} from "viem";
import { tokenInfo, type TokenKey } from "../config.js";
import { HTLC_ABI, searchContractEventsChunked } from "./htlc.js";
import { getEvmClients } from "./clients.js";
import { hexToBytes } from "../swap.js";

/** The HTLC instance for a swap's quote token (default USDC); throws if unset. */
function htlcAddressFor(token?: TokenKey): Hex {
  const t = tokenInfo(token);
  if (!t.htlc) {
    throw new Error(
      t.key === "WNOCK"
        ? "wNOCK HTLC not deployed — set VITE_HTLC_ADDRESS_WNOCK"
        : "VITE_HTLC_ADDRESS not set"
    );
  }
  return t.htlc;
}

function publicClient() {
  return getEvmClients().publicClient;
}

/** Decode preimageJam from a Base HTLC withdraw transaction calldata. */
export async function getPreimageFromWithdrawTx(
  txHash: Hex,
  token?: TokenKey
): Promise<Uint8Array> {
  const htlcAddress = htlcAddressFor(token);
  const client = publicClient();
  const tx = await client.getTransaction({ hash: txHash });
  if (!tx?.to || tx.to.toLowerCase() !== htlcAddress.toLowerCase()) {
    throw new Error("Transaction is not a call to this swap's HTLC contract");
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
export async function findPreimageFromSwapWithdraw(
  swapId: Hex,
  token?: TokenKey
): Promise<{
  txHash: Hex;
  preimageJam: Uint8Array;
}> {
  const htlcAddress = htlcAddressFor(token);
  const logs = await searchContractEventsChunked({
    address: htlcAddress,
    eventName: "Withdrawn",
    filter: { swapId },
  });

  if (!logs.length) {
    throw new Error(
      "No Withdrawn event for this swapId — seller must withdraw on Base first"
    );
  }

  const txHash = logs[logs.length - 1]!.transactionHash;
  const preimageJam = await getPreimageFromWithdrawTx(txHash, token);
  return { txHash, preimageJam };
}