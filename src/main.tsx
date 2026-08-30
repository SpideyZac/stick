import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProfileProvider } from "./profile/ProfileContext";
import { App } from "./ui/App";
import "./ui/styles.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <ProfileProvider>
            <App />
        </ProfileProvider>
    </StrictMode>,
);
