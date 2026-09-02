import { apiFetch } from './api';

/**
 * Skills API 封装（对齐 gitApi.js 风格）。
 */

export async function listMarket({ q = '', category = '', sort = 'hot', page = 1, pageSize = 20 } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  if (sort) params.set('sort', sort);
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  const res = await apiFetch(`/api/v1/skills/market?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to load skills market');
  return res.json();
}

export async function installSkill(id) {
  const res = await apiFetch(`/api/v1/skills/market/${encodeURIComponent(id)}/install`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to install skill');
  return res.json();
}

export async function listMySkills({ status = '', q = '' } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  const res = await apiFetch(`/api/v1/skills?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to load my skills');
  return res.json();
}

export async function getSkill(id) {
  const res = await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Failed to load skill');
  return res.json();
}

export async function createSkill({ title, content, tags = [], category = '', projectId = null, scripts = [] }) {
  const res = await apiFetch('/api/v1/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content, tags, category: category || null, projectId, scripts }),
  });
  if (!res.ok) throw new Error('Failed to create skill');
  return res.json();
}

export async function updateSkill(id, patch) {
  const res = await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('Failed to update skill');
  return res.json();
}

export async function changeStatus(id, action) {
  const res = await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    // 0021：透传后端错误 code（如 skill_not_landable），供 UI 分支提示
    const body = await res.json().catch(() => ({}));
    const err = new Error(body?.error || 'Failed to change skill status');
    if (body?.code) err.code = body.code;
    throw err;
  }
  return res.json();
}

export async function deleteSkill(id) {
  const res = await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error('Failed to delete skill');
  return { ok: true };
}

export async function publishSkill(id) {
  const res = await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}/publish`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to publish skill');
  return res.json();
}

export async function unpublishSkill(id) {
  const res = await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}/unpublish`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to unpublish skill');
  return res.json();
}

/**
 * 从会话手动提炼 skill（US-3，直跳 L4）。
 * @param {string} sessionId
 * @returns {Promise<object>} skill 全量
 */
export async function extractSkillFromSession(sessionId) {
  const res = await apiFetch('/api/v1/skills/from-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error('Failed to extract skill from session');
  return res.json();
}

/** auto draft 未读数 */
export async function getDraftsUnreadCount() {
  const res = await apiFetch('/api/v1/skills/drafts/unread-count');
  if (!res.ok) throw new Error('Failed to load drafts unread count');
  const data = await res.json();
  return Number(data?.count ?? 0);
}

/** 标记 auto draft 已读 */
export async function markDraftsSeen() {
  const res = await apiFetch('/api/v1/skills/drafts/mark-seen', { method: 'POST' });
  if (!res.ok && res.status !== 204) throw new Error('Failed to mark drafts seen');
  return { ok: true };
}

/**
 * 0022：从本地目录导入外部开源技能（扫描 <name>/SKILL.md 结构）。
 * @param {string} dirPath 服务端可见的本地目录绝对路径
 * @returns {Promise<{ imported: number, skills: object[] }>}
 */
export async function importSkillFromPath(dirPath) {
  const res = await apiFetch('/api/v1/skills/import-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body?.error || 'Failed to import skills');
    if (body?.code) err.code = body.code;
    throw err;
  }
  return res.json();
}
