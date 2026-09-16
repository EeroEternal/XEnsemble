import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Pencil, Ban, CheckCircle, KeyRound } from 'lucide-react';
import Button from '../components/Button';
import Input from '../components/Input';
import PageHeader from '../components/PageHeader';
import SelectMenu from '../components/SelectMenu';
import MultiSelectMenu from '../components/MultiSelectMenu';
import { ConsoleDialogShell } from '../components/ConsoleDialog';
import { useToast } from '../components/Toast';
import { useButtonLoading } from '../hooks/useButtonLoading';
import {
  consoleCardClass,
  consoleDialogMdClass,
  consolePageStackClass,
  consoleSectionLabelClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableShellClass,
} from '../lib/consoleTheme';
import { apiFetch } from '../lib/api.ts';
import { useTranslation } from 'react-i18next';

function statusBadge(status) {
  const map = {
    active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    suspended: 'bg-red-50 text-red-700 border-red-200',
  };
  return map[status] || 'bg-zinc-100 text-zinc-600 border-zinc-200';
}

function formatLastLogin(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

const emptyForm = {
  username: '',
  password: '',
  role: 'user',
  status: 'active',
  max_projects: 5,
  max_sessions: 2,
  max_previews: 1,
  resource_tier: 'basic',
  agent_ids: [],
};

export default function UsersAdmin() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [users, setUsers] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogMode, setDialogMode] = useState(null);
  const [editingUser, setEditingUser] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [resetPassword, setResetPassword] = useState('');
  const { isLoading: saving, run: runSave } = useButtonLoading();
  const pendingCreateAgentDefaults = useRef(false);

  const fetchUsers = useCallback(() => {
    apiFetch('/api/v1/admin/users')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setUsers(data);
      })
      .finally(() => setLoading(false));
  }, []);

  const fetchAgents = useCallback(() => {
    apiFetch('/api/v1/agents')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setAgents(data);
      });
  }, []);

  useEffect(() => {
    fetchUsers();
    fetchAgents();
  }, [fetchUsers, fetchAgents]);

  useEffect(() => {
    if (!pendingCreateAgentDefaults.current || dialogMode !== 'create' || agents.length === 0) return;
    setForm((f) => ({ ...f, agent_ids: agents.map((a) => a.id) }));
    pendingCreateAgentDefaults.current = false;
  }, [dialogMode, agents]);

  const openCreate = () => {
    pendingCreateAgentDefaults.current = agents.length === 0;
    setForm({
      ...emptyForm,
      agent_ids: agents.map((a) => a.id),
    });
    setEditingUser(null);
    setResetPassword('');
    setDialogMode('create');
  };

  const openEdit = async (user) => {
    try {
      const res = await apiFetch(`/api/v1/admin/users/${user.id}`);
      const detail = await res.json();
      if (!res.ok) throw new Error(detail.error);
      setEditingUser(detail);
      setForm({
        username: detail.username,
        password: '',
        role: detail.role,
        status: detail.status,
        max_projects: detail.quotas?.max_projects ?? 5,
        max_sessions: detail.quotas?.max_sessions ?? 2,
        max_previews: detail.quotas?.max_previews ?? 1,
        resource_tier: detail.quotas?.resource_tier ?? 'basic',
        agent_ids: detail.granted_agent_ids || [],
      });
      setResetPassword('');
      setDialogMode('edit');
    } catch (err) {
      showToast('error', err.message);
    }
  };

  const closeDialog = () => {
    pendingCreateAgentDefaults.current = false;
    setDialogMode(null);
    setEditingUser(null);
    setResetPassword('');
  };

  const handleSave = async (e) => {
    e.preventDefault();
    await runSave(async () => {
      if (dialogMode === 'create') {
        if (!form.password || form.password.length < 8) {
          showToast('error', t('users:error.password_too_short'));
          return;
        }
        const res = await apiFetch('/api/v1/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            username: form.username,
            password: form.password,
            role: form.role,
            status: form.status,
            quota: {
              max_projects: Number(form.max_projects),
              max_sessions: Number(form.max_sessions),
              max_previews: Number(form.max_previews),
              resource_tier: form.resource_tier,
            },
            agent_ids: form.agent_ids,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast('success', t('users:toast.user_created'));
      } else if (editingUser) {
        const patchRes = await apiFetch(`/api/v1/admin/users/${editingUser.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            role: form.role,
            status: form.status,
          }),
        });
        const patchData = await patchRes.json();
        if (!patchRes.ok) throw new Error(patchData.error);

        const quotaRes = await apiFetch(`/api/v1/admin/users/${editingUser.id}/quota`, {
          method: 'PUT',
          body: JSON.stringify({
            max_projects: Number(form.max_projects),
            max_sessions: Number(form.max_sessions),
            max_previews: Number(form.max_previews),
            resource_tier: form.resource_tier,
          }),
        });
        const quotaData = await quotaRes.json();
        if (!quotaRes.ok) throw new Error(quotaData.error);

        const agentsRes = await apiFetch(`/api/v1/admin/users/${editingUser.id}/agents`, {
          method: 'PUT',
          body: JSON.stringify({ agent_ids: form.agent_ids }),
        });
        const agentsData = await agentsRes.json();
        if (!agentsRes.ok) throw new Error(agentsData.error);

        if (resetPassword.trim()) {
          if (resetPassword.length < 8) {
            showToast('error', t('users:error.new_password_too_short', { defaultValue: 'New password must be at least 8 characters.' }));
            return;
          }
          const pwRes = await apiFetch(`/api/v1/admin/users/${editingUser.id}/reset-password`, {
            method: 'POST',
            body: JSON.stringify({ password: resetPassword }),
          });
          const pwData = await pwRes.json();
          if (!pwRes.ok) throw new Error(pwData.error);
        }

        showToast('success', t('users:toast.user_updated'));
      }
      closeDialog();
      fetchUsers();
    });
  };

  const toggleStatus = async (user) => {
    const next = user.status === 'active' ? 'suspended' : 'active';
    try {
      const res = await apiFetch(`/api/v1/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast('success', next === 'active' ? t('users:toast.user_activated') : t('users:toast.user_suspended'));
      fetchUsers();
    } catch (err) {
      showToast('error', err.message);
    }
  };

  const approveUser = async (user) => {
    try {
      const res = await apiFetch(`/api/v1/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast('success', t('users:toast.user_approved', { defaultValue: 'User approved.' }));
      fetchUsers();
    } catch (err) {
      showToast('error', err.message);
    }
  };

  const agentOptions = agents.map((a) => ({ value: a.id, label: a.name }));

  return (
    <div className={`h-full w-full overflow-auto p-6 ${consolePageStackClass}`}>
      <PageHeader
        title={t('users:title')}
        description={t('users:description', { defaultValue: 'Manage accounts, quotas, and agent access.' })}
        actions={(
          <Button type="button" onClick={openCreate} size="md" className="shrink-0">
            <Plus className="w-4 h-4" />
            {t('users:add_user')}
          </Button>
        )}
      />

      <div className={consoleTableShellClass}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className={consoleTableHeadCellClass}>{t('users:field.username')}</th>
                <th className={consoleTableHeadCellClass}>{t('users:field.status')}</th>
                <th className={consoleTableHeadCellClass}>{t('users:field.usage', { defaultValue: 'Usage' })}</th>
                <th className={consoleTableHeadCellClass}>{t('users:field.quotas', { defaultValue: 'Quotas' })}</th>
                <th className={consoleTableHeadCellClass}>{t('agents:title')}</th>
                <th className={consoleTableHeadCellClass}>{t('users:field.last_login')}</th>
                <th className={consoleTableHeadCellClass}>{t('common:table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className={`${consoleTableBodyCellClass} text-zinc-400`}>{t('common:state.loading')}</td>
                </tr>
              ) : users.map((user) => (
                <tr key={user.id} className="hover:bg-zinc-50/50">
                  <td className={consoleTableBodyCellClass}>
                    <div className="font-medium text-zinc-900">{user.username}</div>
                    <div className="text-xs text-zinc-400">{user.role}</div>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${statusBadge(user.status)}`}>
                      {t(`users:status.${user.status}`, { defaultValue: user.status })}
                    </span>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <span className="font-mono text-xs text-zinc-600">
                      W {user.projects_count}/{user.quotas?.max_projects ?? '—'}
                      {' · '}
                      S {user.active_sessions}/{user.quotas?.max_sessions ?? '—'}
                      {' · '}
                      V {user.active_previews}/{user.quotas?.max_previews ?? '—'}
                    </span>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <span className="text-xs text-zinc-500">{t(`users:tier.${user.quotas?.resource_tier ?? 'basic'}`, { defaultValue: user.quotas?.resource_tier ?? 'basic' })}</span>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <span className="text-xs text-zinc-600">
                      {user.role === 'admin' ? t('common:select.all_agents') : (user.granted_agents_count ?? 0)}
                    </span>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <span className="text-xs text-zinc-500">{formatLastLogin(user.last_login_at)}</span>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(user)}
                        className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                        title={t('common:action.edit')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {user.status === 'pending' && (
                        <button
                          type="button"
                          onClick={() => approveUser(user)}
                          className="p-1.5 rounded-md text-emerald-600 hover:bg-emerald-50"
                          title={t('common:action.approve')}
                        >
                          <CheckCircle className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {user.status !== 'pending' && (
                        <button
                          type="button"
                          onClick={() => toggleStatus(user)}
                          className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                          title={user.status === 'active' ? t('users:action.suspend', { defaultValue: 'Suspend' }) : t('users:action.activate', { defaultValue: 'Activate' })}
                        >
                          <Ban className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {dialogMode && (
        <ConsoleDialogShell
          onClose={closeDialog}
          panelClassName={`${consoleDialogMdClass} max-h-[calc(100vh-2rem)] overflow-y-auto p-6`}
        >
              <h2 className="font-bold text-lg text-zinc-900 mb-4">
                {dialogMode === 'create' ? t('users:dialog.create_user') : t('users:dialog.edit_user', { username: editingUser?.username })}
              </h2>
              <form onSubmit={handleSave} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={`block mb-1 ${consoleSectionLabelClass}`}>{t('users:field.username')}</label>
                    <Input
                      required
                      disabled={dialogMode === 'edit'}
                      value={form.username}
                      onChange={(e) => setForm({ ...form, username: e.target.value })}
                      className="h-9 py-1.5"
                    />
                  </div>
                  {dialogMode === 'create' && (
                    <div>
                      <label className={`block mb-1 ${consoleSectionLabelClass}`}>{t('users:field.password')}</label>
                      <Input
                        required
                        type="password"
                        value={form.password}
                        onChange={(e) => setForm({ ...form, password: e.target.value })}
                        className="h-9 py-1.5"
                      />
                    </div>
                  )}
                  <div>
                    <label className={`block mb-1 ${consoleSectionLabelClass}`}>{t('users:field.role')}</label>
                    <SelectMenu
                      value={form.role}
                      onChange={(v) => setForm({ ...form, role: v })}
                      options={[
                        { value: 'user', label: t('users:role.user') },
                        { value: 'admin', label: t('users:role.admin') },
                      ]}
                    />
                  </div>
                  <div>
                    <label className={`block mb-1 ${consoleSectionLabelClass}`}>{t('users:field.status')}</label>
                    <SelectMenu
                      value={form.status}
                      onChange={(v) => setForm({ ...form, status: v })}
                      options={[
                        { value: 'active', label: t('users:status.active') },
                        { value: 'pending', label: t('users:status.pending') },
                        { value: 'suspended', label: t('users:status.suspended') },
                      ]}
                    />
                  </div>
                </div>

                {form.role !== 'admin' && (
                <div className={`${consoleCardClass} p-4 space-y-3`}>
                  <h3 className={consoleSectionLabelClass}>{t('users:field.quota')}</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-zinc-500">{t('users:field.max_projects', { defaultValue: 'Workspaces' })}</label>
                      <Input
                        type="number"
                        min={0}
                        value={form.max_projects}
                        onChange={(e) => setForm({ ...form, max_projects: e.target.value })}
                        className="h-8 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500">{t('users:field.max_sessions', { defaultValue: 'Sessions' })}</label>
                      <Input
                        type="number"
                        min={0}
                        value={form.max_sessions}
                        onChange={(e) => setForm({ ...form, max_sessions: e.target.value })}
                        className="h-8 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500">{t('users:field.max_previews', { defaultValue: 'Previews' })}</label>
                      <Input
                        type="number"
                        min={0}
                        value={form.max_previews}
                        onChange={(e) => setForm({ ...form, max_previews: e.target.value })}
                        className="h-8 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500">{t('users:field.resource_tier')}</label>
                      <SelectMenu
                        value={form.resource_tier}
                        onChange={(v) => setForm({ ...form, resource_tier: v })}
                        options={[
                          { value: 'basic', label: t('users:tier.basic') },
                          { value: 'pro', label: t('users:tier.pro') },
                          { value: 'enterprise', label: t('users:tier.enterprise') },
                        ]}
                      />
                    </div>
                  </div>
                </div>
                )}

                {form.role !== 'admin' && (
                  <MultiSelectMenu
                    label={t('users:field.agent_auth', { defaultValue: 'Agent access' })}
                    value={form.agent_ids}
                    onChange={(agent_ids) => setForm({ ...form, agent_ids })}
                    options={agentOptions}
                    placeholder={t('users:field.select_agents', { defaultValue: 'Select agents' })}
                    showSelectAll
                  />
                )}

                {dialogMode === 'edit' && (
                  <div>
                    <label className={`flex items-center gap-1 mb-1 ${consoleSectionLabelClass}`}>
                      <KeyRound className="w-3 h-3" />
                      {t('users:field.reset_password_optional')}
                    </label>
                    <Input
                      type="password"
                      placeholder={t('users:field.leave_blank')}
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      className="h-9 py-1.5"
                    />
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="secondary" size="md" onClick={closeDialog}>
                    {t('users:action.cancel')}
                  </Button>
                  <Button type="submit" size="md" disabled={saving}>
                    {saving ? t('users:action.saving', { defaultValue: 'Saving…' }) : t('users:action.save')}
                  </Button>
                </div>
              </form>
        </ConsoleDialogShell>
      )}
    </div>
  );
}
