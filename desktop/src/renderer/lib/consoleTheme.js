/** Console tokens — Morandi light theme layer. */

// Primitive tokens
export const bgCanvas = 'bg-[#FFFFFF]';
export const bgContainer = 'bg-[#F7F8F9]';
export const bgSecondary = 'bg-[#F4F5F6]';
export const bgTertiary = 'bg-[#FAFBFC]';
export const bgActive = 'bg-[#E8EAED]';
export const bgInverse = 'bg-[#202124]';

export const textPrimary = 'text-[#202124]';
export const textSecondary = 'text-[#5F6368]';
export const textTertiary = 'text-[#3C4043]';
export const textPlaceholder = 'text-[#9AA0A6]';
export const textInverse = 'text-white';

export const borderHairline = 'border-[#E8EAED]';
export const borderSubtle = 'border-[#DADCE0]';

export const divideHairline = 'divide-[#E8EAED]';

export const accentBlue = 'text-[#5B8DB8] hover:text-[#4A7298]';
export const accentBlueBg = 'bg-[#5B8DB8] hover:bg-[#4A7298]';
export const accentGreen = 'text-[#4A7C59]';
export const accentGreenBg = 'bg-[#E8F5E9]';
export const accentGreenText = 'text-[#4A7C59]';
export const accentRed = 'text-[#C06C5D] hover:text-[#A35A4D]';
export const accentRedBg = 'bg-[#FDECEA] hover:bg-[#FADBD8]';

/** @deprecated Use getTerminalTheme() via useTerminalTheme — kept for legacy imports. */
export {
  XTERM_MINIMUM_CONTRAST_RATIO as xtermMinimumContrastRatio,
  getTerminalTheme,
  getDefaultTerminalThemeId,
} from './terminalThemes.js';

import { getTerminalTheme, getDefaultTerminalThemeId } from './terminalThemes.js';
import { loadTerminalThemeId } from './terminalPrefs.js';

export function getActiveXtermTheme() {
  return getTerminalTheme(loadTerminalThemeId()).xterm;
}

export const xtermTheme = getTerminalTheme(getDefaultTerminalThemeId()).xterm;
export const xtermBackground = xtermTheme.background;

export const panelPadding = 'p-3';
export const headerPadding = 'px-3 py-2';
export const compactRadius = 'rounded-lg';
export const containerRadius = 'rounded-2xl';
export const transitionBase = 'transition-colors duration-150 ease-in-out';

// Hover primitives — keep full class names so Tailwind JIT can discover them
export const hoverBgSecondary = 'hover:bg-[#F4F5F6]';
export const hoverBgCanvas = 'hover:bg-[#FFFFFF]';
export const hoverBgTertiary = 'hover:bg-[#FAFBFC]';
export const hoverBgActive = 'hover:bg-[#E8EAED]';
export const hoverTextPrimary = 'hover:text-[#202124]';
export const hoverTextSecondary = 'hover:text-[#5F6368]';

// Composite tokens
export const consoleBackdropClass = 'fixed inset-0 bg-black/50 transition-opacity';

export const consoleDialogPanelClass =
  `relative ${bgCanvas} border ${borderHairline} shadow-sm rounded-lg ${textPrimary} text-left flex flex-col overflow-hidden`;

/** Dialog width tiers — see docs/Designs.md § 弹窗 */
export const consoleDialogSmClass =
  `${consoleDialogPanelClass} w-full max-w-sm max-w-[calc(100vw-2rem)]`;

export const consoleDialogMdClass =
  `${consoleDialogPanelClass} w-[480px] max-w-[calc(100vw-2rem)]`;

export const consoleDialogLgClass =
  `${consoleDialogPanelClass} w-[560px] max-w-[calc(100vw-2rem)]`;

/** Structured form dialog (header / body / footer) — ParaRouter DESIGN.md § Modals */
export const consoleStructuredDialogPanelClass =
  `${consoleDialogMdClass} flex flex-col max-h-[90vh] overflow-hidden p-0`;

export const consoleStructuredDialogHeaderClass =
  `px-4 py-3 border-b ${borderHairline} shrink-0 ${bgCanvas}`;

export const consoleStructuredDialogBodyClass =
  'flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4 console-scroll-hidden';

export const consoleStructuredDialogFooterClass =
  `border-t ${borderHairline} px-4 py-3 ${bgTertiary} flex justify-end gap-2 shrink-0`;

/** Admin agent form dialogs: height follows content, no inner scroll — see docs/Designs.md § Agents */
export const consoleDialogAdminFormPanelClass =
  `relative ${bgCanvas} border ${borderHairline} shadow-sm rounded-lg text-left w-[480px] max-w-[calc(100vw-2rem)]`;

export const consoleInputClass =
  `w-full ${bgCanvas} border ${borderSubtle} rounded-md px-3 py-2 text-sm ${textPrimary} placeholder:${textPlaceholder} focus:outline-none focus:border-[#5B8DB8] focus:ring-1 focus:ring-[#5B8DB8] transition-colors duration-150 ease-in-out`;

export const consoleToolbarControlClass = 'h-9 min-h-9 text-sm';

export const consoleToolbarInputClass = `${consoleInputClass} ${consoleToolbarControlClass} py-1.5`;

export const consolePageStackClass = 'space-y-6';

export const consolePageTitleClass = `text-2xl font-bold tracking-tight ${textPrimary}`;

/** Admin registry pages (Agents / Users): fill shell main, no page-level scrollbar */
export const consoleAdminPageClass = 'flex h-full min-h-0 w-full flex-col gap-6';

/** Console tool surface: workspace sidebar + terminal fill the shell main */
export const consoleToolPageClass =
  `flex h-full min-h-0 w-full flex-col ${bgContainer} ${textPrimary}`;

export const consoleAdminTableScrollClass = 'min-h-0 flex-1 overflow-auto console-scroll-hidden';

export const consoleTableShellClass =
  `${bgCanvas} border ${borderHairline} rounded-lg overflow-hidden shadow-sm`;

export const consoleAdminTableShellClass =
  `${consoleTableShellClass} flex min-h-0 flex-1 flex-col`;

export const consoleTableHeadRowClass = `${bgTertiary} border-b ${borderHairline}`;

export const consoleTableBodyDivideClass = `divide-y ${divideHairline}`;

export const consoleTableBodyRowClass = `hover:${bgTertiary} transition-colors`;

export const consoleTableHeadCellClass =
  `px-4 py-2.5 text-xs font-semibold ${textSecondary} uppercase tracking-wider`;

export const consoleTableBodyCellClass = `px-4 py-3 text-sm ${textTertiary}`;

export const consoleTableHeadCellDenseClass =
  `px-3 py-2.5 text-xs font-semibold ${textSecondary} uppercase tracking-wider`;

export const consoleTableBodyCellDenseClass = `px-3 py-3 text-sm ${textTertiary}`;

export const consoleTableSectionHeaderClass =
  `px-4 py-3 border-b ${borderHairline} flex items-center justify-between`;

export const consoleCardClass = `${bgCanvas} border ${borderHairline} rounded-lg shadow-sm`;

export const consoleFormLabelClass =
  `block text-xs font-semibold uppercase tracking-wider ${textSecondary}`;

/** Alias kept for existing call sites */
export const consoleSectionLabelClass = consoleFormLabelClass;

export const consoleDropdownPanelClass =
  `rounded-lg border ${borderHairline} ${bgCanvas} shadow-sm`;

export const consoleFilterToolbarClass =
  `${bgCanvas} border ${borderHairline} rounded-lg p-4 sm:p-5 shadow-sm space-y-4`;

export const consoleStatValueClass =
  `text-2xl font-bold tracking-tight ${textPrimary}`;

export const consoleEmptyStateClass =
  `flex flex-col items-center justify-center rounded-lg border border-dashed ${borderHairline} ${bgTertiary}`;

export const consoleNavActiveClass = `${bgActive} ${textPrimary}`;

export const consoleNavIdleClass =
  `${textSecondary} hover:${bgSecondary} hover:${textPrimary}`;

export const consoleSettingsTabActiveClass =
  `${bgInverse} ${textInverse} shadow-lg shadow-black/10`;

export const consoleSettingsTabIdleClass =
  `${textSecondary} hover:${bgSecondary} hover:${textPrimary}`;

/** Settings 右侧面板：唯一滚动层，滚动条视觉隐藏 — see docs/Designs.md § Settings */
export const consoleSettingsPanelScrollClass =
  `flex-1 min-h-0 min-w-0 overflow-y-auto console-scroll-hidden ${bgCanvas} px-5 py-4`;

/** Fixed-size status badge slot — prevents column shift when spinner appears (DESIGN.md § 页面稳定性) */
export const consoleStatusBadgeClass =
  'inline-flex items-center gap-1 min-w-[6.5rem] h-4 text-xs';

export const consoleStatusIconSlotClass =
  'inline-flex w-3 h-3 shrink-0 items-center justify-center';

/** Portal dropdowns — above dialog shell (z-101), below toast (z-200) */
export const consoleMenuDropdownZClass = 'z-[110]';

/** Icon-only actions — see docs/Designs.md § 图标按钮 */
export const consoleButtonFocusClass =
  'focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0';

export const consoleIconButtonClass =
  `inline-flex items-center justify-center rounded-md p-1.5 ${textSecondary} hover:${bgSecondary} hover:${textPrimary} disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass} transition-colors duration-150 ease-in-out`;

export const consoleIconButtonDangerClass =
  `inline-flex items-center justify-center rounded-md p-1.5 ${accentRed} hover:bg-[#FDECEA] disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass} transition-colors duration-150 ease-in-out`;
