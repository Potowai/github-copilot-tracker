import type {
  CheckMenuItemOptions,
  MenuItemOptions,
  PredefinedMenuItemOptions,
} from '@tauri-apps/api/menu';
import type { TranslationKey } from './i18n';
import type { UsageSource } from './types';

export type CopilotMenuInfo = {
  premiumUsed: number;
  premiumLimit: number;
  premiumRemaining: number;
  currencyEquivalent: string | null;
  billingCycleEnd: string | null;
  plan: string | null;
  organizations: string[];
};

export type ClaudeMenuWindow = {
  label: string;
  percent: number;
  resetsAt: string | null;
};

export type ClaudeMenuInfo = {
  windows: ClaudeMenuWindow[];
};

export type MenuState = {
  copilot: CopilotMenuInfo | null;
  claude: ClaudeMenuInfo | null;
  claudeSubscriptionType: string | null;
  language: 'en' | 'fr';
  claudeAvailable: boolean;
  copilotAvailable: boolean;
};

export type UsageSourceLabels = Record<UsageSource, string>;
export type MenuTranslate = (key: TranslationKey) => string;

const readOnlyMenuItem = (id: string, text: string): MenuItemOptions => ({
  id,
  text,
  enabled: true,
  action: () => {},
});

/** Build read-only usage rows and the actionable tray source selector. */
export function buildUsageSummaryMenuItems(
  state: MenuState | null,
  source: UsageSource,
  labels: UsageSourceLabels,
  t: MenuTranslate,
  setSource: (source: UsageSource) => void,
): Array<MenuItemOptions | PredefinedMenuItemOptions | CheckMenuItemOptions> {
  const items: Array<MenuItemOptions | PredefinedMenuItemOptions | CheckMenuItemOptions> = [];

  items.push(readOnlyMenuItem('copilot_header', labels.copilot));
  if (state?.copilot) {
    const { premiumUsed, premiumLimit, premiumRemaining, currencyEquivalent, billingCycleEnd, plan, organizations } = state.copilot;
    items.push(
      readOnlyMenuItem('usage_header', `  ${t('aiCredits')}`),
      readOnlyMenuItem('usage_used', `    ${t('used')}: ${premiumUsed} / ${premiumLimit}`),
      readOnlyMenuItem('usage_remaining', `    ${t('remaining')}: ${premiumRemaining}`),
    );
    if (currencyEquivalent) {
      items.push(readOnlyMenuItem('usage_currency_equivalent', `    ${t('equivalentValue')}: ${currencyEquivalent}`));
    }
    if (billingCycleEnd) {
      items.push(readOnlyMenuItem('usage_billing_cycle', `    ${t('billing')}: ${billingCycleEnd}`));
    }
    if (plan) {
      const org = organizations.length > 0 ? ` (${organizations.join(', ')})` : '';
      items.push(readOnlyMenuItem('usage_plan', `    ${t('license')}: ${plan}${org}`));
    }
  } else {
    items.push(readOnlyMenuItem(
      'copilot_unavailable',
      `  ${state?.copilotAvailable ? t('usageUnavailable') : t('notConnected')}`,
    ));
  }
  items.push({ item: 'Separator' });

  items.push(readOnlyMenuItem('claude_header', labels.claude));
  if (state?.claudeSubscriptionType) {
    items.push(readOnlyMenuItem('claude_subscription', `  ${t('license')}: ${state.claudeSubscriptionType}`));
  }
  if (state?.claude?.windows.length) {
    state.claude.windows.forEach((window, index) => {
      const reset = window.resetsAt ? `, ${t('resets')} ${window.resetsAt}` : '';
      items.push(readOnlyMenuItem(`claude_window_${index}`, `  ${window.label}: ${window.percent}%${reset}`));
    });
  } else {
    items.push(readOnlyMenuItem(
      'claude_unavailable',
      `  ${state?.claudeAvailable ? t('usageUnavailable') : t('notConnected')}`,
    ));
  }
  items.push({ item: 'Separator' });

  items.push(readOnlyMenuItem('source_header', t('showUsageFor')));
  (Object.keys(labels) as UsageSource[]).forEach((option) => {
    const isUnavailable = option === 'claude' && !state?.claudeAvailable;
    items.push({
      id: `source_${option}`,
      text: isUnavailable ? `${labels[option]} (${t('notConnected')})` : labels[option],
      checked: source === option,
      enabled: !isUnavailable,
      action: () => setSource(option),
    } as CheckMenuItemOptions);
  });

  return items;
}
