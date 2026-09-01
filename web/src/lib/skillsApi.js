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

export async function createSkill({ title, content, tags = [], category = '', projectId = null }) {
  const res = await apiFetch('/api/v1/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content, tags, category: category || null, projectId }),
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
  if (!res.ok) throw new Error('Failed to change skill status');
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
