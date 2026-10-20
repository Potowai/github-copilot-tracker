import React, { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { TrayIcon } from '@tauri-apps/api/tray';
import { Menu, type CheckMenuItemOptions } from '@tauri-apps/api/menu';
import { invoke } from '@tauri-apps/api/core';
import { USAGE_SOURCE_LABELS, type UsageSource } from '../types';
import { translate, type Language, type TranslationKey } from '../i18n';
import { buildUsageSummaryMenuItems, type MenuState } from '../tray-menu';

type TrayContextType = {
  setText: (text?: string, language?: Language) => Promise<void>;
  close: () => Promise<void>;
  tray: TrayIcon | null;
  updateMenu: (state: MenuState | null, onRefresh?: () => void) => Promise<void>;
  source: UsageSource;
  setSource: (source: UsageSource) => void;
};

const SOURCE_STORAGE_KEY = 'usageSource';

const TrayContext = createContext<TrayContextType | null>(null);

export const useTray = (): TrayContextType => {
  const ctx = useContext(TrayContext);
  if (!ctx) throw new Error('useTray must be used within a TrayProvider');
  return ctx;
};

export const TrayProvider: React.FC<{ tray: TrayIcon | null; children?: React.ReactNode }> = ({ tray, children }) => {
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [source, setSourceState] = useState<UsageSource>(() => {
    const stored = localStorage.getItem(SOURCE_STORAGE_KEY);
    return stored === 'claude' ? 'claude' : 'copilot';
  });

  const setSource = useCallback((next: UsageSource) => {
    setSourceState(next);
    localStorage.setItem(SOURCE_STORAGE_KEY, next);
  }, []);

  useEffect(() => {
    const checkAutostart = async () => {
      try {
        const enabled = await invoke<boolean>('is_autostart_enabled');
        setAutostartEnabled(enabled);
      } catch (e) {
        console.debug('Failed to check autostart status:', e);
      }
    };
    checkAutostart();
  }, []);

  const toggleAutostart = useCallback(async () => {
    try {
      if (autostartEnabled) {
        await invoke('disable_autostart');
        setAutostartEnabled(false);
      } else {
        await invoke('enable_autostart');
        setAutostartEnabled(true);
      }
    } catch (e) {
      console.error('Failed to toggle autostart:', e);
    }
  }, [autostartEnabled]);

  const setText = useCallback(async (text?: string, language: Language = 'en') => {
    const tooltip = `GCT · ${USAGE_SOURCE_LABELS[source]} ${translate(language, 'usage')}${text ? ` - ${text.trim()}` : ''}`;
    try {
      if (tray) {
        await tray.setTitle(text ?? '');
        await tray.setTooltip(tooltip);
      } else {
        // fallback: try to find the tray by id
        const found = await TrayIcon.getById('main');
        await found?.setTitle(text ?? '');
        await found?.setTooltip(tooltip);
      }
    } catch (e) {
      // ignore errors when running on platforms that don't support titles
      console.debug('setText error', e);
    }
  }, [tray, source]);

  const close = useCallback(async () => {
    const found = await TrayIcon.getById('main');
    found?.close();
  }, []);

  const updateMenu = useCallback(async (state: MenuState | null, onRefresh?: () => void) => {
    try {
      const targetTray = tray ?? await TrayIcon.getById('main');
      if (!targetTray) return;

      const language = state?.language ?? 'en';
      const t = (key: TranslationKey) => translate(language, key);
      const items = buildUsageSummaryMenuItems(state, source, USAGE_SOURCE_LABELS, t, setSource);

      items.push(
        { item: 'Separator' },
        {
          id: 'refresh',
          text: t('refreshNow'),
          action: onRefresh ?? (() => {}),
        },
        {
          item: 'Separator',
        },
        {
          id: 'hide',
          text: t('hideWidget'),
          action: () => {
            invoke('hide_window');
          },
        },
        {
          id: 'show',
          text: t('showWidget'),
          action: () => {
            invoke('show_window');
          },
        },
        { item: 'Separator' },
        {
          id: 'autostart',
          text: t('startAtLogin'),
          checked: autostartEnabled,
          action: toggleAutostart,
        } as CheckMenuItemOptions,
        { item: 'Separator' },
        {
          id: 'quit',
          text: t('quit'),
          action: () => {
            invoke('close_app');
          },
        }
      );

      const menu = await Menu.new({ items });
      await targetTray.setMenu(menu);
    } catch (e) {
      console.debug('Failed to update tray menu:', e);
    }
  }, [tray, autostartEnabled, toggleAutostart, source, setSource]);

  useEffect(() => {
    invoke('set_tray_icon');
  }, []);

  return (
    <TrayContext.Provider value={{ setText, close, tray, updateMenu, source, setSource }}>
      {children}
    </TrayContext.Provider>
  );
};

export default TrayContext;
