/** Global wallet session — shared across the wallet bar, dashboard, and wizards. */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Address } from "viem";
import type { Digest } from "@nockbox/iris-sdk/wasm";
import type { NockWalletSession } from "../nock/wallet.js";
import { claimNockAction as claimNockActionCore } from "../actions/buyer.js";
import {
  lockNockAction as lockNockActionCore,
  refundNockAction as refundNockActionCore,
} from "../actions/seller.js";
import { claimNock as claimNockCore } from "../nock/claim.js";
import {
  lockNock as lockNockCore,
  consolidateNotes as consolidateNotesCore,
  type ConsolidateResult,
} from "../nock/lock.js";
import { refundNock as refundNockCore } from "../nock/refund.js";
import { fetchCurrentBlockHeight as fetchCurrentBlockHeightCore } from "../nock/balance.js";
import { assertPreimageMatchesHNock } from "../swap.js";
import { isPlausibleWalletAddress } from "../nock/balance.js";

export interface SessionValue {
  /** Connected Iris (Nockchain) wallet. */
  nock: NockWalletSession | null;
  /** Connected Base (EVM) address. */
  evm: Address | null;
  setNock(n: NockWalletSession | null): void;
  setEvm(e: Address | null): void;
  /** Buyer: claim locked NOCK with preimage (Iris must be connected). */
  claimNockAction: typeof claimNockActionCore;
  /** Seller: lock NOCK into HTLC (Iris must be connected). */
  lockNockAction: typeof lockNockActionCore;
  /** Seller: refund locked NOCK after timelock (Iris must be connected). */
  refundNockAction: typeof refundNockActionCore;
  /** Seller: merge all wallet notes into one via a self-transfer (Iris must be connected). */
  consolidateNotes: (walletAddress: string) => Promise<ConsolidateResult>;
  /** Current chain height via connected Iris wallet, or undefined. */
  fetchCurrentBlockHeight: () => Promise<bigint | undefined>;
}

const SessionContext = createContext<SessionValue | null>(null);

function connectIrisError(): Error {
  return new Error("Please connect Nockchain wallet.");
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [nock, setNock] = useState<NockWalletSession | null>(null);
  const [evm, setEvm] = useState<Address | null>(null);

  const requireNock = useCallback((): NockWalletSession => {
    if (!nock) throw connectIrisError();
    return nock;
  }, [nock]);

  const claimNockAction = useCallback<typeof claimNockActionCore>(
    (input) =>
      claimNockActionCore(input, {
        claimNock: (params) => claimNockCore(requireNock(), params),
        assertPreimageMatchesHNock,
      }),
    [requireNock]
  );

  const lockNockAction = useCallback<typeof lockNockActionCore>(
    (input) =>
      lockNockActionCore(input, {
        isPlausibleWalletAddress,
        lockNock: (params) => lockNockCore(requireNock(), params),
      }),
    [requireNock]
  );

  const refundNockAction = useCallback<typeof refundNockActionCore>(
    (input) =>
      refundNockActionCore(input, {
        refundNock: (swap) => refundNockCore(requireNock(), swap),
      }),
    [requireNock]
  );

  const consolidateNotes = useCallback(
    (walletAddress: string) =>
      consolidateNotesCore(requireNock(), { walletAddress: walletAddress as Digest }),
    [requireNock]
  );

  const fetchCurrentBlockHeight = useCallback(async () => {
    if (!nock) return undefined;
    return fetchCurrentBlockHeightCore(nock);
  }, [nock]);

  const value = useMemo<SessionValue>(
    () => ({
      nock,
      evm,
      setNock,
      setEvm,
      claimNockAction,
      lockNockAction,
      refundNockAction,
      consolidateNotes,
      fetchCurrentBlockHeight,
    }),
    [
      nock,
      evm,
      claimNockAction,
      lockNockAction,
      refundNockAction,
      consolidateNotes,
      fetchCurrentBlockHeight,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}