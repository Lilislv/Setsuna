import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";
import "./styles/motion.css";
import "./styles/design.css";
import { installAutoHideScrollbars } from "./utils/autoScrollbars";
import { disableNativeContextMenu } from "./utils/nativeContextMenu";

disableNativeContextMenu();
installAutoHideScrollbars();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
