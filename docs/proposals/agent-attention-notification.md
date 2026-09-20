# Agent 注意力通知(消息提示)设计方案

> 分层:L1 代理协议信号 + L3 屏幕启发式(本期)。L2 agent 专有集成(MCP / 私有 API / hooks)**本期不做**——各 agent 能力不一,抽象成本高、覆盖参差,仅留扩展点(§9)。
> 前端提示面(v2 修订):收敛为**全局铃铛通知中心**,不做列表徽章 / 视图横幅矩阵 / 浏览器通知。
> 状态:设计稿,未实现。

## 0. 背景与目标

Agent 任务执行完成 / 等待用户确认、以及新 skill 提炼完成时用户无感知(skill 入口挪入设置后,原主页面的数量展示也没了)。目标:

- 页面**右上角常驻铃铛图标**;有通知时铃铛以**红色数字角标**显示未读数;
- 点击铃铛展开**通知面板**:未读消息右侧**红点**;面板顶部**「全部已读」**按钮;
- **点击消息跳转对应页面**(session 通知 → 该 session 界面;skill 通知 → 设置内 Skills 页);
- **agent 无关**:不依赖任何 agent 私有 API;只依赖 LLM 网关协议流量(L1)与终端画面形状(L3)。

语义边界:「input_stalled」(你的话没送到,通道问题)不走铃铛,仍走会话内黄条;铃铛承载**业务事件**(完成 / 待输入 / 新 skill)。

非目标(本期):浏览器 Notification、标签页标题闪烁、声音、列表徽章、L2。

## 1. 分层定义、现状与依据

### L1 代理协议信号(第一层)
- **依据**:所有对话流量都经过平台 UniGateway(`docs/LlmProxy.md`),网关侧看到的 tool_call / assistant 事件流是 agent 无关的。
- **已有设施**:`server/src/llm/chatTranscript.js` —— `append / subscribe / getHistory / getHistoryForSessions`,每会话环形缓冲(500 条)+ PG 持久化 + seq 去重;`server.js:1943` 已把条目经终端 WS 以 `chat_event` 推给前端。
- **已有解析**:`web/src/lib/chatPrompt.js` 的 `parseQuestionTool(tool, content)` 能按形状识别 Claude Code `AskUserQuestion`、Cline `ask_followup_question`、通用 `{question, options}`,不依赖工具名白名单(形状优先)。
- **局限**:BYOK 直连(流量不过网关)时 L1 缺席 → 由 L3 兜底。

### L3 屏幕启发式(第三层)
- **已有设施**:`detectTuiPrompt(lines)`(yesno / select / continue 三类,保守策略,`TUI_QUESTION_RE` 问句语境约束)、`readScreenLines(term)`;ChatView 已用 headless xterm + 400ms debounce 接入。
- **本期扩展**:同一套规则抽到 `shared/`,服务端对 TranscriptStore 的输出尾部跑「无头版」(strip-ANSI 后扫描),覆盖"没有视图打开"的场景。

### L2(agent 专有 API)——本期不做
各 agent 能力差异大(hooks / VSCode API / MCP 可用性不同),不在本期抽象。预留 `reportExternalSignal` 注入口(§9)。

## 2. 核心抽象:会话注意力状态(AttentionState)

服务端权威单值,每会话一条:

```js
{
  state: 'working' | 'waiting_user' | 'stalled' | 'ended',
  since: <ms>,            // 进入当前态的时间
  source: 'L1' | 'L3' | 'L1+L3',
  reason: '...',          // 证据快照:问题文本截断 / 命中的屏幕行,供 tooltip 与通知正文
}
```

状态机:

```
working ──S1/S5(检测到 prompt,含稳定窗)──▶ waiting_user
working ──S3(输出+事件静默 > T_quiet)─────▶ stalled
waiting_user ──S2(answer / 用户输入 / 'in' 帧)──▶ working
stalled ──任何输出 / 输入──▶ working
任意 ──exit──▶ ended ;spawn / attach ──▶ working
```

冲突裁决:**L1 > L3**(结构化信号优先);L1 报 waiting 而 L3 无画面特征时仍置 waiting(网关看到 question 调用即事实)。

**通知触发**:迁移到 `waiting_user` / `ended` 时产生通知(§4);`stalled` 本期只更新状态、不产生通知(通道类噪音不进铃铛);同会话同类型存在未读通知时**覆盖更新**(防轰炸)。

## 3. 信号清单

| 编号 | 层 | 信号 | 动作 |
|---|---|---|---|
| S1 | L1 | `parseQuestionTool(tool, content)` 非空(question 工具调用 open) | → waiting_user(高置信) |
| S2 | L1 | answer / tool_result / 下一轮 assistant 事件 | 清除 waiting_user → working |
| S3 | L1 | 事件流静默 > T_quiet(90s)且无 prompt 特征 | → stalled(「疑似卡死」,联动心跳/input_stalled 语义) |
| S4 | L1 | assistant 回合完结且无后续 tool_call | 会话空闲 → `session_completed` 通知 |
| S5 | L3' | 服务端:TranscriptStore 尾部 4KB → strip-ANSI → 移植版 detectTuiPrompt,连续 2 次扫描(≥2s)一致才翻转 | → waiting_user / 清除 |
| S6 | L3 | 客户端视图内:ChatView 已有(headless xterm);phase 2 扩展 AgentConsole(真实 xterm 同库直扫) | 视图内展示 / 可选上报校正 |
| S7 | 业务 | `conversationExtractor` 提炼产出新 skill(status='draft', source='auto') | → `skill_created` 通知 |

防误报(继承 chatPrompt 现有保守性):y/n、≥2 编号选项 + 问句语境、❯/› 光标 + 问句语境、Press Enter + 问句语境;spinners/footer/命令面板因语境约束不触发。

## 4. 通知数据模型(跨刷新持久化,PG)

未读红点 / 角标数必须跨刷新、跨标签存活 → **PG `notifications` 表**(遵守 no-redis 规则;走 `db/migrations` 编号迁移):

```js
notifications = pgTable('notifications', {
  id:        text('id').primaryKey(),                    // ntf_<hex>
  userId:    text('user_id').notNull().references(users.id, { onDelete: 'cascade' }),
  type:      text('type').notNull(),                     // 'session_completed' | 'session_waiting' | 'skill_created'
  payload:   jsonb('payload').notNull().default({}),     // { sessionId, sessionName, workspaceId, workspaceName, skillId, skillTitle, agentName, reason }
  readAt:    bigint('read_at', { mode: 'number' }),      // NULL = 未读(红点依据)
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('idx_notifications_user_unread').on(t.userId, t.readAt, t.createdAt),
  index('idx_notifications_user_created').on(t.userId, t.createdAt),   // 列表游标分页用
]);
```

设计要点:
- **正文不落库,落结构化 payload**:文案由前端 `t()` 渲染(i18n key + `{{workspace}}` / `{{session}}` 插值),符合仓库 i18n 规范;workspaceName / sessionName 存**时间点快照**,会话改名/删除后文案不悬空;
- **去重/防轰炸**:同会话同类型未读通知存在时覆盖更新;
- **上限与清理(写入时裁剪,无定时任务)**:每用户硬上限 **200 条**;超出时先删**最旧的已读**,仍超出再删**最旧的未读**(未读尽量保留,极端堆积下有兜底)。上限由写入路径保证,无需 cron;后续若加全局清理任务属可选增强;
- 触发点:`attentionService` 状态迁移回调 + `conversationExtractor` 产出 skill 处(服务端单点,幂等)。

通知类型 → 跳转:

| type | 文案(zh 示例) | 跳转 |
|---|---|---|
| `session_completed` | 「{agent} 在 {workspace} / {session} 完成了任务」 | `/sessions?focus=<sessionId>` |
| `session_waiting` | 「{agent} 在 {workspace} / {session} 等待你的输入」 | `/sessions?focus=<sessionId>` |
| `skill_created` | 「提炼出新技能《{skillTitle}》」 | `/skills`(设置内 Skills 页) |

跳转桥接:session 界面当前由 App 内 `activeSession` 状态驱动(`onSelectSession`),新增 **`?focus=<sessionId>` query 解析**(App 挂载/路由变化时读取 → 选中该 session),刷新后仍可直达;这是前端路由上唯一新增。

## 5. API(新增 `server/src/routes/notifications.js`)

| 方法/路径 | 作用 |
|---|---|
| `GET /api/notifications?limit=20&before=<cursor>` | 游标分页列表(倒序;`cursor = createdAt_id`,取早于游标的下一页),响应 `{ items, nextCursor, unreadCount }`;`before` 缺省 = 第一页 |
| `GET /api/notifications/unread-count` | 仅未读数(角标 30s 轮询用,轻量) |
| `POST /api/notifications/read-all` | 全部已读(`readAt=now WHERE userId AND readAt IS NULL`),返回新未读数 |
| `POST /api/notifications/:id/read` | 单条已读(点击消息时) |

分页选型:**游标(cursor)分页,非偏移分页、非分页器 UI**——`createdAt+id` 复合游标在「全部已读」等写操作前后稳定不串页,且走 `idx_notifications_user_created` 索引;服务端上限 200 条,理论上最多 10 页即到底。

传输:P1 用 **30s 轮询**(零新通道);打开面板时拉全量。全局 WS/SSE 推送为后续优化,不做依赖。

## 6. 服务端组件:`server/src/session/attentionService.js`(新)

- 内存 `Map<sessionId, AttentionState>`,**不引入 Redis**;事件源:`chatTranscript.subscribe`(L1)+ transcript tail 扫描(2s 节流、尾 4KB,L3')+ SessionManager 生命周期(exit→ended,spawn/attach→working);
- 状态迁移回调 → 写 `notifications` 表(含覆盖去重);
- 冷启动:P1 接受全量回落 `working`(首个信号到达即校正);P2 从 chatTranscript 尾部 + transcript tail 重建;
- L2 预留:`reportExternalSignal(sessionId, signal)`。

## 7. 前端:铃铛通知中心(收敛后唯一的提示面)

- **入口**:`App.jsx` 内容区顶栏(常驻 h-12 顶栏,设置路由下同样可见)右端新增 `Bell` 图标按钮(lucide,仓库已用);未读数 > 0 时右上角红色数字角标(>99 显示「99+」);遵守按钮无 focus ring 规范(`consoleButtonFocusClass`);
- **面板**:点击铃铛展开下拉面板(固定宽 ~360px,最大高 60vh 内滚动;外点 / Esc 关闭):
  - 头部:标题「通知」+ **「全部已读」按钮**(异步:loading 防重复提交,成功后红点全消、角标清零);
  - 列表项:`[类型图标] 文案(两行截断) · 相对时间 …… [红点●]`,未读行浅底色;
  - **加载方式:内部滚动 + 滚动到底自动加载下一页(游标),不做分页器**——初始 20 条,滚动触底再拉 20,全部加载完显示「没有更多了」(服务端 200 条上限封顶);新通知到达时若面板开着,插入列表顶部;
  - 点击消息:乐观标记已读(红点即消)→ 关面板 → 跳转对应页面;
  - 空态:占位文案;
- 已有 `input_stalled` 黄条、ChatView 内部横幅**保持不变**,与本中心互不影响;
- **i18n**:新增 `notifications` 命名空间(`shared/i18n/en|zh/notifications.json`):`bell.title / mark_all_read / empty / session_completed / session_waiting / skill_created` 等,en/zh 成对。

## 8. 参数表(初值,均可调)

| 参数 | 初值 | 说明 |
|---|---|---|
| 角标轮询间隔 | 30s | 未读数轮询(`unread-count`) |
| 初始加载 / 每页条数 | 20 / 20 | 面板游标分页 |
| 保留条数(硬上限) | 200/用户 | 写入时裁剪:先删最旧已读,再删最旧未读 |
| 去重规则 | 同会话同类型未读覆盖 | 防轰炸 |
| T_quiet | 90s | working→stalled 静默阈 |
| 稳定窗 | 2 次扫描 / ≥2s | L3' 翻转去抖 |
| L3' 扫描节流 | 2s | 且仅在有新输出时 |
| 尾读窗口 | 4KB | strip-ANSI 后送启发式 |
| question 文本截断 | 120 chars | reason/通知正文 |

## 9. 边界与扩展点

- **BYOK 直连**:L1 缺席,L3' 兜底;`source` 字段可解释;
- **多标签**:已读状态在 PG,天然一致;角标轮询各自刷新;
- **性能**:L3' 只扫尾 4KB + 节流;chatTranscript 环形 500;无新中间件;
- **降级**:attentionService / 通知写入失败不阻断会话主链路(纯旁路);
- **后续可选**(本期不做):浏览器 Notification、标题闪烁、声音、列表徽章、AgentConsole 横幅、全局推送;
- **L2 预留**:`attentionService.reportExternalSignal(sessionId, signal)`。

## 10. 实施分期

- **P1(核心闭环)**:notifications 表迁移 + notifications 路由 + attentionService(L1 挂钩 + L3' shared 化 `shared/terminal/promptHeuristics.mjs`,产生 waiting/completed 通知)+ conversationExtractor 处挂 skill 通知 + 顶栏铃铛与通知面板 + `?focus=` 跳转桥接 + i18n + 单测。
- **P2**:AgentConsole 精确启发式上报、全局推送替代轮询、冷启动状态重建、通知偏好设置。
- **P3**:stalled 类通知、浏览器通知、标题闪烁、声音。

## 11. 测试计划

- attentionService 状态机:迁移全路径、清除规则、L1>L3 冲突、稳定窗去抖、通知触发与覆盖去重;
- notifications API:未读数、read-all、单条 read、游标分页边界(首页/到底/`before` 串页防护)、200 条裁剪(已读优先);
- conversationExtractor → skill 通知触发;
- 前端:铃铛角标(0 / 1 / 99+ / 100)、面板交互(全部已读 loading、点击跳转、`?focus=` 桥接)、i18n key 成对;
- shared promptHeuristics:迁移 `chatPrompt.test.js` 既有用例 + 服务端 strip-ANSI 用例(颜色码/光标控制/OSC 清洗后不误判)。
