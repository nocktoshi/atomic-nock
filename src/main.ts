import { createSession } from "./app/state.js";
import { renderDashboard } from "./ui/role-select.js";
import { mountWalletBar } from "./ui/wallet-bar.js";

const app = document.getElementById("app")!;

// Wallet bar: never replaced on navigation.
const walletBarEl = document.createElement("div");
walletBarEl.className = "wallet-bar-wrap";

// Content area: replaced by renderDashboard / wizard.
const content = document.createElement("div");

app.append(walletBarEl, content);

const session = createSession();
mountWalletBar(session, walletBarEl, () => renderDashboard(content, session));
renderDashboard(content, session);
