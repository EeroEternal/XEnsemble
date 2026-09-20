const {
  pgTable,
  text,
  integer,
  bigint,
  bigserial,
  real,
  doublePrecision,
  boolean,
  jsonb,
  unique,
  uniqueIndex,
  index,
  primaryKey,
} = require('drizzle-orm/pg-core');

const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').default('user'),
  status: text('status').default('active'),
  email: text('email'),
  displayName: text('display_name'),
  lastLoginAt: bigint('last_login_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }),
});

const userQuotas = pgTable('user_quotas', {
  userId: text('user_id').primaryKey().references(() => users.id),
  maxProjects: integer('max_projects').notNull().default(5),
  maxSessions: integer('max_sessions').notNull().default(2),
  maxPreviews: integer('max_previews').notNull().default(5),
  maxRuntimes: integer('max_runtimes').notNull().default(1),
  maxCustomImages: integer('max_custom_images').notNull().default(10),
  resourceTier: text('resource_tier').notNull().default('basic'),
  updatedBy: text('updated_by').references(() => users.id),
  updatedAt: bigint('updated_at', { mode: 'number' }),
});

const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

const secrets = pgTable('secrets', {
  userId: text('user_id').primaryKey().references(() => users.id),
  encryptedData: text('encrypted_data').notNull(),
});

const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  serverPath: text('server_path').notNull(),
  defaultRuntimeId: text('default_runtime_id'),
  repoProvider: text('repo_provider').default('none'),
  repoUrl: text('repo_url'),
  repoDefaultBranch: text('repo_default_branch').default('main'),
  repoInstallationRef: text('repo_installation_ref'),
  repoTokenSecretRef: text('repo_token_secret_ref'),
  // P2: default environment (custom image) for sessions in this workspace.
  defaultCustomImageId: text('default_custom_image_id'),
  workspaceMode: text('workspace_mode').default('local'),
  lastSyncSha: text('last_sync_sha'),
  lastSnapshotId: text('last_snapshot_id'),
  devProfileId: text('dev_profile_id'),
  currentBranch: text('current_branch'),
  githubRepoId: integer('github_repo_id'),
  githubFullName: text('github_full_name'),
  cloneStatus: text('clone_status').default('pending'),
  cloneError: text('clone_error'),
  remoteRepoId: text('remote_repo_id'),
  remoteFullName: text('remote_full_name'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

const projectRepos = pgTable('project_repos', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  subPath: text('sub_path').notNull(),
  repoProvider: text('repo_provider').notNull(),
  repoUrl: text('repo_url').notNull(),
  repoDefaultBranch: text('repo_default_branch').notNull().default('main'),
  repoInstallationRef: text('repo_installation_ref'),
  repoTokenSecretRef: text('repo_token_secret_ref'),
  isPrimary: boolean('is_primary').notNull().default(false),
  currentBranch: text('current_branch'),
  cloneStatus: text('clone_status').notNull().default('pending'),
  cloneError: text('clone_error'),
  remoteRepoId: text('remote_repo_id'),
  remoteFullName: text('remote_full_name'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  byProject: index('project_repos_project_id_idx').on(table.projectId),
  uniqSubPath: uniqueIndex('project_repos_project_subpath_uniq').on(table.projectId, table.subPath),
}));

const runtimes = pgTable('runtimes', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  agentId: text('agent_id'),
  provider: text('provider').notNull().default('boxlite'),
  runtimeRef: text('runtime_ref'),
  role: text('role').notNull().default('default'),
  status: text('status').default('ready'),
  endpoint: text('endpoint'),
  specs: text('specs'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  projectId: text('project_id').references(() => projects.id),
  runtimeId: text('runtime_id').references(() => runtimes.id),
  agentId: text('agent_id').notNull(),
  cwd: text('cwd').notNull(),
  streamRef: text('stream_ref'),
  stateDirRef: text('state_dir_ref'),
  recoverable: boolean('recoverable').default(false),
  status: text('status').default('running'),
  // 会话来源：interactive（用户手动创建）| loop_task（循环任务无人值守触发）。
  // loop_task 会话在列表接口默认过滤，不进主侧边栏、不占 sessions 配额。
  source: text('source').notNull().default('interactive'),
  title: text('title'),
  titleManual: boolean('title_manual').default(false),
  customImageId: text('custom_image_id'),
  provisioningError: text('provisioning_error'),
  // A+C: in-sandbox environment provisioning (base agent image + background install).
  envProvisionState: text('env_provision_state'),
  envProvisionError: text('env_provision_error'),
  envProvisionStartedAt: bigint('env_provision_started_at', { mode: 'number' }),
  envProvisionFinishedAt: bigint('env_provision_finished_at', { mode: 'number' }),
  envProvisionLogRef: text('env_provision_log_ref'),
  exitCode: integer('exit_code'),
  exitedAt: bigint('exited_at', { mode: 'number' }),
  // 0018: P3 技能提炼——该会话已被漏斗处理过（extracted/rejected/expired 均算），防重复入池
  skillExtractedAt: bigint('skill_extracted_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }),
});
const sessionStreams = pgTable('session_streams', {
  sessionId: text('session_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
  headSeq: integer('head_seq').notNull().default(0),
  bytes: integer('bytes').notNull().default(0),
  storageRef: text('storage_ref').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

const sessionConfigs = pgTable('session_configs', {
  sessionId: text('session_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
  configFiles: jsonb('config_files').notNull().default([]),
  customEnv: jsonb('custom_env').notNull().default({}),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// 0015: 会话对话摘要与轮次缓存（A+B），供历史会话页使用
const sessionConversations = pgTable('session_conversations', {
  sessionId: text('session_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
  // LLM 生成的摘要字段（turns 不再由 LLM 生成，改为实时读 chat transcript）
  summary: jsonb('summary').notNull().default({}),
  // 最近 100 个 ConversationTurn 原文缓存（chat transcript 缺失时的兜底）
  turns: jsonb('turns').notNull().default([]),
  // 增量游标：chat 源为消息 seq，transcript 源为帧 seq
  lastSummarizedSeq: integer('last_summarized_seq').notNull().default(0),
  // 提取来源：chat（LLM 代理结构化聊天记录）| state_dir（agent 原生 JSONL）| transcript（终端流清洗）
  source: text('source').notNull().default('transcript'),
  lastError: text('last_error'),
  // 连续 LLM 失败计数
  errorCount: integer('error_count').notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// 0014: LLM 代理层捕获的会话聊天消息（chatTranscript 写入，结构化原文）
const sessionChatMessages = pgTable('session_chat_messages', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  callId: text('call_id'),
  tool: text('tool'),
  model: text('model'),
}, (table) => ({
  pk: primaryKey({ columns: [table.sessionId, table.seq] }),
  sessionIdx: index('idx_session_chat_messages_session').on(table.sessionId),
}));

// 0029: 会话完整执行轨迹（trajectory.js 写入，每次模型调用一行，verbatim 降采样前的权威源）
const sessionTrajectory = pgTable('session_trajectory', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  agentId: text('agent_id'),
  model: text('model'),
  // true=该行 request.messages 存全量上下文快照（首请求 / 检测到历史压缩或错位时重置）
  snapshot: boolean('snapshot').notNull().default(false),
  // 请求时上下文消息总数（delta 重放基准：上一次快照/delta 应用后的数组长度）
  msgCount: integer('msg_count').notNull().default(0),
  // 请求载荷：snapshot 行 {messages: 全量} / delta 行 {messages: 新增}；含 params 与 truncated 标记
  request: jsonb('request').notNull(),
  // 响应（归一化）：{format, content[], finish_reason, usage, truncated}
  response: jsonb('response'),
  status: text('status').notNull().default('ok'),
  latencyMs: integer('latency_ms'),
  error: text('error'),
}, (table) => ({
  pk: primaryKey({ columns: [table.sessionId, table.seq] }),
  sessionIdx: index('idx_session_trajectory_session').on(table.sessionId),
}));

// 0016: 进程内调度器的 Job 注册表（PG 乐观锁，多实例安全）
const schedulerJobs = pgTable('scheduler_jobs', {
  jobName: text('job_name').primaryKey(),
  lockedBy: text('locked_by'),
  lockedAt: bigint('locked_at', { mode: 'number' }),
  lastRunAt: bigint('last_run_at', { mode: 'number' }),
  lastStatus: text('last_status'),
  lastError: text('last_error'),
  nextRunAt: bigint('next_run_at', { mode: 'number' }).notNull().default(0),
});

const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  cmd: text('cmd').notNull(),
  args: text('args').notNull(),
  envRequired: text('env_required').notNull(),
  vmResources: jsonb('vm_resources'),
});

const userPreferences = pgTable('user_preferences', {
  userId: text('user_id').notNull().references(() => users.id),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.key] }),
}));

const userAgentGrants = pgTable('user_agent_grants', {
  userId: text('user_id').notNull().references(() => users.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  grantedBy: text('granted_by').references(() => users.id),
  grantedAt: bigint('granted_at', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.agentId] }),
}));

const deployments = pgTable('deployments', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  runtimeId: text('runtime_id').references(() => runtimes.id),
  // 与创建它的 session 强绑定（0011）：session 删除时记录级联清理；部署阶段持久化
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
  stage: text('stage'),
  stageMessage: text('stage_message'),
  kind: text('kind').notNull().default('preview'),
  status: text('status').notNull().default('pending'),
  publicUrl: text('public_url'),
  internalRef: text('internal_ref'),
  previewTokenHash: text('preview_token_hash'),
  revision: text('revision'),
  // preview 运行模式：'live'（常驻 dev server 实时预览）| 'static'（构建产物静态 serve）
  mode: text('mode').notNull().default('static'),
  expiresAt: bigint('expires_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  createdBy: text('created_by'),
  stoppedBy: text('stopped_by'),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  resourceTier: text('resource_tier'),
  region: text('region'),
  buildLog: text('build_log'),
  runtimeLog: text('runtime_log'),
});

// 一键部署第二阶段（verify agent）的"断点续修"状态：每项目一份。
// 超轮数失败时保存对话历史，下次 resume 时接回继续修，避免从头重跑。
const deployVerifyStates = pgTable('deploy_verify_states', {
  projectId: text('project_id').primaryKey().references(() => projects.id),
  plan: jsonb('plan').notNull(),
  messages: jsonb('messages').notNull(),
  trail: jsonb('trail').notNull().default([]),
  roundsUsed: integer('rounds_used').notNull().default(0),
  runtimeRef: text('runtime_ref'),
  workspacePath: text('workspace_path'),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

// 阶段 A（分析）产出的部署计划缓存：每项目一份。
// 二次部署命中时跳过 opencode/LLM 探索分析（通常 1~4 分钟），TTL 内未命中则重新分析。
const deployPlanCache = pgTable('deploy_plan_cache', {
  projectId: text('project_id').primaryKey().references(() => projects.id),
  plan: jsonb('plan').notNull(),
  source: text('source'),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

const events = pgTable('events', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id),
  projectId: text('project_id').references(() => projects.id),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  type: text('type').notNull(),
  data: text('data'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// 0017: Skills（私有技能 + 市场发布/安装）
// status: draft | active | archived；source: auto | manual | installed
// visibility: private | public；published_at 非空即视为"已在市场"
const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  content: text('content').notNull(),
  // 0020: 脚本级 Skill——[{ path: 'scripts/xxx.sh', content: '<script>' }]，注入时落盘到 workspace
  scripts: jsonb('scripts').notNull().default([]),
  tags: jsonb('tags').notNull().default([]),
  status: text('status').notNull().default('draft'),
  source: text('source').notNull().default('auto'),
  confidence: real('confidence'),
  duplicateOf: text('duplicate_of'),
  clusterSize: integer('cluster_size').notNull().default(1),
  signals: jsonb('signals'),
  usageCount: integer('usage_count').notNull().default(0),
  visibility: text('visibility').notNull().default('private'),
  publishedAt: bigint('published_at', { mode: 'number' }),
  installCount: integer('install_count').notNull().default(0),
  category: text('category'),
  forkedFrom: text('forked_from'),
  sourceHash: text('source_hash'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  userStatusIdx: index('idx_skills_user_status').on(table.userId, table.status),
  marketIdx: index('idx_skills_market').on(table.visibility, table.status, table.publishedAt),
}));

// 0018: 技能提炼候选池（P3 漏斗 L1-L4 中间产物）
// stage: scored | clustered | classified | extracted | rejected | expired
// signals: { correctionCount, filesTouched, successExit, turnCount, userMarked }
const skillCandidates = pgTable('skill_candidates', {
  sessionId: text('session_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  score: integer('score').notNull(),
  signals: jsonb('signals').notNull().default({}),
  topicFingerprint: text('topic_fingerprint'),
  clusterId: text('cluster_id'),
  clusterSize: integer('cluster_size').notNull().default(1),
  stage: text('stage').notNull().default('scored'),
  rejectedReason: text('rejected_reason'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  stageIdx: index('idx_candidates_stage').on(table.stage),
  clusterIdx: index('idx_candidates_cluster').on(table.clusterId),
}));

const devEnvironmentProfiles = pgTable('dev_environment_profiles', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  source: text('source').notNull().default('manual'),
  profileJson: text('profile_json').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

const repoSnapshots = pgTable('repo_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  gitSha: text('git_sha'),
  branch: text('branch'),
  status: text('status').notNull().default('pending'),
  storageRef: text('storage_ref'),
  buildLog: text('build_log'),
  lastError: text('last_error'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }),
});

const workspaceCheckpoints = pgTable('workspace_checkpoints', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  sessionId: text('session_id').references(() => sessions.id),
  baseSnapshotId: text('base_snapshot_id').references(() => repoSnapshots.id),
  status: text('status').notNull().default('pending'),
  storageRef: text('storage_ref'),
  diffRef: text('diff_ref'),
  gitSha: text('git_sha'),
  createdBy: text('created_by'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }),
});

const refreshTokens = pgTable('refresh_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  deviceName: text('device_name'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  revokedAt: bigint('revoked_at', { mode: 'number' }),
}, (table) => ({
  userIdx: index('idx_refresh_tokens_user').on(table.userId),
  hashIdx: index('idx_refresh_tokens_hash').on(table.tokenHash),
}));

const githubConnections = pgTable('github_connections', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  githubUserId: integer('github_user_id').notNull(),
  githubUsername: text('github_username').notNull(),
  githubAvatar: text('github_avatar'),
  accessTokenEnc: text('access_token_enc').notNull(),
  tokenScope: text('token_scope'),
  connectedAt: bigint('connected_at', { mode: 'number' }).notNull(),
  lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  revokedAt: bigint('revoked_at', { mode: 'number' }),
}, (table) => ({
  idxGithubConnectionsUserId: uniqueIndex('idx_github_connections_user_id').on(table.userId),
}));

const githubOAuthStates = pgTable('github_oauth_states', {
  state: text('state').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
}, (table) => ({
  expiresIdx: index('idx_github_oauth_states_expires').on(table.expiresAt),
}));

const projectBranches = pgTable('project_branches', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  branchName: text('branch_name').notNull(),
  baseBranch: text('base_branch'),
  isActive: boolean('is_active').default(false),
  lastCommitSha: text('last_commit_sha'),
  aheadCount: integer('ahead_count').default(0),
  behindCount: integer('behind_count').default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  unqProjectBranch: unique().on(table.projectId, table.branchName),
}));

const gitConnections = pgTable('git_connections', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  provider: text('provider').notNull(),
  providerConfig: text('provider_config'),
  remoteUserId: text('remote_user_id').notNull(),
  remoteUsername: text('remote_username').notNull(),
  remoteAvatar: text('remote_avatar'),
  accessTokenEnc: text('access_token_enc').notNull(),
  refreshTokenEnc: text('refresh_token_enc'),
  tokenScope: text('token_scope'),
  tokenExpiresAt: bigint('token_expires_at', { mode: 'number' }),
  connectedAt: bigint('connected_at', { mode: 'number' }).notNull(),
  lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  revokedAt: bigint('revoked_at', { mode: 'number' }),
}, (table) => ({
  unqUserProvider: unique().on(table.userId, table.provider, table.providerConfig),
}));

const gitOAuthStates = pgTable('git_oauth_states', {
  state: text('state').primaryKey(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
}, (table) => ({
  expiresIdx: index('idx_git_oauth_states_expires').on(table.expiresAt),
}));

const mergeRequests = pgTable('merge_requests', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  repoId: text('repo_id'), // 多仓库：所属 project_repos 行；单仓库/存量 = NULL
  provider: text('provider').notNull(),
  remoteMrNumber: integer('remote_mr_number').notNull(),
  remoteMrUrl: text('remote_mr_url').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  sourceBranch: text('source_branch').notNull(),
  targetBranch: text('target_branch').notNull(),
  status: text('status').notNull().default('open'),
  remoteState: text('remote_state'),
  mergeSha: text('merge_sha'),
  createdBy: text('created_by').references(() => users.id),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  lastSyncedAt: bigint('last_synced_at', { mode: 'number' }),
}, (table) => ({
  unqProjectProviderMr: unique().on(table.projectId, table.provider, table.repoId, table.remoteMrNumber),
}));

const agentBoxImages = pgTable('agent_box_images', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  imageRef: text('image_ref').notNull(),
  tag: text('tag').notNull(),
  digest: text('digest'),
  status: text('status').notNull().default('ready'),
  isActive: boolean('is_active').default(false),
  builtAt: bigint('built_at', { mode: 'number' }),
  notes: text('notes'),
  createdBy: text('created_by').references(() => users.id),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  unqAgentTag: unique().on(table.agentId, table.tag),
  agentActiveIdx: index('idx_agent_box_images_agent_active').on(table.agentId, table.isActive),
}));

const customImages = pgTable('custom_images', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  components: text('components').notNull(),
  imageRef: text('image_ref'),
  // P2: curated catalog (admin publishes a ready image for all users) + GC marker.
  isPublished: boolean('is_published').notNull().default(false),
  description: text('description'),
  category: text('category'),
  staleAt: bigint('stale_at', { mode: 'number' }),
  // Set only by the /resolve auto-creation path; never derived from the name.
  isAuto: boolean('is_auto').notNull().default(false),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  unqOwnerName: unique().on(table.ownerUserId, table.name),
  publishedIdx: index('idx_custom_images_published').on(table.isPublished),
}));

const customImageBuilds = pgTable('custom_image_builds', {
  id: text('id').primaryKey(),
  customImageId: text('custom_image_id').notNull().references(() => customImages.id),
  state: text('state').notNull().default('queued'),
  imageRef: text('image_ref'),
  // P2: recipe identity (components + resolved base image) for indexed lookup.
  contentHash: text('content_hash'),
  logsRef: text('logs_ref'),
  failureReason: text('failure_reason'),
  startedAt: bigint('started_at', { mode: 'number' }),
  finishedAt: bigint('finished_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  imageStateIdx: index('idx_custom_image_builds_image_state').on(table.customImageId, table.state),
  hashStateIdx: index('idx_custom_image_builds_hash_state').on(table.contentHash, table.state),
}));

const agentImageBuilds = pgTable('agent_image_builds', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  state: text('state').notNull().default('queued'),
  imageRef: text('image_ref'),
  tag: text('tag'),
  logsRef: text('logs_ref'),
  failureReason: text('failure_reason'),
  versionId: text('version_id'),
  notes: text('notes'),
  startedAt: bigint('started_at', { mode: 'number' }),
  finishedAt: bigint('finished_at', { mode: 'number' }),
  createdBy: text('created_by').references(() => users.id),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  agentBuildStateIdx: index('idx_agent_image_builds_agent_state').on(table.agentId, table.state),
}));

// LoopTask：用户自定义定时任务（执行 = TaskAgent 在 Workspace runtime 沙箱内 ReAct 循环）
// 0028: LLM Token 用量事实表（proxy 每次成功转发的 chat 请求一行，查询时聚合）
// 来源：llm/proxy.js onResponseBody 捕获的 usage（OpenAI/Anthropic 两种协议）
// 注意：BYOK 流量不经过 proxy，不计入；会话标题/摘要等内部调用一期不计入
const llmUsage = pgTable('llm_usage', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id'),
  projectId: text('project_id'),
  agentId: text('agent_id'),
  model: text('model'),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  // 0030: 缓存命中的 prompt token 数；provider 未上报时为 null（区分"命中 0"与"未上报"）
  cachedTokens: integer('cached_tokens'),
  statusCode: integer('status_code'),
  latencyMs: integer('latency_ms'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  // 0034: 智能路由观测并入本表（仍只在成功且解析到 usage 时插入）
  // requested_model = 路由前 Agent 请求体 model；model 仍是实际转发 id
  requestedModel: text('requested_model'),
  // first_turn / sticky / compaction / provider_fail；路由 skip 时为 null
  trigger: text('trigger'),
  // 与同一次 trajectory.recordRequest 的 seq 相同；trajectory 未记时为 null
  seq: integer('seq'),
  // 0035: 静态启发式任务难度 D ∈ [0,1]；路由 skip 时为 null
  difficulty: doublePrecision('difficulty'),
}, (table) => ({
  userCreatedIdx: index('idx_llm_usage_user_created').on(table.userId, table.createdAt),
  userProjectIdx: index('idx_llm_usage_user_project').on(table.userId, table.projectId, table.createdAt),
  createdIdx: index('idx_llm_usage_created').on(table.createdAt),
  sessionSeqIdx: index('idx_llm_usage_session_seq').on(table.sessionId, table.seq),
}));

// STICKY_TTL_MS = 10 * 60 * 1000 — 文档用，TTL 逻辑在 sticky.js
// 主键为 (session_id, line_key)：一个 session 下可有多条并行对话线（Agent 派生的
// 并行子任务共用 sessionId），各自独立粘性，避免互相覆盖。line_key 为空串表示
// 无线索（历史行/空 messages），此时退化为原来的「一个 session 一条粘性」。
const sessionRouteSticky = pgTable('session_route_sticky', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  lineKey: text('line_key').notNull().default(''),
  chosenModel: text('chosen_model').notNull(),
  chosenProvider: text('chosen_provider').notNull(),
  failCount: integer('fail_count').notNull().default(0),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.sessionId, table.lineKey] }),
}));

const routingDecisions = pgTable('routing_decisions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
  userId: text('user_id'),
  agentId: text('agent_id'),
  projectId: text('project_id'),
  seq: integer('seq').notNull(),
  reevaluated: boolean('reevaluated').notNull().default(false),
  trigger: text('trigger').notNull(),
  demand: jsonb('demand'),
  stickyModel: text('sticky_model'),
  stickyProvider: text('sticky_provider'),
  candidates: jsonb('candidates'),
  chosenModel: text('chosen_model'),
  chosenProvider: text('chosen_provider'),
  costEstimate: jsonb('cost_estimate'),
  promptTokens: integer('prompt_tokens'),
  cachedTokens: integer('cached_tokens'),
  completionTokens: integer('completion_tokens'),
  latencyMs: integer('latency_ms'),
  statusCode: integer('status_code'),
  error: text('error'),
}, (table) => ({
  sessionSeq: unique('uq_routing_decisions_session_seq').on(table.sessionId, table.seq),
  userCreatedIdx: index('idx_routing_decisions_user_created').on(table.userId, table.createdAt),
  createdIdx: index('idx_routing_decisions_created').on(table.createdAt),
}));

const loopTasks = pgTable('loop_tasks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  // 执行 Agent：每次触发在项目沙箱内创建该 Agent 的会话执行（无 TaskAgent 兜底）
  agentId: text('agent_id'),
  // 无人值守自动批准工具调用（Agent 支持的前提下注入对应 flag）；false = 只读保守执行
  autoApprove: boolean('auto_approve').notNull().default(true),
  // 人工复核模式：true = 执行完毕不自动终态，会话保持存活进入 awaiting_review，
  // 由人工在 Loop Tasks 中通过/打回（超时自动按 succeeded 收口）
  requireReview: boolean('require_review').notNull().default(false),
  // 工作日感知（仅 cron 周一至周五形态生效）：按中国法定日历过滤——节假日跳过、调休补班照跑
  holidayAware: boolean('holiday_aware').notNull().default(false),
  scheduleKind: text('schedule_kind').notNull().default('cron'), // cron / every / at
  cronExpr: text('cron_expr').notNull().default('* * * * *'),
  timezone: text('timezone').notNull().default('Asia/Shanghai'),
  intervalMs: bigint('interval_ms', { mode: 'number' }), // kind=every
  status: text('status').notNull().default('active'), // active / paused / completed
  nextRunAt: bigint('next_run_at', { mode: 'number' }).notNull().default(0),
  lastRunAt: bigint('last_run_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }),
}, (table) => ({
  dueIdx: index('idx_loop_tasks_due').on(table.status, table.nextRunAt),
}));

// LoopTask 执行记录；(task_id, scheduled_for) 唯一约束 = 幂等触发锚点
const loopTaskRuns = pgTable('loop_task_runs', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => loopTasks.id),
  scheduledFor: bigint('scheduled_for', { mode: 'number' }).notNull(),
  status: text('status').notNull().default('running'), // running / succeeded / failed / timeout
  // 每次触发新建的 Agent 会话（run↔session 一对一）。不加 FK：用户删会话不应级联删执行记录。
  sessionId: text('session_id'),
  agentId: text('agent_id'),
  rounds: integer('rounds'),
  logs: jsonb('logs'),
  // 成功 run 的最终回复（业界定时 Agent 标配：exit code 定成败，结果文本一等公民）
  result: text('result'),
  error: text('error'),
  startedAt: bigint('started_at', { mode: 'number' }),
  finishedAt: bigint('finished_at', { mode: 'number' }),
  // 进入 awaiting_review 的时刻（人工复核模式超时判定依据）
  reviewStartedAt: bigint('review_started_at', { mode: 'number' }),
}, (table) => ({
  unqSlot: unique('uq_loop_task_runs_slot').on(table.taskId, table.scheduledFor),
  taskIdx: index('idx_loop_task_runs_task').on(table.taskId, table.startedAt),
  sessionIdx: index('idx_loop_task_runs_session').on(table.sessionId),
}));

module.exports = {
  users,
  userQuotas,
  userPreferences,
  userAgentGrants,
  platformSettings,
  secrets,
  projects,
  projectRepos,
  sessions,
  sessionStreams,
  sessionConfigs,
  sessionChatMessages,
  sessionTrajectory,
  sessionConversations,
  schedulerJobs,
  skills,
  skillCandidates,
  agents,
  runtimes,
  deployments,
  deployVerifyStates,
  deployPlanCache,
  events,
  devEnvironmentProfiles,
  repoSnapshots,
  workspaceCheckpoints,
  refreshTokens,
  githubConnections,
  githubOAuthStates,
  projectBranches,
  gitConnections,
  gitOAuthStates,
  mergeRequests,
  agentBoxImages,
  agentImageBuilds,
  customImages,
  customImageBuilds,
  loopTasks,
  loopTaskRuns,
  llmUsage,
  sessionRouteSticky,
  routingDecisions,
};
