import { createSession } from "./app/state.js";
import { renderDashboard } from "./ui/role-select.js";

const app = document.getElementById("app")!;

const session = createSession();
renderDashboard(app, session);
