# XEnsemble UI Design

**Console UI 完整规范**（根目录 [`DESIGN.md`](../DESIGN.md) 为 Agent/规则入口；本文为细则正文，对齐 [ParaRouter DESIGN.md](https://github.com/EeroEternal/ParaRouter/blob/main/DESIGN.md) 的 Console 面）。后端系统架构以 `docs/Architecture.md` 为唯一规范；`docs/agents.md` 与 `AGENTS.md` 仅引用 `DESIGN.md`，不重复细则。

## Surface：Console

Agent 控制台、Settings 弹窗、Registry 等 authenticated 页面均属 Console。

- **主色**：黑 / zinc（`bg-black`、`bg-zinc-900`），不用紫色营销色。
- **密度**：页面 `space-y-6`；标题 `text-2xl font-bold text-zinc-900`。
- **圆角**：控件 `rounded-md`；卡片/表格/弹窗 `rounded-lg`。
- **壳层**：`max-w-[1600px]` + `px-4 sm:px-6 lg:px-8`，主区 `py-8`（见 `appShellLayout.js`）。

## 实现对照（ParaRouter → XEnsemble）

| 能力 | 文件 |
|------|------|
| Token | `web/src/lib/consoleTokens.js`、`consoleTheme.js` |
| 状态徽章 | `web/src/components/StatusBadge.jsx`（含 `STATUS_TONES`） |
| 表单标签 | `FormLabel`（`consoleFormLabelClass`） |
| 多行输入 | `Textarea`（同 `Input` / `consoleInputClass`） |
| 结构化弹窗 | `ConsoleStructuredDialogHeader` / `Body` / `Footer` |
| 按钮 | `Button`、`buttonStyles.js`；图标按钮 `consoleIconButtonClass` / `consoleIconButtonDangerClass` |
| 输入 | `Input` |
| 页头 | `PageHeader` |
| 弹窗壳 | `ConsoleDialog` + `consoleDialogSmClass` / `Md` / `Lg`（backdrop `bg-black/50`，无 blur） |
| Settings | `SettingsModal` + `SettingsShell` + 各 `*SettingsPanel` |
| 下拉 | `SelectMenu`（样式同 console input） |
| 多选下拉 | `MultiSelectMenu`（勾选列表，样式同 `SelectMenu`） |
| Toast | `Toast` / `useToast`（视觉同 ParaRouter `ActionToast`：顶部居中、图标） |

## 按钮

- **主操作**（Save、Add Agent、Add provider、表单 Submit / Cancel）：`Button` + 文案；`variant="primary"` 或 `secondary`。
- **图标按钮**（工具栏、Settings 卡片内联、**列表行内操作**、**表单内辅助操作**（Test connection、Fetch models 等）、表格 Actions 列、Preview 控件）：**仅图标**，禁止图标与文字并排（如 ~~Configure~~、~~Edit~~、~~Test connection~~、~~Fetch models~~）。
- 样式：`consoleIconButtonClass`；**破坏性操作**（删除、卸载等）用 `consoleIconButtonDangerClass`（`Trash2` 图标）。深色终端工具栏（Preview）可用本地变体（如 `text-zinc-400 hover:bg-zinc-800`）。
- **破坏性图标按钮配色**：默认灰（与普通图标按钮一致），**hover 才变红**（`hover:text-red-700 hover:bg-red-50`）——避免整页红点密集、红色失去警示意义；仅右键菜单（context menu）中的删除项默认红（对齐 macOS / VS Code）。
- 图标尺寸：表格 / 列表行内 / 表单辅助区 `w-3.5 h-3.5`；Settings 卡片工具条 `w-4 h-4`。
- 必须同时提供 `title`（hover 提示）与 `aria-label`（读屏）；进行中用 `Loader2` + `animate-spin` 替换图标，`title` 用进行时（如 `Starting…`、`Removing…`）。
- **常用图标语义**：编辑 `Pencil`、删除 `Trash2`、刷新/重试/测连 `RefreshCw`、拉取列表 `List`、启动 `Play`、停止 `Square`、暂停 `Pause`、恢复 `Play`、配置 `Settings2`。
- **列表行内**（如 Gateway Provider 行的 Test / Edit / Remove）：与 Admin 表格 Actions 同一套规则，禁止文字链或 ghost 文字按钮。

## Toast

操作反馈与提示信息（成功、失败、警告）**统一**使用 `useToast('success'|'error', message)`：顶部居中弹出、带图标、约 4s 自动消失（实现见 `Toast.jsx`，视觉对齐 ParaRouter `ActionToast`）。

- **必须 toast**：API 操作结果、部署/保存失败、Preview 失败详情等一切需用户注意的反馈文案。
- **禁止内联提示条**：不得在页面区域、弹窗内、面板内用红/绿 banner 或 `text-red-*` 条展示上述反馈（Settings、Preview、表单提交等一律 toast）。
- **可与 UI 状态并存**：如 Preview `FAILED` 徽章可保留作持久状态指示，但**错误详情**仍走 toast，不在终端区重复展示文案。

## 表单

- 用户可见标签：人类可读（如 **Router Base URL**），**不展示** `LLM_ROUTER_URL` 等 env 名。
- 分区标签：`text-xs font-semibold uppercase tracking-wider text-zinc-500`。
- 密钥输入：`Input` + `font-mono`。

## 多选下拉（MultiSelectMenu）

组件 `MultiSelectMenu`；触发器样式同 `SelectMenu` / console input。下拉列表 `createPortal` 至 `document.body`，层级 `consoleMenuDropdownZClass`（`z-[110]`，高于弹窗 `z-[101]`）。

### 全选控件

- 启用 `showSelectAll` 且传入 `label` 时，**标签行**为 `flex justify-between`：左侧字段标签，右侧 **checkbox + `Select all` 文案**（`text-xs text-zinc-600`）。
- 勾选「Select all」：值为全部选项 ID，**下拉触发器置灰禁用**（`bg-zinc-100 text-zinc-400`），触发器内仍显示 `placeholder`，**不**展示 `All agents` 等汇总文案。
- 取消勾选：清空选择，下拉恢复可用，用户逐项勾选 Agent。

### 选项列表

- 仅展示各可选项，独立勾选/取消，样式与 `SelectMenu` 选项一致。

### 触发器摘要

| 状态 | 展示 |
|------|------|
| Select all 已勾选 | `placeholder`（置灰） |
| 未选 | `placeholder` |
| 部分/自定义选中 | 最多 2 项标签 + `+k` |

### 新建 vs 编辑默认值

授予类多选（Agent access 等）在 **创建** 场景默认 **全选当前可用项**，减少管理员逐步勾选；**编辑** 场景保留已存授权，不自动改写。

实现：`UsersAdmin` 打开 Create 时 `agent_ids` 初始化为全部 Agent ID；Agent 列表晚于弹窗到达时补填一次（用户已手动改动则不覆盖）。

## 弹窗（ConsoleDialog）

所有 Console 弹窗统一 `ConsoleDialogBackdrop` + `ConsoleDialogPanel`（或等价样式）。**禁止**让弹窗撑满页面壳层宽度。

### 尺寸档位

| 档位 | 宽度 | 用途 | Token |
|------|------|------|-------|
| sm | `max-w-sm`（384px） | 确认、简短单步操作（删除、Launch session） | `consoleDialogSmClass` |
| md | `w-[480px]` | 标准表单（Settings、用户创建/编辑、Agent 配置） | `consoleDialogMdClass` |
| lg | `w-[560px]` | 字段多、含分区卡片的长表单（仅 md 不够时） | `consoleDialogLgClass` |

- **基类** `consoleDialogPanelClass` 不含 `w-full`；宽度由档位 token 或调用方 `className` 指定。
- **响应式**：各档位均加 `max-w-[calc(100vw-2rem)]`；内容可滚动时加 `max-h-[calc(100vh-2rem)] overflow-y-auto`。
- **外层容器**：`fixed inset-0 z-[100+] flex items-center justify-center p-4 pointer-events-none`；面板 `pointer-events-auto`。
- **禁止**：无 `max-width` 的 `w-full`、继承页面 `max-w-[1600px]` 壳层宽度、弹窗内表单字段随容器无限拉伸（多列 grid 用 `sm:grid-cols-2` 等约束列数，数字类短字段勿单行四列撑满宽屏）。

### 内边距与结构（对齐 ParaRouter DESIGN.md § Modals）

**简单弹窗**（确认、短表单）：`p-6`；标题 `font-bold text-lg text-zinc-900 mb-4`。

**结构化弹窗**（Provider、Gateway 配置、长表单）：使用 `ConsoleStructuredDialogHeader` / `Body` / `Footer` + `consoleStructuredDialogPanelClass`：

1. **Header**：`px-5 py-4 border-b border-zinc-200` — 标题 + 可选 subtitle `text-xs text-zinc-500`
2. **Body**：`px-5 py-5 space-y-4`，可滚动 `console-scroll-hidden` 或 `scrollbar-hover`
3. **Footer**：`border-t border-zinc-200 px-6 py-4 bg-zinc-50/80` — Cancel `Button variant="secondary" size="sm"` + 主操作 `size="sm"`

表单字段：`FormLabel` + `Input` / `Textarea`（`consoleInputClass`）；分区卡片 `consoleCardClass bg-zinc-50/70 p-4`。

## Settings 弹窗

**唯一 Settings 入口**：顶栏 `UserMenu`（账户头像）→ **Settings**，打开 `SettingsModal`。**禁止**独立 Settings 页面或顶栏 Settings 链接；历史路由 `/settings`、`/admin/platform` 重定向至 `/console`。

### 壳层

- 组件：`SettingsModal`（`ConsoleDialogBackdrop` + `ConsoleDialogPanel`）+ `SettingsShell`（左侧 Tab + 右侧面板）。
- 档位：**800px** 宽（`w-[800px]` + `consoleDialogPanelClass`），高度 **600px** 固定（`h-[600px]`，小屏 `max-h-[calc(100vh-2rem)]` 收缩）。
- 标题栏：左上 **Settings** + 右上关闭（`X`）；`Escape` / 点击 backdrop 关闭。
- 内层：`SettingsShell` 占满标题栏下方区域，`rounded-lg border` 分隔 Tab 与内容。

### 左侧 Tab

- 宽 **128px**（`w-32`），`bg-zinc-50` + `border-r`；选中 `consoleSettingsTabActiveClass`（`bg-black text-white`），未选 `consoleSettingsTabIdleClass`。
- 所有已登录用户：**General** · **Quota**。
- 所有用户：**BYOK**（用户自带密钥，供 BYOK 模式 Agent 使用）。
- `role === 'admin'` 额外 **Gateway**（共享路由器与上游 Provider；按 Agent 在 Agents 页选择 BYOK/Gateway）。

### 右侧面板

| Tab | 组件 | 内容 |
|-----|------|------|
| General | `GeneralSettingsPanel` | 普通用户：说明文案；**admin**：注册模式、默认用户配额（`grid-cols-2`）、Session TTL + Save（**无**全局 LLM auth 切换，BYOK/Gateway 仅在 Agents 页按 Agent 配置） |
| Gateway | `GatewaySettingsPanel` | 仅 admin：Gateway 摘要 + 图标按钮（Configure / Start / Stop / Restart）+ Provider 列表（Name / Status / Actions 三列；Status 用固定徽章槽，验证中 spinner 占位不挤动列宽；行内 Test / Edit / Remove 为图标；Add/Edit 弹窗内 Test connection / Fetch models 亦为图标；页级 **Add provider** 与弹窗 Save/Cancel 保留文案）；嵌套 `ConsoleDialogShell`（`z-[110+]`，`consoleStructuredDialogPanelClass`），禁止平铺长表单 |
| BYOK | `AgentSettingsPanel` | 用户自带各 Agent API 密钥 |
| Quota | `QuotaSettingsPanel` | 只读用量条（Workspaces / Sessions / Previews X/Y）+ resource tier；非 admin 且无 Agent 授权时琥珀提示条 |

- 右区唯一滚动层：`consoleSettingsPanelScrollClass`（`px-5 py-4`、`overflow-y-auto` + `console-scroll-hidden`，滚动条视觉隐藏）；**子面板禁止**再嵌套 `overflow-y-auto`。
- 含 Save 的 Tab 表单用 `h-full flex flex-col`，字段区 `flex-1 min-h-0`（不设内层滚动）、按钮 `justify-end` 贴底。
- 保存成功/失败一律 `useToast`；**禁止**面板内联 banner。

## 表格（列表）

Admin 与 Console 中的数据表格（`consoleTableShellClass` 等）须遵守：

- **一列一项**：每个表头对应单一语义单元（状态、版本、路径、配额 tier 等）；**禁止**在同一单元格内纵向叠放两行及以上独立信息（如 Status 徽章 + 版本号、主标题 + 副标题折行成「折叠」效果）。
- 复合标识（如 Name + ID）若必须同格展示，主名一行、ID 一行仅作该列的附属标注；其余字段一律拆列。
- 单元格内容超出列宽时用 `truncate` + `title`，不在格内换行堆叠第二项。
- **页面稳定性**（详见根目录 `DESIGN.md` § 页面稳定性）：Status / Actions 列宽固定；状态徽章用 `consoleStatusBadgeClass` 预留图标槽；行内 loading 用同尺寸 spinner 原位替换，禁止验证/保存时整表或整列横向位移。

## 状态徽章（StatusBadge）

统一组件 `web/src/components/StatusBadge.jsx`，所有列表 / 表格 / 弹窗中的状态徽章**必须复用**，禁止手写徽章样式。

### 用法

```jsx
<StatusBadge tone="success" icon={CheckCircle} label="Active" />
<StatusBadge tone="info" spinning label="Building…" />   // loading 态，spinner 占图标槽
<StatusBadge tone="neutral" icon={Clock} label="Not verified" title="详情 tooltip" />
```

### 色系（`STATUS_TONES`）

| tone | Tailwind | 语义 |
|------|----------|------|
| `success` | `bg-emerald-50 text-emerald-700 border-emerald-200` | 就绪 / 正常（Active、Installed、Ready、Available） |
| `warning` | `bg-amber-50 text-amber-700 border-amber-200` | 待处理 / 未就绪（Pending、Not installed、Queued） |
| `danger` | `bg-red-50 text-red-700 border-red-200` | 失败 / 停用（Failed、Suspended、Unavailable） |
| `info` | `bg-blue-50 text-blue-700 border-blue-200` | 进行中（Building、Verifying） |
| `neutral` | `bg-zinc-100 text-zinc-600 border-zinc-200` | 未知 / 未验证（Not verified） |

### 状态 → 图标语义

| 状态 | 图标 |
|------|------|
| active / installed / ok | `CheckCircle` |
| pending / not installed / queued / not verified | `Clock` |
| suspended | `Pause` |
| failed / error | `XCircle` |
| building / testing / verifying（进行中） | `Loader2` + `animate-spin`（走 `spinning` prop） |

### 结构约定

- 宽度随文案自适应（`text-xs whitespace-nowrap`），**不设**固定 `min-width`；短词（Active / Ready）不撑满列。
- **图标槽固定** `consoleStatusIconSlotClass`（`w-3 h-3 shrink-0`）：loading 时 `Loader2` 原位替换图标，其余状态保留空槽占位，**文案/图标切换不得引起列宽跳动**。
- 破坏性状态（`danger`）不另加红色 border 描边，统一走 `STATUS_TONES`。

## Agents（Admin）

实现 `AgentsAdmin.jsx`（路由 `/admin/agents` 或顶栏 **Agents**）。

- 布局：`PageHeader` + 表格；**禁止**在页面内平铺新增/编辑表单卡片。
- **禁止页面级纵向滚动条**：Shell `main` 对 Admin 页使用 `min-h-0 overflow-hidden`（`adminPage`）；页面根 `consoleAdminPageClass`，表格区 `consoleAdminTableShellClass` + `consoleAdminTableScrollClass`（`console-scroll-hidden`）。视口右侧不得出现浏览器/main 滚动条；行数超出时仅在表格容器内滚动且滚动条视觉隐藏。
- 弹窗表单（Add Agent、Edit executable、Keys）：**禁止**在弹窗面板或表单区域使用 `overflow-y-auto` / 纵向滚动条；内容随弹窗自然展开，不设 `max-h` 限高滚动。面板沿用 `consoleDialogPanelClass` 的 `overflow-hidden`。
- 新增：页头 **Add Agent** 打开 `ConsoleDialog`（**md** 档）；字段 `grid-cols-2`（ID、Display name、Command、Arguments JSON、Required env JSON）。
- 表格列：Name/ID、**Status**（Installed / Not installed）、**Version**（已安装 CLI 版本，`v…`；未安装为 `—`）、**Path**、**Executable**、**Auth**（BYOK / Gateway）、**Model**（Gateway 所选模型）、**Ready**（Gateway：Ready / Needs model；BYOK：User keys）、Actions（图标：**Edit** / **Install** 或 **Check & update** · **Uninstall** / **Configure**）。
- Auth / Model 在 Actions → **Configure** 弹窗设置（`PUT /api/v1/admin/agents/:id/gateway-config` 等）；Gateway 模式下 Session 启动使用平台路由器。
- 反馈一律 `useToast`。

## 用户管理（Admin）

规范见 `docs/UserManagement.md`；实现 `UsersAdmin.jsx`；平台配置见上文 Settings → General（admin）。

### `/admin/users`

- 布局同 Agent Registry：`PageHeader` + 表格 + `ConsoleDialog` 弹窗；**禁止**页面内平铺表单。
- 表格：用户名、状态徽章（active/pending/suspended）、用量 P/S/V、配额 tier、授权 Agent 数、最后登录。
- 弹窗（**md** 档）：用户名、密码（新建）、角色、状态、配额 `grid-cols-2`（非四列撑满）、Agent `MultiSelectMenu`（非 admin，`showSelectAll`，创建默认全选）、可选重置密码。
- 行内：编辑、审批（pending）、暂停/恢复。
- 反馈一律 `useToast`。

### Console（普通用户）

- Agent 下拉仅显示 `GET /agents` 授权列表；`agents.length === 0` 时禁用 Launch。
- Session 启动 `agent_not_granted` / `quota_exceeded` 错误在 Launch 弹窗内展示（非 toast）。

### 顶栏导航（admin）

**Users** · **Agents**，与 `UserMenu` 并列；平台策略在 `UserMenu` → Settings → **General**（admin），**不出现在顶栏**。

## 配色

- 背景：壳 `bg-zinc-50`，内容 `bg-white`
- 边框：`border-zinc-200` / `border-zinc-300`
- 主按钮：`Button variant="primary"`
- 输入 focus：`focus:border-black focus:ring-1 focus:ring-black`

## Preview（Console 终端区）

数据与 API 契约见 `docs/Architecture.md` 5.3；实现组件 `PreviewPanel.jsx`。

### Preview 启动契约（`.agents/preview.json`）

**首选**：项目根 `.agents/preview.json`，每个 Workspace 独立一份；Deploy 时优先读取，覆盖同目录 `package.json` scripts。

新建 Workspace 时自动 scaffold 默认契约 + 占位 `index.html`（已有文件不覆盖）。示例见 `docs/examples/.agents/preview.json`。

| 字段 | 必填 | 说明 |
|------|------|------|
| `command` | 是 | 可执行命令（如 `npm`、`npx`、`python3`） |
| `args` | 否 | 参数数组；可用 `$PORT` 引用平台注入的监听端口 |
| `port` | 否 | 文档/默认端口，默认 `5173`；Local 实际端口由 runtime 分配并通过 `PORT` 环境变量注入 |

Node 项目常见写法：`{ "command": "npm", "args": ["run", "dev"], "port": 5173 }`（需 `package.json` 含 `dev` script）。

**Fallback**：无有效 `preview.json` 时，回退 `package.json` 的 `dev` / `start` / `preview` script。

### Console UI

- **位置**：有活跃 session 且绑定 workspace 时，控件在终端工具栏右侧（与 Disconnect / Workspace 图标同组）；Embed iframe 在工具栏下方、终端内容上方。
- **状态徽章**：`pending` / `building` / `amber`、`running` / `green`、`failed` / `red`，字号 `text-[10px] uppercase`。
- **操作**：Deploy preview（`POST /api/v1/projects/:id/preview`）、Stop、Restart、Open（新标签）、Embed（iframe，`h-48`，`sandbox` 含 scripts/forms）；**图标按钮**（见 § 按钮），与工具栏其他操作一致。
- **TTL**：running 时显示 `expires_at` 倒计时（`font-mono text-[10px]`）。
- **错误**：遵 Toast 节；部署/操作失败与 `last_error_message` 用 `useToast('error', …)`，不在终端区内联展示。
- **鉴权 iframe**：`public_url` 追加 `preview_token` query（Gateway 校验 deployment-scoped token，见 Architecture 7）。
