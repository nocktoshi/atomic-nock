/** Tiny DOM helpers so wizard steps can build markup without innerHTML soup. */

type Child = Node | string | null | undefined | false;

interface ElAttrs {
  id?: string;
  class?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  pattern?: string;
  step?: string;
  min?: string;
  readonly?: boolean;
  text?: string;
  html?: string;
  for?: string;
  [data: `data-${string}`]: string | undefined;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val == null || val === false) continue;
    if (key === "class") node.className = String(val);
    else if (key === "text") node.textContent = String(val);
    else if (key === "html") node.innerHTML = String(val);
    else if (key === "readonly") (node as HTMLInputElement).readOnly = true;
    else node.setAttribute(key, String(val));
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Labelled input row, matching the existing `<label>` + `<input>` markup. */
export function field(
  label: string,
  attrs: ElAttrs = {}
): { row: DocumentFragment; input: HTMLInputElement } {
  const frag = document.createDocumentFragment();
  const input = el("input", attrs);
  frag.append(el("label", { text: label }), input);
  return { row: frag, input };
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  event: K,
  handler: (ev: HTMLElementEventMap[K]) => void
): void {
  node.addEventListener(event, handler);
}

/**
 * Run an async action while showing a button as busy (disabled + pulsing), and
 * ALWAYS restore it afterwards — including when the action rejects or never
 * returns cleanly. This is what keeps a failed wallet hand-off from leaving the
 * button stuck disabled. The result/rejection propagates to the caller.
 */
export async function runBusy<T>(
  button: HTMLButtonElement,
  fn: () => Promise<T>
): Promise<T> {
  if (button.disabled) {
    // Guard against double-submit while an action is already in flight.
    throw new Error("Action already in progress");
  }
  button.disabled = true;
  button.classList.add("busy");
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
  }
}
