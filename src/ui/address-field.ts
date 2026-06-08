/**
 * Address input field that supports .nock and .eth name resolution.
 * Shows a "Resolve" button when a name is detected; resolved addresses
 * are stored separately so transactions always use the full address.
 */
import { el } from "./dom.js";
import { isNockName, isEnsName, resolveAddress } from "./name-resolve.js";
import { isPlausibleWalletAddress } from "../nock/balance.js";

export type AddressKind = "nock" | "eth";

export interface AddressFieldOpts {
  label: string;
  kind: AddressKind;
  initialValue?: string;
  readonly?: boolean;
}

export interface AddressField {
  /** The container fragment to append to the DOM. */
  row: DocumentFragment;
  /** Raw <input> element — useful for focus / pattern validation. */
  input: HTMLInputElement;
  /** Always the full resolved address (or raw input if resolution hasn't happened). */
  getValue(): string;
  /** Set the field to a known full address, clearing any display-name state. */
  setValue(addr: string): void;
}

const ETH_RE = /^0x[0-9a-fA-F]{40}$/;

function validateNock(v: string): string | null {
  if (!v) return null;
  if (!isPlausibleWalletAddress(v)) {
    return "Nockchain address must be base58 (~48–55 chars)";
  }
  return null;
}

function validateEth(v: string): string | null {
  if (!v) return null;
  if (!ETH_RE.test(v)) {
    return "Ethereum address must be 0x followed by 40 hex characters";
  }
  return null;
}

export function addressField(opts: AddressFieldOpts): AddressField {
  const { label, kind } = opts;
  const frag = document.createDocumentFragment();

  const labelEl = el("label", { text: label });

  const inputWrapper = el("div", { class: "addr-field-wrap" });

  const input = el("input", {
    type: "text",
    placeholder: kind === "nock"
      ? "base58 address or name.nock"
      : "0x… address or name.eth",
    ...(opts.readonly ? { readonly: true } : {}),
  });
  if (opts.initialValue) input.value = opts.initialValue;

  const resolveBtn = el("button", {
    type: "button",
    class: "addr-resolve-btn secondary",
    text: "Resolve",
  });

  const hint = el("span", { class: "addr-resolve-hint" });

  // Resolved address (full). Empty means use input.value directly.
  let resolvedAddress = "";
  let displayName = "";

  function isName(v: string): boolean {
    return kind === "nock" ? isNockName(v) : isEnsName(v);
  }

  function validate(addr: string): string | null {
    return kind === "nock" ? validateNock(addr) : validateEth(addr);
  }

  function updateResolveBtn(): void {
    const v = input.value.trim();
    const needsResolve = isName(v);
    resolveBtn.style.display = opts.readonly ? "none" : needsResolve ? "inline-block" : "none";
    if (!needsResolve) {
      resolvedAddress = "";
      displayName = "";
      hint.textContent = "";
      hint.className = "addr-resolve-hint";
      const err = validate(v);
      if (v && err) {
        hint.textContent = err;
        hint.className = "addr-resolve-hint error";
      }
    }
  }

  input.addEventListener("input", () => {
    resolvedAddress = "";
    displayName = "";
    updateResolveBtn();
  });

  resolveBtn.onclick = async () => {
    const v = input.value.trim();
    resolveBtn.disabled = true;
    resolveBtn.textContent = "Resolving…";
    hint.textContent = "";
    hint.className = "addr-resolve-hint";
    try {
      const result = await resolveAddress(v);
      resolvedAddress = result.address;
      displayName = result.displayName;
      hint.textContent = `→ ${result.address}`;
      hint.className = "addr-resolve-hint ok";
    } catch (e) {
      hint.textContent = e instanceof Error ? e.message : "Resolution failed";
      hint.className = "addr-resolve-hint error";
      resolvedAddress = "";
    } finally {
      resolveBtn.disabled = false;
      resolveBtn.textContent = "Resolve";
    }
  };

  inputWrapper.append(input, resolveBtn);
  frag.append(labelEl, inputWrapper, hint);

  updateResolveBtn();

  return {
    row: frag,
    input,
    getValue() {
      return resolvedAddress || input.value.trim();
    },
    setValue(addr: string) {
      input.value = addr;
      resolvedAddress = "";
      displayName = "";
      hint.textContent = "";
      hint.className = "addr-resolve-hint";
      updateResolveBtn();
    },
  };
}
