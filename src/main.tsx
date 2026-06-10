import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { BrowserRouter } from "react-router-dom";
import { App } from "./ui/App.js";
import { registerServiceWorker } from "./app/push.js";

void registerServiceWorker();

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
