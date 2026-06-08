/**
 * Address input field with automatic .nock / .eth name resolution.
 * Resolves names on a short debounce after the user stops typing — no button needed.
 * Resolved address is stored separately so transactions always use the full address.
 */
import { el } from "./dom.js";
import { isNockName, isEnsName, resolveAddress, reverseResolveNock } from "./name-resolve.js";
import { isPlausibleWalletAddress } from "../nock/balance.js";

export type AddressKind = "nock" | "eth";

export interface AddressFieldOpts {
  label: string;
  kind: AddressKind;
  initialValue?: string;
  readonly?: boolean;
}

export interface AddressField {
  row: DocumentFragment;
  input: HTMLInputElement;
  /** Full resolved address, or raw input value if no resolution needed. */
  getValue(): string;
  setValue(addr: string): void;
}

const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
const DEBOUNCE_MS = 400;

function validateNock(v: string): string | null {
  if (!v) return null;
  return isPlausibleWalletAddress(v) ? null : "Nockchain address must be base58 (~48–55 chars)";
}

function validateEth(v: string): string | null {
  if (!v) return null;
  return ETH_RE.test(v) ? null : "Ethereum address must be 0x followed by 40 hex characters";
}

export function addressField(opts: AddressFieldOpts): AddressField {
  const { kind } = opts;
  const frag = document.createDocumentFragment();

  const labelEl = el("label", { text: opts.label });
  const input = el("input", {
    type: "text",
    placeholder: kind === "nock" ? "base58 address or name.nock" : "0x… address or name.eth",
    ...(opts.readonly ? { readonly: true } : {}),
  });
  if (opts.initialValue) input.value = opts.initialValue;

  const hint = el("span", { class: "addr-resolve-hint" });

  let resolvedAddress = "";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function isName(v: string): boolean {
    return kind === "nock" ? isNockName(v) : isEnsName(v);
  }

  function setHint(text: string, cls: "ok" | "error" | ""): void {
    hint.textContent = text;
    hint.className = "addr-resolve-hint" + (cls ? ` ${cls}` : "");
  }

  function isValidAddress(v: string): boolean {
    return kind === "nock" ? isPlausibleWalletAddress(v) : ETH_RE.test(v);
  }

  /** Forward-resolve a .nock/.eth name → address, show the address in hint. */
  async function doForwardResolve(v: string): Promise<void> {
    setHint("Resolving…", "");
    try {
      const result = await resolveAddress(v);
      resolvedAddress = result.address;
      setHint(`✅ ${result.address}`, "ok");
    } catch (e) {
      resolvedAddress = "";
      setHint(e instanceof Error ? e.message : "Resolution failed", "error");
    }
  }

  /** Reverse-resolve a plain address → .nock name, show name in hint if found. */
  async function doReverseResolve(v: string): Promise<void> {
    // Only nock addresses have .nock names; ETH reverse-resolve is not supported.
    if (kind !== "nock") return;
    const name = await reverseResolveNock(v);
    // reverseResolveNock returns the address unchanged if no name found — don't show hint.
    if (name !== v) setHint('✅ ' + name, "ok");
  }

  function onInput(): void {
    resolvedAddress = "";
    if (debounceTimer) clearTimeout(debounceTimer);

    const v = input.value.trim();
    if (!v) { setHint("", ""); return; }

    if (isName(v)) {
      setHint("Resolving…", "");
      debounceTimer = setTimeout(() => void doForwardResolve(v), DEBOUNCE_MS);
    } else {
      const err = kind === "nock" ? validateNock(v) : validateEth(v);
      if (err) {
        setHint(err, "error");
      } else {
        setHint("", "");
        // Valid address — look up a friendly name in the background.
        debounceTimer = setTimeout(() => void doReverseResolve(v), DEBOUNCE_MS);
      }
    }
  }

  if (!opts.readonly) {
    input.addEventListener("input", onInput);
    // Trigger reverse lookup for a pre-filled valid address.
    if (opts.initialValue && !isName(opts.initialValue)) {
      if (isValidAddress(opts.initialValue)) {
        void doReverseResolve(opts.initialValue);
      } else if (opts.initialValue) {
        const err = kind === "nock" ? validateNock(opts.initialValue) : validateEth(opts.initialValue);
        if (err) setHint(err, "error");
      }
    }
  }

  frag.append(labelEl, input, hint);

  return {
    row: frag,
    input,
    getValue() {
      return resolvedAddress || input.value.trim();
    },
    setValue(addr: string) {
      input.value = addr;
      resolvedAddress = "";
      if (debounceTimer) clearTimeout(debounceTimer);
      setHint("", "");
      if (!opts.readonly && addr && !isName(addr)) {
        if (isValidAddress(addr)) {
          void doReverseResolve(addr);
        }
      }
    },
  };
}
