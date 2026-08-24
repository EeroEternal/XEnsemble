const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const { ensureAgentBootstrap } = require('../workspace/agentBootstrap');
const { ensureAgentResume } = require('../workspace/agentResumeHook');
const { buildPreflightReport } = require('../workspace/preflight');
const { appendInboxLog } = require('../workspace/logInbox');
const deploymentService = require('../deployments/DeploymentService');
const { abortDeploy } = require('../deployments/activeDeploys');
const { analyzeProjectDeploy } = require('../deployments/analyzeDeploy');
const { createTunnel, stopByProjectId } = require('../preview/tunnelServer');
const { db } = require('../db');
const schema = require('../db/schema');
const crypto = require('crypto');
const policy = require('../auth/PolicyService');
const { sendPublicError, sanitizePublicError } = require('../http/publicError');
const { t } = require('../i18n');
const { RuntimeError } = require('../runtime/interfaces');
const auth = require('../auth');
const { injectSecretsIntoTemplate } = require('../deployments/injectSecrets');

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

function registerWorkspaceRoutes(fastify, { getProjectForUser }) {
    fastify.get('/api/v1/projects/:projectId/preflight', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.projectId);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

        const agentId = request.query?.agent_id || request.query?.agentId || null;
        try {
            return await buildPreflightReport({
                user: request.user,
                project,
                agentId,
            });
        } catch (err) {
            request.log.error(err);
            return sendPublicError(reply, err, 'Preflight check failed', 500);
        }
    });

    fastify.post('/api/v1/projects/:projectId/agents/setup', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.projectId);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

        const force = Boolean(request.body?.force);
        try {
            const { workspacePath } = await ensureProjectRuntime(project);
            const status = await ensureAgentBootstrap(project, workspacePath, { force });
            if (status?.status === 'failed') {
                return reply.code(500).send({
                    error: t('errors:workspace_setup_failed', { defaultValue: 'Workspace setup failed' }, request.locale || 'en'),
                    setup: status,
                    code: 'workspace_setup_failed',
                });
            }
            return reply.code(200).send({ ok: true, setup: status });
        } catch (err) {
            request.log.error(err);
            return sendPublicError(reply, err, 'Workspace setup failed', 500);
        }
    });

    fastify.post('/api/v1/projects/:projectId/agents/resume', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.projectId);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

        const force = Boolean(request.body?.force);
        const ensurePreview = request.body?.ensure_preview !== false;
        try {
            const { workspacePath } = await ensureProjectRuntime(project);
            const status = await ensureAgentResume(project, workspacePath, { force, ensurePreview });
            if (status?.status === 'failed') {
                return reply.code(500).send({
                    error: 'Workspace resume failed',
                    resume: status,
                });
            }
            return reply.code(200).send({ ok: true, resume: status });
        } catch (err) {
            request.log.error(err);
            return sendPublicError(reply, err, 'Workspace resume failed', 500);
        }
    });

    fastify.post('/api/v1/projects/:projectId/agents/ensure-preview', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.projectId);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

        const previewQuota = await policy.checkQuota(request.user.id, 'previews', request.user.role);
        if (!previewQuota.ok) return policy.quotaErrorReply(reply, previewQuota);

        try {
            return await deploymentService.ensurePreview(request.user.id, project);
        } catch (err) {
            request.log.error(err);
            const code = err instanceof RuntimeError ? err.statusCode : 503;
            const { message } = sanitizePublicError(err, 'Ensure preview failed');
            return reply.code(code).send({ error: message });
        }
    });

    fastify.post('/api/v1/projects/:projectId/agents/log', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.projectId);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

        const message = request.body?.message;
        if (!message) return reply.code(400).send({ error: t('errors:message_required', { defaultValue: 'message is required' }, request.locale || 'en'), code: 'message_required' });

        const level = request.body?.level || 'log';
        const tag = request.body?.source || 'browser';
        try {
            const { workspacePath } = await ensureProjectRuntime(project);
            appendInboxLog(workspacePath, tag, `${level}: ${message}`);
            return { ok: true };
        } catch (err) {
            request.log.error(err);
            return sendPublicError(reply, err, 'Failed to append log', 500);
        }
    });

    fastify.post('/api/v1/projects/:projectId/analyze-deploy', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.projectId);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

        try {
            const ready = await ensureProjectRuntime(project);
            const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
            const result = await analyzeProjectDeploy({ workspacePath: ready.workspacePath, hostWorkspacePath: ready.hostWorkspacePath, runtimeRef: ref });
            return result;
        } catch (err) {
            request.log.error(err);
            return sendPublicError(reply, err, 'Deploy analysis failed', err instanceof RuntimeError ? err.statusCode : 500);
        }
    });

    // 一键部署隧道预览：在 VM 内服务已启动后，建立 host<-VM 反向隧道，放出预览 URL。
    // 不走 DeploymentService.createPreview（避免 checkpoint+restore 杀 agent）。
    fastify.post('/api/v1/projects/:projectId/tunnel-preview', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.projectId);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

        const vmPort = Number(request.body?.port);
        if (!vmPort || vmPort < 1 || vmPort > 65535) {
            return reply.code(400).send({ error: t('errors:valid_port_required', { defaultValue: 'valid port is required' }, request.locale || 'en'), code: 'valid_port_required' });
        }

        try {
            const ready = await ensureProjectRuntime(project);
            const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
            const now = Date.now();
            const deploymentId = `dep_${crypto.randomBytes(8).toString('hex')}`;

            // 部署新预览前，先清掉该项目所有旧 tunnel（避免 wsServer/browserServer/VM child 累积导致 node OOM）
            try { stopByProjectId(project.id); } catch { /* ignore */ }

            const tunnel = await createTunnel({
                deploymentId,
                workspacePath: ready.workspacePath,
                runtimeRef: ref,
                vmPort,
                projectId: project.id,
            });

            await db.insert(schema.deployments).values({
                id: deploymentId,
                userId: request.user.id,
                projectId: project.id,
                runtimeId: ready.runtime.id,
                kind: 'preview',
                status: 'running',
                revision: 'live',
                publicUrl: tunnel.publicUrl,
                internalRef: tunnel.internalRef,
                expiresAt: now + PREVIEW_TTL_MS,
                createdAt: now,
                updatedAt: now,
                createdBy: request.user.id,
            });

            const previewToken = await deploymentService.issuePreviewToken(deploymentId);
            return reply.code(201).send({
                id: deploymentId,
                status: 'running',
                public_url: tunnel.publicUrl,
                preview_token: previewToken,
            });
        } catch (err) {
            request.log.error(err);
            return sendPublicError(reply, err, 'Tunnel preview failed', err instanceof RuntimeError ? err.statusCode : 502);
        }
    });

    // 一键部署：从用户 vault（schema.secrets）注入真实值到 configFile template。
    // 不写盘——前端拿到新 template 后用现有的 PUT /api/v1/workspace/file 写入。
    fastify.post('/api/v1/projects/:projectId/deploy/inject-secrets', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.projectId);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });

        const configFile = request.body?.configFile;
        if (!configFile || typeof configFile.template !== 'string') {
            return reply.code(400).send({ error: t('errors:config_template_required', { defaultValue: 'configFile.template is required' }, request.locale || 'en'), code: 'config_template_required' });
        }
        const keys = Array.isArray(configFile.keys) ? configFile.keys : [];

        let secretMap = {};
        try {
            const rows = await db.select().from(schema.secrets).where(eq(schema.secrets.userId, request.user.id));
            if (rows.length > 0) {
                try {
                    secretMap = auth.decryptSecrets(rows[0].encryptedData) || {};
                } catch (_) {
                    secretMap = {};
                }
            }
        } catch (_) {
            secretMap = {};
        }

        const { template, injected } = injectSecretsIntoTemplate(configFile.template, keys, secretMap);
        return {
            path: configFile.path,
            template,
            injected,
            missing: keys.filter((k) => !secretMap[k] || String(secretMap[k]).trim() === ''),
        };
    });

    // 一键部署：中止当前部署——abort 进行中的 auto-deploy（verify agent 会尽快停止）+ 停掉 tunnel。
    fastify.post('/api/v1/projects/:projectId/deploy/cancel', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.projectId);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        try { abortDeploy(project.id); } catch (_) { /* ignore */ }
        try { stopByProjectId(project.id); } catch (_) { /* ignore */ }
        return { ok: true };
    });
}

module.exports = { registerWorkspaceRoutes };
