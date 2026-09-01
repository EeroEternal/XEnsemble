const {
  pgTable,
  text,
  integer,
  bigint,
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
  maxPreviews: integer('max_previews').notNull().default(1),
  maxRuntimes: integer('max_runtimes').notNull().default(1),
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
  title: text('title'),
  titleManual: boolean('title_manual').default(false),
  customImageId: text('custom_image_id'),
  provisioningError: text('provisioning_error'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
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
  unqProjectProviderMr: unique().on(table.projectId, table.provider, table.remoteMrNumber),
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
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  unqOwnerName: unique().on(table.ownerUserId, table.name),
}));

const customImageBuilds = pgTable('custom_image_builds', {
  id: text('id').primaryKey(),
  customImageId: text('custom_image_id').notNull().references(() => customImages.id),
  state: text('state').notNull().default('queued'),
  imageRef: text('image_ref'),
  logsRef: text('logs_ref'),
  failureReason: text('failure_reason'),
  startedAt: bigint('started_at', { mode: 'number' }),
  finishedAt: bigint('finished_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  imageStateIdx: index('idx_custom_image_builds_image_state').on(table.customImageId, table.state),
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

module.exports = {
  users,
  userQuotas,
  userPreferences,
  userAgentGrants,
  platformSettings,
  secrets,
  projects,
  sessions,
  sessionStreams,
  sessionConfigs,
  sessionChatMessages,
  sessionConversations,
  schedulerJobs,
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
};
