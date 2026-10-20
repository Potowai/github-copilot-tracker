import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'gct-tray-menu-'));
const loadTypeScriptModule = async (sourceUrl, outputName) => {
  const source = await readFile(sourceUrl, 'utf8');
  const compilation = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (compilation.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${outputName} should transpile`);
  const modulePath = join(temporaryDirectory, outputName);
  await writeFile(modulePath, compilation.outputText, 'utf8');
  return import(pathToFileURL(modulePath).href);
};
const { buildUsageSummaryMenuItems } = await loadTypeScriptModule(
  new URL('../src/tray-menu.ts', import.meta.url), 'tray-menu.mjs',
);
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const appStyles = await readFile(new URL('../src/App.css', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const rustSource = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const tauriConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const windowsTauriConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.windows.conf.json', import.meta.url), 'utf8'));

after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

const labels = { copilot: 'GitHub Copilot', claude: 'Claude' };
const words = {
  aiCredits: 'AI Credits',
  used: 'Used',
  remaining: 'Remaining',
  equivalentValue: 'Equivalent value',
  license: 'License',
  billing: 'Billing',
  resets: 'resets',
  usageUnavailable: 'unavailable',
  notConnected: 'not connected',
  showUsageFor: 'Show usage for',
};
const translate = (key) => words[key] ?? key;
const buildItems = (state, source = 'copilot', onSource = () => {}) =>
  buildUsageSummaryMenuItems(state, source, labels, translate, onSource);
const byId = (items, id) => items.find((item) => item.id === id);

test('shows both providers at enabled contrast while usage rows remain actionless', () => {
  let selectedSource;
  const items = buildItems({
    copilot: {
      premiumUsed: 7,
      premiumLimit: 50,
      premiumRemaining: 43,
      currencyEquivalent: '€0.07',
      billingCycleEnd: '31/10/2026',
      plan: 'Copilot Pro',
      organizations: ['Example Org'],
    },
    claude: {
      windows: [
        { label: 'Session (5h)', percent: 31, resetsAt: 'in 2 hours' },
        { label: 'Weekly', percent: 12, resetsAt: null },
      ],
    },
    claudeSubscriptionType: 'max',
    language: 'en',
    claudeAvailable: true,
    copilotAvailable: true,
  }, 'copilot', (next) => { selectedSource = next; });

  for (const id of [
    'copilot_header', 'usage_header', 'usage_used', 'usage_remaining',
    'usage_currency_equivalent', 'usage_billing_cycle', 'usage_plan', 'claude_header',
    'claude_subscription', 'claude_window_0', 'claude_window_1', 'source_header',
  ]) {
    const row = byId(items, id);
    assert.equal(row?.enabled, true, `${id} should use normal text contrast`);
    assert.equal(typeof row?.action, 'function', `${id} should have an inert action`);
    row.action();
  }
  assert.equal(selectedSource, undefined, 'usage rows must not change the selected source');
  assert.equal(byId(items, 'usage_used').text, '    Used: 7 / 50');
  assert.equal(byId(items, 'usage_currency_equivalent').text, '    Equivalent value: €0.07');
  assert.equal(byId(items, 'usage_billing_cycle').text, '    Billing: 31/10/2026');
  assert.equal(byId(items, 'usage_plan').text, '    License: Copilot Pro (Example Org)');
  assert.equal(byId(items, 'claude_window_0').text, '  Session (5h): 31%, resets in 2 hours');
  assert.equal(byId(items, 'claude_window_1').text, '  Weekly: 12%');

  assert.equal(byId(items, 'source_copilot').enabled, true);
  assert.equal(byId(items, 'source_claude').enabled, true);
  byId(items, 'source_claude').action();
  assert.equal(selectedSource, 'claude');
});

test('shows disconnected provider states with inert usage rows', () => {
  const items = buildItems({
    copilot: null,
    claude: null,
    claudeSubscriptionType: null,
    language: 'en',
    claudeAvailable: false,
    copilotAvailable: false,
  });

  assert.equal(byId(items, 'copilot_unavailable').text, '  not connected');
  assert.equal(byId(items, 'claude_unavailable').text, '  not connected');
  assert.equal(byId(items, 'copilot_unavailable').enabled, true);
  assert.equal(byId(items, 'claude_unavailable').enabled, true);
  assert.equal(typeof byId(items, 'copilot_unavailable').action, 'function');
  assert.equal(typeof byId(items, 'claude_unavailable').action, 'function');
  assert.equal(byId(items, 'source_copilot').enabled, true);
  assert.equal(byId(items, 'source_claude').enabled, false);
});

test('distinguishes a connected provider with no fresh usage data', () => {
  const items = buildItems({
    copilot: null,
    claude: null,
    claudeSubscriptionType: 'pro',
    language: 'en',
    claudeAvailable: true,
    copilotAvailable: true,
  });

  assert.equal(byId(items, 'copilot_unavailable').text, '  unavailable');
  assert.equal(byId(items, 'claude_unavailable').text, '  unavailable');
  assert.equal(byId(items, 'copilot_unavailable').enabled, true);
  assert.equal(byId(items, 'claude_unavailable').enabled, true);
  assert.equal(byId(items, 'source_claude').enabled, true);
});

test('native tray left-click release shows and focuses the widget', () => {
  assert.equal(tauriConfig.app.trayIcon.id, 'main');
  assert.equal(tauriConfig.app.trayIcon.showMenuOnLeftClick, false);
  assert.equal(tauriConfig.app.trayIcon.iconPath, 'tray-icon-light.png');
  assert.equal(windowsTauriConfig.app.trayIcon.iconPath, 'tray-icon-yellow.png');
  assert.match(rustSource, /include_bytes!\("\.\.\/tray-icon-yellow\.png"\)/);
  assert.match(rustSource, /\.on_tray_icon_event\(\|app, event\|/);
  assert.match(rustSource, /TrayIconEvent::Click\s*\{\s*button:\s*MouseButton::Left,\s*button_state:\s*MouseButtonState::Up/);
  assert.match(rustSource, /app\.get_webview_window\("main"\)/);
  assert.match(rustSource, /window\.show\(\)/);
  assert.match(rustSource, /window\.set_focus\(\)/);
});

test('JavaScript attaches its menu to the native tray instead of creating another tray', () => {
  assert.match(mainSource, /TrayIcon\.getById\('main'\)/);
  assert.match(mainSource, /await tray\.setMenu\(menu\)/);
  assert.doesNotMatch(mainSource, /TrayIcon\.new\(/);
});

test('details excludes Claude and provider tabs and shows resize feedback', () => {
  assert.doesNotMatch(appSource, /sourcePicker|source-picker|source-tab/);
  assert.doesNotMatch(appSource, /<h1>\{t\('claudeUsage'\)\}<\/h1>/);
  assert.doesNotMatch(appSource, /className="claude-window"/);
  assert.doesNotMatch(appStyles, /\.claude-window/);
  assert.doesNotMatch(appStyles, /\.details-panel\s+\.progress-fill\.claude/);
  assert.match(appSource, /window\.addEventListener\('resize'/);
  assert.match(appStyles, /\.widget-shell\.is-resizing \.usage-pill/);
  assert.match(appStyles, /\.resize-affordance/);
  assert.match(appSource, /startResizeDragging\('SouthEast'\)/);
  assert.match(appSource, /aria-label=\{t\('resizeWidget'\)\}/);
  assert.match(appStyles, /@container usage-pill \(max-width: 280px\)[\s\S]*?\.pill-meter\s*\{\s*display: none;/);
});
