/**
 * Address input with automatic .nock / .eth name resolution (React port).
 *
 * Fully controlled: `value` is the visible text and `onChange` reports the value
 * to store. Keystrokes report the raw text; once a .nock/.eth name resolves, the
 * resolved full address is reported so the swap state always holds the canonical
 * address used in transactions.
 */
import { useEffect, useMemo, useState } from "react";
import {
  isNockName,
  isEnsName,
  resolveAddress,
  reverseResolveNock,
} from "./name-resolve.js";
import { isPlausibleWalletAddress } from "../nock/balance.js";

export type AddressKind = "nock" | "eth";

export interface AddressFieldProps {
  label: string;
  kind: AddressKind;
  value: string;
  onChange?(value: string): void;
  readonly?: boolean;
}

const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
const DEBOUNCE_MS = 400;

function validateNock(v: string): string | null {
  if (!v) return null;
  return isPlausibleWalletAddress(v)
    ? null
    : "Nockchain address must be base58 (~48–55 chars)";
}

function validateEth(v: string): string | null {
  if (!v) return null;
  return ETH_RE.test(v)
    ? null
    : "Ethereum address must be 0x followed by 40 hex characters";
}

type Hint = { text: string; cls: "ok" | "error" | "" };

const EMPTY_HINT: Hint = { text: "", cls: "" };

export function AddressField({
  label,
  kind,
  value,
  onChange,
  readonly,
}: AddressFieldProps) {
  const [asyncHint, setAsyncHint] = useState<{
    forValue: string;
    hint: Hint;
  } | null>(null);

  const trimmed = value.trim();
  const syncHint = useMemo((): Hint | null => {
    if (!trimmed) return EMPTY_HINT;
    const nameLike = kind === "nock" ? isNockName(trimmed) : isEnsName(trimmed);
    if (nameLike) return { text: "Resolving…", cls: "" };
    const err = kind === "nock" ? validateNock(trimmed) : validateEth(trimmed);
    if (err) return { text: err, cls: "error" };
    return null;
  }, [trimmed, kind]);

  // Network lookups only — sync validation/resolving text comes from syncHint.
  useEffect(() => {
    if (readonly || !trimmed) return;

    let alive = true;
    const nameLike = kind === "nock" ? isNockName(trimmed) : isEnsName(trimmed);

    if (nameLike) {
      const t = setTimeout(async () => {
        try {
          const result = await resolveAddress(trimmed);
          if (!alive) return;
          setAsyncHint({
            forValue: trimmed,
            hint: { text: `✅ ${result.address}`, cls: "ok" },
          });
          if (result.address !== trimmed) onChange?.(result.address);
        } catch (e) {
          if (!alive) return;
          setAsyncHint({
            forValue: trimmed,
            hint: {
              text: e instanceof Error ? e.message : "Resolution failed",
              cls: "error",
            },
          });
        }
      }, DEBOUNCE_MS);
      return () => {
        alive = false;
        clearTimeout(t);
      };
    }

    if (kind !== "nock") return;

    const err = validateNock(trimmed);
    if (err) return;

    const t = setTimeout(async () => {
      const name = await reverseResolveNock(trimmed);
      if (!alive || name === trimmed) return;
      setAsyncHint({
        forValue: trimmed,
        hint: { text: `✅ ${name}`, cls: "ok" },
      });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // `onChange` is intentionally excluded: it's recreated each render and only
    // forwards to a stable setter, so including it would needlessly re-resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, readonly, kind]);

  const hint =
    asyncHint?.forValue === trimmed
      ? asyncHint.hint
      : syncHint ?? EMPTY_HINT;

  return (
    <>
      <label>{label}</label>
      <input
        type="text"
        placeholder={
          kind === "nock"
            ? "base58 address or name.nock"
            : "0x… address or name.eth"
        }
        value={value}
        readOnly={readonly}
        onChange={readonly ? undefined : (e) => onChange?.(e.target.value)}
      />
      <span className={"addr-resolve-hint" + (hint.cls ? ` ${hint.cls}` : "")}>
        {hint.text}
      </span>
    </>
  );
}