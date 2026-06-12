/** A shortened, copyable transaction id (shared by the buy + sell flows). */
import { useState } from "react";
import { short, copyText } from "./util.js";

export function TxLink({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="tx-link"
      title={`Copy ${id}`}
      onClick={() => {
        void copyText(id).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {short(id, 10, 6)} {copied ? "✓ copied" : "⧉"}
    </button>
  );
}
