# AI Agent 协作规则

## 系统架构（强制对齐）

执行面迁移到独立云环境、Runtime 抽象、Workspace 存储、Preview/Deployment 服务等所有后端实现，必须以 **`docs/Architecture.md`** 为唯一规范。开发或评审相关代码前须阅读该文档；任何直接依赖本机 FS/PTY 的假设仅限 Local 实现内部。

**状态存储（强制）**：禁止引入 Redis 等额外中间件。热路径用进程内内存；需持久化或跨实例共享的状态写入 PostgreSQL。细则见 `.cursor/rules/no-redis-pg-persistence.mdc`。

## 前端 UI

`web/` 的布局、组件与交互以根目录 **`DESIGN.md`** 为唯一规范入口（Console 面、对齐 ParaRouter `DESIGN.md`）；完整细则见 **`docs/Designs.md`**。实现或评审前端前须阅读上述文档；**勿在本文重复 UI 细则。**

**下拉框（强制）**：禁止使用原生 HTML `<select>` / `<option>`。单选用 `web/src/components/SelectMenu.jsx`，多选用 `web/src/components/MultiSelectMenu.jsx`；样式与交互见 `DESIGN.md` 与 `docs/Designs.md`。

**弹窗首项聚焦（强制）**：打开含文本输入的 Dialog / Modal 时，主输入框须在打开后自动获得焦点（`autoFocus` 或等效 `ref` + `focus()`），用户无需再用鼠标点击即可输入。新建 Workspace、新建 Session、配置表单等场景均适用。

**异步操作反馈（强制）**：会触发网络请求或耗时操作的按钮、表单提交须立即进入 loading 态：`disabled` 防重复提交，文案切换为进行中（如「Signing in…」）或 spinner（图标按钮用同尺寸 `Loader2` 原位替换），请求结束后再恢复。细则见 `DESIGN.md` § 异步与加载。

**按钮聚焦样式（强制）**：所有 `<button>` 点击或键盘聚焦时**不得**出现外框 / focus ring。统一使用 `consoleTheme.js` 的 `consoleButtonFocusClass`，或 `buttonStyles.js` 的 `buttonBase`（已内置无 ring）；禁止在按钮上单独加 `focus:ring-*`。文本输入框、下拉菜单等表单控件可保留聚焦边框以提示输入位置。

Agent 领域说明与架构对齐要求见 **`docs/agents.md`**（Gateway 反代见 **`docs/LlmProxy.md`**；内含对 Architecture.md 的引用）。

用户、角色、配额与运维 CLI 见 **`docs/UserManagement.md`**。Desktop / 原生客户端 HTTP+WS 接入见 **`docs/ApiClient.md`**。

## 国际化（i18n）

中英双语支持基于 **i18next + react-i18next**。翻译资源位于 **`shared/i18n/`**，三端（`web/`、`desktop/`、`server/`）共享同一组 JSON 文件。

**强制规则**：

- **新组件必须使用 `t()`**：用户可见文本一律通过 `useTranslation()` 的 `t()` 获取，禁止硬编码英文/中文字符串。
- **翻译文件位置**：`shared/i18n/en/*.json` 和 `shared/i18n/zh/*.json`，按命名空间分文件（`common`、`auth`、`sessions`、`agents`、`users`、`settings`、`gateway`、`workspace`、`git`、`images`、`deploy`、`errors`）。
- **key 命名**：点分命名空间，如 `t('sessions:launch.title')`；插值用 `{{name}}`；复数用 `_one`/`_other` 后缀。
- **不翻译的内容**：Agent 名称（Kimi Code、Claude Code）、API Key 字段名（OPENAI_API_KEY）、品牌名（AgentHarness）、错误 code（`quota_exceeded`）、已是中文的文案（DeployPanel、twoStage 进度消息、REAUTH 消息）。
- **后端错误**：`error` 字段返回翻译后文本（通过 `t('errors:code', params, locale)`），`code` 字段返回机器可读标识符；前端逻辑分支基于 `code`，展示基于 `error`。
- **语言切换**：Settings → Language，用 `SelectMenu`（非原生 `<select>`），切换后 `localStorage.setItem('xe_locale', locale)` + `i18n.changeLanguage()`。
- **API 请求**：`apiFetch` 自动附带 `Accept-Language` header，后端 `preHandler` 解析注入 `request.locale`。
