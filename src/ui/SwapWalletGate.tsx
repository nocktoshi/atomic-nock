/** Wallet status for swap flows — view always allowed; actions gated on connect + match. */
import { useMemo } from "react";
import type { Address } from "viem";
import type { DraftSwap, SwapPublic } from "../swap.js";
import type { NockWalletSession } from "../nock/wallet.js";
import type { Role } from "../app/roles.js";
import { verifySwapWallets } from "../app/roles.js";
import { useSession } from "./session.js";

export interface SwapWalletStatus {
  nock: NockWalletSession | null;
  evm: Address | null;
  /** True when both wallets are connected and match this swap (if it exists). */
  canAct: boolean;
  role: Role | null;
  issues: string[];
}

export function useSwapWalletStatus(swap: DraftSwap): SwapWalletStatus {
  const { nock, evm } = useSession();

  return useMemo(() => {
    const conn = {
      eth: evm,
      nock: nock ? { pkh: nock.pkh, address: nock.address } : null,
    };

    if (!nock || !evm) {
      const issues: string[] = [];
      if (!nock) issues.push("Connect Nockchain.");
      if (!evm) issues.push("Connect Ethereum (Base).");
      return { nock, evm, canAct: false, role: null, issues };
    }

    if (!swap.hEvm) {
      return { nock, evm, canAct: true, role: null, issues: [] };
    }

    const verification = verifySwapWallets(swap as SwapPublic, conn);
    return {
      nock,
      evm,
      canAct: verification.ok,
      role: verification.role,
      issues: verification.issues,
    };
  }, [swap, nock, evm]);
}

export function SwapWalletBanner({
  status,
  connectHint,
}: {
  status: SwapWalletStatus;
  /** e.g. "participate in a swap" — appended when wallets are missing. */
  connectHint: string;
}) {
  if (status.canAct) return null;

  const missing = [!status.nock && "Iris", !status.evm && "MetaMask"]
    .filter(Boolean)
    .join(" and ");

  return (
    <div className="wallet-status-banner">
      {missing ? (
        <p className="hint">
          Connect {missing} using the buttons above to {connectHint}.
        </p>
      ) : (
        <p className="addr-resolve-hint error">
          Connected wallets do not match this swap.
        </p>
      )}
      {status.issues.length > 0 && (
        <ul className="participant-issues">
          {status.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}