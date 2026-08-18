# XEnsemble Design System

**Console UI 唯一规范入口**（对齐 [ParaRouter DESIGN.md](https://github.com/EeroEternal/ParaRouter/blob/main/DESIGN.md) 的 Console 面）。`AGENTS.md` 与 Cursor 规则仅指向本文；**完整细则见 [`docs/Designs.md`](docs/Designs.md)**（Settings、Agents、Preview、Toast 等 XEnsemble 扩展均在该文件）。

后端系统架构以 [`docs/Architecture.md`](docs/Architecture.md) 为准；勿在本文重复架构或 API 契约。

## Surfaces

### Console（authenticated）

Agent 控制台、Settings 弹窗、Admin Registry 等。

- **Accent**：black / zinc，不用紫色营销色
- **Palette**：`zinc-*`（不用 `gray-*` / `blue-*` 作 Console chrome）
- **密度**：`consolePageStackClass`（`space-y-6`）；页标题 `consolePageTitleClass`
- **圆角**：控件 `rounded-md`；卡片/表格/弹窗 `rounded-lg`
- **Shadow**：卡片/表格/弹窗 `shadow-sm`
- **Shell**：`appShellLayout.js` — `max-w-[1600px]`、`px-4 sm:px-6 lg:px-8`、`py-8`

### 非 Console

Login 等公开页、终端 Chat 区可有独立密度；**勿**把 Marketing 大圆角/紫色 focus 抄进 Console。

## 实现对照

| 能力 | 文件 |
|------|------|
| Design tokens | `web/src/lib/consoleTokens.js`、`consoleTheme.js` |
| 状态徽章 | `web/src/components/StatusBadge.jsx`（含 `STATUS_TONES`）；token `consoleStatusBadgeClass`、`consoleStatusIconSlotClass` |
| Shell 宽度/内边距 | `web/src/lib/appShellLayout.js` |
| 按钮 | `web/src/components/Button.jsx`、`web/src/lib/buttonStyles.js` |
| 文本输入 | `web/src/components/Input.jsx`（含 `FormLabel`、`Textarea`） |
| 页头 | `web/src/components/PageHeader.jsx` |
| 弹窗 | `web/src/components/ConsoleDialog.jsx`（含 `ConsoleStructuredDialog*`） |
| 下拉 | `web/src/components/SelectMenu.jsx`、`MultiSelectMenu.jsx` |
| Toast | `web/src/components/Toast.jsx` |
| 完整 UI 细则 | **`docs/Designs.md`** |

## 核心原则（ParaRouter Console）

1. **Content first** — 数据与操作优先于装饰
2. **Token reuse** — 用 `consoleTokens` 与共享组件，禁止手写表格/输入样式
3. **表单** — `FormLabel` + `Input`/`Textarea`；密钥 `font-mono`
4. **结构化弹窗** — Header / Body / Footer（见 `docs/Designs.md` § 弹窗）
5. **反馈** — 一律 `useToast`；禁止页面/弹窗内联红绿 banner
6. **页面稳定性** — 见下文 § 页面稳定性；实现新 UI 时必须预留固定尺寸，禁止状态切换导致布局跳动

## 页面稳定性

Console 在加载、验证、路由切换、弹窗开关时**不得出现可感知的布局位移（layout shift）**。设计阶段即预留占位，而非事后补 padding。

### 弹窗

- 打开/关闭：`ConsoleDialogShell` + 固定档位宽度（`consoleDialogMdClass` 等）；backdrop 无 blur；**禁止** `w-full` 撑满壳层
- 结构化弹窗：Header / Footer 固定高度分区；Body 单独滚动，**禁止**整页随内容增高抖动
- 关闭方式：backdrop / Esc / Cancel；**禁止**因出现/消失角标 X 导致标题行重排（Settings 主壳除外）

### 表格与列表

- **列宽固定**：Status、Actions 等窄列用 `<colgroup>` 或 `table-fixed` + 明确宽度；Name 等主列 `min-w-0 truncate`
- **状态徽章**：使用 `consoleStatusBadgeClass` + `consoleStatusIconSlotClass` — 宽度随文案自适应（`text-xs whitespace-nowrap`），**始终保留**固定尺寸图标槽（验证中显示 `Loader2`，其余状态空槽占位），文案/图标切换不得引起列宽跳动
- **行内操作**：图标按钮统一 `w-3.5 h-3.5`；loading 时用同尺寸 `Loader2` **原位替换**，禁止文字按钮与图标按钮混排切换
- **单元格内容**：简短标签 + 详情放 `title` / tooltip；禁止在格内展开长文本撑开列宽

### 异步与加载

- 列表刷新：**原地更新**行数据，不Unmount 整表；保留滚动位置
- 加载态：骨架或 spinner 占位与原内容**同尺寸**，或仅在原区域 overlay
- 筛选/查询：控件宽度固定（`ConsoleSearchField`、`SelectMenu` toolbar 宽度）；结果变化不推动页头换行

### 动画

- 过渡 ≤ `duration-150`；**禁止**用动画掩盖布局变化
- 路由切换（若启用）：仅 fade + 小幅 Y，key 为 `pathname`；query 变化不 re-animate

### 参考实现

- Gateway Provider 表：`web/src/components/settings/GatewaySettingsPanel.jsx` — Status 列固定槽位
- 图标按钮 loading：`Loader2` 替换 lucide 图标，尺寸不变

## 配色（Console）

| 角色 | Tailwind |
|------|----------|
| App shell | `bg-zinc-50` |
| 内容/卡片 | `bg-white` |
| 边框 | `border-zinc-200` / `border-zinc-300`（输入） |
| 主文字 | `text-zinc-900` |
| 次要 | `text-zinc-500` / `text-zinc-600` |
| 主操作 | `Button variant="primary"`（`bg-black`） |
| 输入 focus | `focus:border-black focus:ring-1 focus:ring-black` |
