import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TrayProvider } from './contexts/TrayContext';
import { Menu } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { invoke } from "@tauri-apps/api/core";
import { getStoredLanguage, translate } from './i18n';

(async () => {
  const language = getStoredLanguage();
  const menu = await Menu.new({
    items: [
      {
        id: 'show',
        text: translate(language, 'showWidget'),
        action: () => {
          invoke('show_window');
        },
      },
      {
        id: 'quit',
        text: translate(language, 'quit'),
        action: () => {
          invoke('close_app');
        },
      },
    ],
  });

  const tray = await TrayIcon.getById('main');
  if (!tray) throw new Error('Native tray icon "main" was not initialized');
  await tray.setMenu(menu);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <TrayProvider tray={tray}>
        <App />
      </TrayProvider>
    </React.StrictMode>,
  );
})();