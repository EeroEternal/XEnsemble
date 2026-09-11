import { apiFetch } from './api';

/**
 * LoopTasks API 封装（对齐 skillsApi.js 风格）。
 */

async function throwApiError(res, fallback) {
  const body = await res.json().catch(() => ({}));
  const err = new Error(body?.error || fallback);
  if (body?.code) err.code = body.code;
  throw err;
}

export async function listLoopTasks() {
  const res = await apiFetch('/api/v1/loop-tasks');
  if (!res.ok) throw new Error('Failed to load loop tasks');
  const data = await res.json();
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

export async function createLoopTask({ title, prompt, projectId, schedule, timezone }) {
  const res = await apiFetch('/api/v1/loop-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, prompt, projectId, ...schedule, timezone }),
  });
  if (!res.ok) await throwApiError(res, 'Failed to create loop task');
  return res.json();
}

export async function updateLoopTask(id, patch) {
  const res = await apiFetch(`/api/v1/loop-tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) await throwApiError(res, 'Failed to update loop task');
  return res.json();
}

export async function deleteLoopTask(id) {
  const res = await apiFetch(`/api/v1/loop-tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error('Failed to delete loop task');
  return { ok: true };
}

export async function runLoopTaskNow(id) {
  const res = await apiFetch(`/api/v1/loop-tasks/${encodeURIComponent(id)}/run-now`, { method: 'POST' });
  if (!res.ok) await throwApiError(res, 'Failed to run loop task');
  return res.json();
}

export async function previewSchedule(schedule) {
  const res = await apiFetch('/api/v1/loop-tasks/schedule-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedule),
  });
  if (!res.ok) throw new Error('Failed to preview schedule');
  return res.json(); // { description } | { description: null, valid: false, error }
}

export async function listLoopTaskRuns(id) {
  const res = await apiFetch(`/api/v1/loop-tasks/${encodeURIComponent(id)}/runs`);
  if (!res.ok) throw new Error('Failed to load loop task runs');
  const data = await res.json();
  return Array.isArray(data?.runs) ? data.runs : [];
}
