import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyStoredUiSettings } from "./theme";

// Appearance (theme / font size / colors) applies before first paint.
applyStoredUiSettings();

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<App />);
