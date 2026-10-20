import { useState, useEffect, useMemo, useCallback, useRef, type MouseEvent } from 'react';
import { fetchCopilotUsage, calculatePercentage, formatCopilotPlan, getStoredToken, storeToken } from './services/copilot';
import { fetchClaudeUsage, getClaudeStatus, primaryWindow, formatResetsAt } from './services/claude';
import { startAuthFlow, completeAuthFlow, closeAuthServer } from './services/auth';
import { openUrl } from '@tauri-apps/plugin-opener';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {
  convertAiCreditsToCurrency,
  fetchUsdExchangeRate,
  formatCurrencyAmount,
  getCachedUsdExchangeRate,
  getStoredCurrency,
  storeCurrency,
  type CurrencyCode,
} from './services/currency';
import {
  getStoredLanguage,
  localeForLanguage,
  storeLanguage,
  translate,
  translateClaudeWindowLabel,
  type Language,
  type TranslationKey,
} from './i18n';
import { USAGE_SOURCE_LABELS, type ClaudeStatus, type ClaudeUsage, type CopilotUsage } from './types';
import './App.css';
import { useTray } from './contexts/TrayContext';
import ProgressBar from './components/ProgressBar';
import SettingsPanel from './components/SettingsPanel';
import {
  cacheAvailableUpdate,
  clearCachedAvailableUpdate,
  compareVersions,
  fetchAvailableUpdate,
  getCachedAvailableUpdate,
  getTimeUntilNextUpdateCheck,
  markUpdateCheckAttempt,
  markUpdateNotificationSent,
  shouldCheckForUpdates,
  wasUpdateNotificationSent,
  type AvailableUpdate,
} from './services/updates';

const REFRESH_OPTIONS = [1, 5, 15, 30];
const DEFAULT_REFRESH_MINUTES = 5;
const ALWAYS_ON_TOP_STORAGE_KEY = 'usageAlwaysOnTop';

function App() {
  const { setText, updateMenu, source, setSource } = useTray();
  const [language, setLanguage] = useState<Language>(() => getStoredLanguage());
  const [currency, setCurrency] = useState<CurrencyCode>(() => getStoredCurrency());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const languageRef = useRef(language);
  languageRef.current = language;
  const [usdExchangeRate, setUsdExchangeRate] = useState(() => getCachedUsdExchangeRate(currency));
  const t = (key: TranslationKey) => translate(language, key);

  const handleLanguageChange = (nextLanguage: Language) => {
    storeLanguage(nextLanguage);
    setLanguage(nextLanguage);
  };

  const handleCurrencyChange = (nextCurrency: CurrencyCode) => {
    storeCurrency(nextCurrency);
    setUsdExchangeRate(getCachedUsdExchangeRate(nextCurrency));
    setCurrency(nextCurrency);
  };

  const [userCode, setUserCode] = useState<string>('');
  const [usage, setUsage] = useState<CopilotUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);

  // Claude usage comes from the Claude Code login already on this machine, so there is
  // no sign-in flow here - only a status check and the usage fetch.
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsage | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);

  const [refreshInterval, setRefreshInterval] = useState<number>(() => {
    const v = localStorage.getItem('refreshInterval');
    const n = v ? parseInt(v, 10) : DEFAULT_REFRESH_MINUTES;
    return REFRESH_OPTIONS.includes(n) ? n : DEFAULT_REFRESH_MINUTES;
  });

  // Auth flow state
  const [authState, setAuthState] = useState<{
    userCode: string;
    verificationUri: string;
    deviceCode: string;
    interval: number;
  } | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [compactSize, setCompactSize] = useState({ width: 446, height: 136 });
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState<boolean>(() =>
    localStorage.getItem(ALWAYS_ON_TOP_STORAGE_KEY) === '1'
  );
  const [pinning, setPinning] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const resizeTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    let isActive = true;
    setUsdExchangeRate(getCachedUsdExchangeRate(currency));

    const refreshRate = () => {
      void fetchUsdExchangeRate(currency)
        .then((rate) => {
          if (isActive) setUsdExchangeRate(rate);
        })
        .catch((error) => {
          console.debug(`Could not refresh USD/${currency} rate; using the cached rate if available:`, error);
        });
    };

    refreshRate();
    const refreshInterval = window.setInterval(refreshRate, 24 * 60 * 60 * 1000);
    return () => {
      isActive = false;
      window.clearInterval(refreshInterval);
    };
  }, [currency]);

  useEffect(() => {
    const checkForUpdate = async () => {
      try {
        const isDue = shouldCheckForUpdates();
        if (isDue) markUpdateCheckAttempt();

        const currentVersion = await getVersion();
        const cachedUpdate = getCachedAvailableUpdate();
        if (cachedUpdate && compareVersions(cachedUpdate.version, currentVersion) > 0) {
          setAvailableUpdate(cachedUpdate);
        } else {
          clearCachedAvailableUpdate();
          setAvailableUpdate(null);
        }
        if (!isDue) return;

        const update = await fetchAvailableUpdate(currentVersion);
        if (!update) {
          clearCachedAvailableUpdate();
          setAvailableUpdate(null);
          return;
        }

        cacheAvailableUpdate(update);
        setAvailableUpdate(update);
        if (wasUpdateNotificationSent(update.version)) return;

        try {
          if (!(await isPermissionGranted())) return;
          await sendNotification({
            title: translate(languageRef.current, 'updateNotificationTitle'),
            body: translate(languageRef.current, 'updateNotificationBody', { version: update.version }),
          });
          markUpdateNotificationSent(update.version);
        } catch (notificationError) {
          console.debug('Could not send update notification:', notificationError);
        }
      } catch (error) {
        console.debug('Could not check for GCT updates:', error);
      }
    };

    let isDisposed = false;
    let timeout: number | undefined;
    const scheduleNextCheck = () => {
      if (isDisposed) return;
      timeout = window.setTimeout(async () => {
        await checkForUpdate();
        scheduleNextCheck();
      }, getTimeUntilNextUpdateCheck());
    };

    void checkForUpdate().then(scheduleNextCheck);
    return () => {
      isDisposed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, []);

  const loadClaudeUsage = useCallback(async () => {
    try {
      const data = await fetchClaudeUsage();
      setClaudeUsage(data);
    } catch (err) {
      setClaudeUsage(null);
      console.debug('Could not fetch Claude usage:', err);
    }
  }, []);

  useEffect(() => {
    const storedToken = getStoredToken();
    if (storedToken) {
      setToken(storedToken);
      setHasToken(true);
      loadUsage(storedToken);
    }

    // Detect the Claude Code login, then pick a source that can actually show something.
    getClaudeStatus()
      .then((status) => {
        setClaudeStatus(status);
        if (status.available) {
          loadClaudeUsage();
          if (!storedToken) setSource('claude');
        } else {
          setSource('copilot');
        }
      })
      .catch(() => {
        setClaudeStatus({ available: false, subscription_type: null, expired: false, reason: null });
        setSource('copilot');
      });
  }, []);

  useEffect(() => {
    if (!hasToken || !token) return;

    const interval = setInterval(() => {
      loadUsage(token);
    }, refreshInterval * 60 * 1000);

    return () => clearInterval(interval);
  }, [hasToken, token, refreshInterval, language, currency]);

  const checkAndNotify = async (data: CopilotUsage) => {
    const pct = calculatePercentage(data.premium_requests_used, data.premium_requests_limit);
    // Dedup per billing cycle so each threshold only ever alerts once.
    const key = data.billing_cycle_end;
    const threshold = pct >= 90 ? 90 : pct >= 80 ? 80 : null;
    if (threshold === null) return;

    const storageKey = `notified_${threshold}_${key}`;
    if (localStorage.getItem(storageKey)) return;

    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === 'granted';
      }
      if (!granted) return;

      const exchangeRate = getCachedUsdExchangeRate(currency);
      const equivalent = exchangeRate
        ? translate(language, 'notificationEquivalent', {
            amount: formatCurrencyAmount(
              convertAiCreditsToCurrency(data.premium_requests_used, exchangeRate.rate),
              currency,
              language,
            ),
          })
        : '';
      await sendNotification({
        title: t('notificationTitle'),
        body: translate(language, 'notificationBody', {
          threshold,
          used: data.premium_requests_used,
          limit: data.premium_requests_limit,
          equivalent,
        }),
      });
      localStorage.setItem(storageKey, '1');
    } catch (e) {
      console.debug('Failed to send usage notification:', e);
    }
  };

  useEffect(() => {
    if (!claudeStatus?.available) return;

    const interval = setInterval(loadClaudeUsage, refreshInterval * 60 * 1000);
    return () => clearInterval(interval);
  }, [claudeStatus?.available, loadClaudeUsage, refreshInterval]);

  const loadUsage = async (authToken: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCopilotUsage(authToken);
      setUsage(data);
      checkAndNotify(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedUsageFetch'));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveToken = async () => {
    if (token.trim()) {
      storeToken(token);
      setHasToken(true);
      loadUsage(token);
      // Close the auth server if it's running
      try {
        await closeAuthServer();
      } catch {
        // Ignore errors - server might not be running
      }
      setAuthState(null);
    }
  };

  const handleRefresh = useCallback(() => {
    if (source === 'claude') {
      loadClaudeUsage();
    } else if (token) {
      loadUsage(token);
    }
  }, [source, token, loadClaudeUsage, language, currency]);

  const startPollingForToken = async (
    deviceCode: string,
    intervalSeconds = 5,
    attempts = 0
  ) => {
    try {
      const authToken = await completeAuthFlow(deviceCode);
      setToken(authToken);
      storeToken(authToken);
      setHasToken(true);
      loadUsage(authToken);
      setAuthState(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isPending =
        message.includes('authorization_pending') ||
        message.includes('Authorization is still pending') ||
        message.includes('slow_down');

      if (!isPending) {
        setAuthError(message || t('authenticationFailed'));
        setAuthState(null);
        return;
      }

      if (attempts >= 30) { // Max 5 minutes (30 attempts at 10 seconds each)
        setAuthError(t('authenticationTimedOut'));
        setAuthState(null);
        return;
      }
      setTimeout(() => {
        startPollingForToken(deviceCode, intervalSeconds, attempts + 1);
      }, Math.max(5, intervalSeconds) * 1000);
    }
  };

  const handleStartAuth = async () => {
    setAuthLoading(true);
    setAuthError(null);
    console.log("Starting auth flow");
    try {
      const result = await startAuthFlow();
      console.log("Auth flow started", result);
      setAuthState({
        userCode: result.user_code,
        verificationUri: result.verification_uri,
        deviceCode: result.device_code,
        interval: result.interval,
      });

      // Open the verification URL in default browser
      await openUrl(result.verification_uri);
      setUserCode(result.user_code);

      console.log("Starting polling");
      startPollingForToken(result.device_code, result.interval);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : t('failedStartAuthentication'));
    } finally {
      setAuthLoading(false);
    }
  };

  const premiumPercentage = useMemo(() => {
    const value = usage ? calculatePercentage(usage.premium_requests_used, usage.premium_requests_limit) : 0;
    return value;
  }, [usage?.premium_requests_used, usage?.premium_requests_limit]);

  const premiumCurrencyEquivalent = useMemo(() => (
    usage && usdExchangeRate
      ? convertAiCreditsToCurrency(usage.premium_requests_used, usdExchangeRate.rate)
      : null
  ), [usage?.premium_requests_used, usdExchangeRate]);

  const claudePrimary = useMemo(() => primaryWindow(claudeUsage), [claudeUsage]);

  // The single number the menu bar shows for the selected source.
  const activePercentage = source === 'claude' ? claudePrimary?.percent ?? 0 : premiumPercentage;
  const hasActiveData = source === 'claude' ? claudeUsage !== null : usage !== null;

  useEffect(() => () => {
    dragCleanupRef.current?.();
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setIsResizing(true);
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = window.setTimeout(() => {
        setIsResizing(false);
        resizeTimeoutRef.current = null;
      }, 160);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const detailsHeight = Math.min(900, Math.max(compactSize.height, 680));
    void getCurrentWindow().setSize(
      new LogicalSize(compactSize.width, expanded ? detailsHeight : compactSize.height)
    );
  }, [compactSize, expanded]);

  useEffect(() => {
    if (localStorage.getItem(ALWAYS_ON_TOP_STORAGE_KEY) !== '1') return;
    void getCurrentWindow().setAlwaysOnTop(true).catch((error) => {
      console.error('Failed to restore always-on-top setting:', error);
      localStorage.setItem(ALWAYS_ON_TOP_STORAGE_KEY, '0');
      setAlwaysOnTop(false);
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen('usage-widget-unpinned', () => {
      localStorage.setItem(ALWAYS_ON_TOP_STORAGE_KEY, '0');
      setAlwaysOnTop(false);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    }).catch((error) => {
      console.error('Failed to listen for widget unpin events:', error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const copilotPlan = useMemo(() => formatCopilotPlan(usage), [usage]);

  useEffect(() => {
    const totalBlocks = 5;
    const pct = Math.max(0, Math.min(100, activePercentage));
    const filledBlocks = Math.round((pct / 100) * totalBlocks);
    const progressBar = '▰'.repeat(filledBlocks) + '▱'.repeat(totalBlocks - filledBlocks);
    setText(hasActiveData ? ` ${progressBar} ${activePercentage}%` : ' —', language);
  }, [activePercentage, hasActiveData, language, setText]);

  useEffect(() => {
    localStorage.setItem('refreshInterval', String(refreshInterval));
  }, [refreshInterval]);

  useEffect(() => {
    updateMenu({
      copilot: usage
        ? {
            premiumUsed: usage.premium_requests_used,
            premiumLimit: usage.premium_requests_limit,
            premiumRemaining: Math.max(0, usage.premium_requests_limit - usage.premium_requests_used),
            currencyEquivalent: premiumCurrencyEquivalent === null
              ? null
              : formatCurrencyAmount(premiumCurrencyEquivalent, currency, language),
            billingCycleEnd: new Date(usage.billing_cycle_end).toLocaleDateString(localeForLanguage(language)),
            plan: copilotPlan,
            organizations: usage.organizations,
          }
        : null,
      claude: claudeUsage
        ? {
            windows: claudeUsage.windows.map((window) => ({
              label: translateClaudeWindowLabel(language, window.key, window.label),
              percent: window.percent,
              resetsAt: formatResetsAt(window.resets_at, localeForLanguage(language), t('resetNow')),
            })),
          }
        : null,
      claudeSubscriptionType: claudeStatus?.subscription_type ?? null,
      claudeAvailable: claudeStatus?.available ?? false,
      copilotAvailable: hasToken,
      language,
    }, handleRefresh);
  }, [usage, copilotPlan, premiumCurrencyEquivalent, currency, language, claudeUsage, claudeStatus?.available, claudeStatus?.subscription_type, hasToken, updateMenu, handleRefresh]);



  const refreshControl = (
    <div className="refresh-control">
      <label>
        {t('autoRefresh')}
        <select
          aria-label={t('autoRefresh')}
          value={refreshInterval}
          onChange={(event) => setRefreshInterval(Number(event.target.value))}
        >
          {REFRESH_OPTIONS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} {t('minuteAbbreviation')}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  const dashboard = (() => {
  if (!hasToken) {
    return (
      <div className="container">
        <h1>GCT</h1>
        <div className="token-setup">
          <p>{t('enterGithubToken')}</p>

          <button
            onClick={handleStartAuth}
            disabled={authLoading || authState !== null}
            className="btn-github"
          >
            {authLoading ? t('starting') : `🔑 ${t('loginWithGithub')}`}
          </button>

          {authState && (
            <div className="auth-code-section">
              <p>{t('enterCodeAt')} <a href={authState.verificationUri} target="_blank" rel="noopener noreferrer">{authState.verificationUri}</a>:</p>
              <div className="user-code">{authState.userCode}</div>
              <p className="auth-status">{t('waitingForAuthorization')}</p>
            </div>
          )}

          {
            userCode && !authState && (
              <div className="auth-code-section">
                <p>{t('authorizeAt')} <a href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">{t('deviceLogin')}</a> {t('authorizeAndEnterCode')}</p>
                <div className="user-code">{userCode}</div>
              </div>
            )
          }

          {authError && <div className="error">{authError}</div>}

          <div className="divider">
            <span>{t('orEnterToken')}</span>
          </div>

          <input
            aria-label={t('githubToken')}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_..."
            className="token-input"
          />
          <button onClick={() => setToken('')} className="btn-secondary">
            {t('clear')}
          </button>
          <button onClick={handleSaveToken} className="btn-primary">
            {t('saveToken')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>GCT</h1>

      {loading && <div className="status">{t('loading')}</div>}
      {error && <div className="error">{error}</div>}

      {usage && (
        <>
          <div className="usage-section">
            <ProgressBar
              label={t('aiCredits')}
              percent={premiumPercentage}
              used={usage.premium_requests_used}
              limit={usage.premium_requests_limit}
              variant="premium"
              currencyEquivalent={premiumCurrencyEquivalent}
              currency={currency}
              currencyRateDate={usdExchangeRate?.date}
              language={language}
            />
          </div>

          {refreshControl}

          <div className="billing-info">
            {copilotPlan && (
              <p>
                {t('license')}: <strong>{copilotPlan}</strong>
                {usage.organizations.length > 0 && ` (${usage.organizations.join(', ')})`}
              </p>
            )}
            <p>{t('billing')}: {new Date(usage.billing_cycle_end).toLocaleDateString(localeForLanguage(language))}</p>
          </div>
        </>
      )}

      <div className="actions">
        <button onClick={() => loadUsage(token)} disabled={loading} className="btn-primary">
            {t('refresh')}
        </button>
        <button onClick={() => { localStorage.removeItem('github_token'); setHasToken(false); setUsage(null); }} className="btn-secondary">
          {t('changeToken')}
        </button>
      </div>
    </div>
  );
  })();

  const filledSegments = hasActiveData
    ? Math.round(Math.max(0, Math.min(100, activePercentage)) / 20)
    : 0;

  const handlePillDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('.pill-controls')) return;

    dragCleanupRef.current?.();
    const startX = event.screenX;
    const startY = event.screenY;
    let cleanup = () => {};

    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      if (Math.hypot(moveEvent.screenX - startX, moveEvent.screenY - startY) < 5) return;
      cleanup();
      void getCurrentWindow().startDragging().catch((dragError) => {
        console.error('Failed to move usage pill:', dragError);
      });
    };
    const handleMouseUp = () => cleanup();

    cleanup = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleMouseUp, { once: true });
  };

  const handleResizeDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startResizeDragging('SouthEast').catch((resizeError) => {
      console.error('Failed to resize usage widget:', resizeError);
    });
  };

  const handleToggleAlwaysOnTop = async () => {
    const nextValue = !alwaysOnTop;
    setPinning(true);
    setPinError(null);
    try {
      await getCurrentWindow().setAlwaysOnTop(nextValue);
      localStorage.setItem(ALWAYS_ON_TOP_STORAGE_KEY, nextValue ? '1' : '0');
      setAlwaysOnTop(nextValue);
    } catch (error) {
      console.error('Failed to toggle always-on-top:', error);
      setPinError(t('pinFailed'));
    } finally {
      setPinning(false);
    }
  };

  const handleHideWidget = async () => {
    setAlwaysOnTop(false);
    localStorage.setItem(ALWAYS_ON_TOP_STORAGE_KEY, '0');
    try {
      await invoke('hide_window');
    } catch (error) {
      console.error('Failed to hide usage widget:', error);
    }
  };

  const handleToggleDetails = () => {
    if (!expanded) {
      setCompactSize({
        width: Math.min(900, Math.max(260, Math.round(window.innerWidth))),
        height: Math.min(900, Math.max(76, Math.round(window.innerHeight))),
      });
      setExpanded(true);
      return;
    }

    setExpanded(false);
  };

  return (
    <main className={`widget-shell${isResizing ? ' is-resizing' : ''}`}>
      <div className="usage-pill" role="group" aria-label={t('usageWidget')} onMouseDown={handlePillDrag}>
        <button
          type="button"
          className="pill-main"
          aria-label={translate(language, 'pillAriaLabel', {
            source: USAGE_SOURCE_LABELS[source],
            percentage: hasActiveData ? `${Math.round(activePercentage)} ${t('percentWord')}` : t('usageUnavailable'),
          })}
          aria-expanded={expanded}
          title={t('clickForDetails')}
          onClick={handleToggleDetails}
        >
          <img className="pill-icon" src="/copilot-mark.png" alt="" draggable="false" />
          <div className="pill-meter" aria-hidden="true">
            {Array.from({ length: 5 }, (_, index) => (
              <span
                key={index}
                className={`meter-segment${index < filledSegments ? ' is-filled' : ''}`}
              />
            ))}
          </div>
          <span className="pill-percentage">
            {hasActiveData ? `${Math.round(activePercentage)}%` : '—'}
          </span>
        </button>
        <div className="pill-controls" role="toolbar" aria-label={t('widgetOptions')}>
          <button
            type="button"
            className={`widget-control widget-control-pin${alwaysOnTop ? ' is-active' : ''}`}
            aria-label={pinError ?? (alwaysOnTop ? t('unpinFromTop') : t('pinOnTop'))}
            aria-pressed={alwaysOnTop}
            disabled={pinning}
            title={pinError ?? (alwaysOnTop ? t('keepingOnTop') : t('keepOnTop'))}
            onClick={() => void handleToggleAlwaysOnTop()}
          >
            <svg className="widget-control-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 4h8l-1 5 3 3v2H6v-2l3-3-1-5Z" />
              <path d="M12 14v7" />
            </svg>
            <span className="widget-control-label">
              {pinning ? t('pinning') : pinError ?? (alwaysOnTop ? t('pinned') : t('pinOnTop'))}
            </span>
          </button>
          <button
            type="button"
            className={`widget-control${expanded ? ' is-active' : ''}`}
            aria-label={availableUpdate
              ? `${t('openDetails')}. ${t('updateAvailable')} ${availableUpdate.version}`
              : expanded ? t('closeDetails') : t('openDetails')}
            aria-pressed={expanded}
            title={availableUpdate
              ? `${t('openDetails')} — ${t('updateAvailable')} ${availableUpdate.version}`
              : expanded ? t('closeDetails') : t('openDetails')}
            onClick={handleToggleDetails}
          >
            <svg className="widget-control-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 5v15h16" />
              <path d="M8 16v-3M13 16V8M18 16v-6" />
            </svg>
            <span className="widget-control-label">{expanded ? t('close') : t('details')}</span>
            {availableUpdate && <span className="update-indicator" aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="widget-control widget-control-hide"
            aria-label={t('hideToTray')}
            title={t('hideToTray')}
            onClick={() => void handleHideWidget()}
          >
            <svg className="widget-control-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
            <span className="widget-control-label">{t('hideWidget')}</span>
          </button>
        </div>
      </div>

      {expanded && (
        <section className="details-panel" aria-label={t('usageDetails')}>
          <div className="details-toolbar">
            <button
              type="button"
              className="details-settings-toggle"
              aria-label={settingsOpen ? t('closeSettings') : t('openSettings')}
              aria-expanded={settingsOpen}
              aria-controls="gct-settings"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <svg className="details-settings-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
                <path d="m19.4 13.5 1.1.9-1.4 2.4-1.4-.5a7.9 7.9 0 0 1-1.5.9l-.3 1.5h-2.8l-.3-1.5a7.9 7.9 0 0 1-1.5-.9l-1.4.5-1.4-2.4 1.1-.9a7.1 7.1 0 0 1 0-1.8l-1.1-.9 1.4-2.4 1.4.5a7.9 7.9 0 0 1 1.5-.9l.3-1.5h2.8l.3 1.5a7.9 7.9 0 0 1 1.5.9l1.4-.5 1.4 2.4-1.1.9a7.1 7.1 0 0 1 0 1.8Z" />
              </svg>
              <span>{t('settings')}</span>
            </button>
            <button
              type="button"
              className="details-close"
              aria-label={t('closeDetails')}
              title={t('closeDetails')}
              onClick={() => setExpanded(false)}
            >
              ×
            </button>
          </div>
          {availableUpdate && (
            <aside className="update-notice" role="status" aria-live="polite">
              <div className="update-notice-copy">
                <strong>{t('updateAvailable')}</strong>
                <p>{translate(language, 'updateAvailableBody', { version: availableUpdate.version })}</p>
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void openUrl(availableUpdate.releaseUrl).catch((error) => {
                  console.error('Failed to open the GCT release page:', error);
                })}
              >
                {t('downloadUpdate')}
              </button>
            </aside>
          )}
          <SettingsPanel
            language={language}
            currency={currency}
            isOpen={settingsOpen}
            onLanguageChange={handleLanguageChange}
            onCurrencyChange={handleCurrencyChange}
          />
          {dashboard}
        </section>
      )}
      <div
        className="resize-handle"
        role="img"
        aria-label={t('resizeWidget')}
        title={t('resizeWidget')}
        onMouseDown={handleResizeDrag}
      >
        <svg className="resize-affordance" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M18 5 5 18M18 11l-7 7M18 0 0 18" />
        </svg>
      </div>
    </main>
  );
}

export default App;
