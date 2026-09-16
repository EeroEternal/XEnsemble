import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Pencil, Pause, Play, CheckCircle, Clock, KeyRound, Loader2, RefreshCw, Search } from 'lucide-react';

import Button from '../components/Button';
import Input from '../components/Input';
import PageHeader from '../components/PageHeader';
import RowActionsMenu from '../components/RowActionsMenu';
import SelectMenu from '../components/SelectMenu';
import StatusBadge from '../components/StatusBadge';
import { ConsoleDialogShell } from '../components/ConsoleDialog';
import { useToast } from '../components/Toast';
import {
  consoleCardClass,
  consoleDialogMdClass,
  consoleAdminPageClass,
  consoleAdminTableScrollClass,
  consoleAdminTableShellClass,
  consoleIconButtonClass,
  consoleSectionLabelClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
} from '../lib/consoleTokens';

import { apiFetch } from '../lib/api';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { formatTokens, formatTokensFull } from '../lib/formatTokens';
import { useTranslation } from 'react-i18next';

const emptyForm = {
  username: '',
  password: '',
  role: 'user',
  status: 'active',
  max_projects: 5,
  max_sessions: 20,
  max_previews: 1,
  resource_tier: 'basic',
};

export default function UsersAdmin() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showToast } = useToast();

  function statusBadge(status) {
    const map = {
      active: { tone: 'success', icon: CheckCircle, label: t('users:status.active') },
      pending: { tone: 'warning', icon: Clock, label: t('users:status.pending') },
      suspended: { tone: 'danger', icon: Pause, label: t('users:status.suspended') },
    };
    return map[status] || { tone: 'neutral', icon: null, label: status || t('users:status.unknown', { defaultValue: 'Unknown' }) };
  }

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [dialogMode, setDialogMode] = useState(null);
  const [editingUser, setEditingUser] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [resetPassword, setResetPassword] = useState('');

  const fetchUsers = useCallback(({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    return apiFetch('/api/v1/admin/users')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setUsers(data);
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const openCreate = () => {
    setForm({ ...emptyForm });
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
      });
      setResetPassword('');
      setDialogMode('edit');
    } catch (err) {
      showToast('error', err.message);
    }
  };

  const closeDialog = () => {
    setDialogMode(null);
    setEditingUser(null);
    setResetPassword('');
  };

  const handleSave = async (e) => {
    e.preventDefault();
    try {
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

        if (resetPassword.trim()) {
          if (resetPassword.length < 8) {
            showToast('error', t('users:error.password_too_short'));
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
    } catch (err) {
      showToast('error', err.message);
    }
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

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => (u.username || '').toLowerCase().includes(q));
  }, [users, searchQuery]);

  return (
    <div className={consoleAdminPageClass}>
      <PageHeader title={t('users:title')} />

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-zinc-500 shrink-0">{t('users:count', { count: users.length, defaultValue: '{{count}} users' })}</span>
        <div className="flex items-center gap-2">
          <div className="relative w-64 shrink-0">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('users:search_placeholder', { defaultValue: 'Search users…' })}
              className="w-full pl-8"
            />
          </div>
          <button
            type="button"
            onClick={() => fetchUsers()}
            disabled={refreshing}
            className={consoleIconButtonClass}
            title={t('common:action.refresh')}
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <Button type="button" onClick={openCreate} size="md" className="shrink-0">
            <Plus className="w-4 h-4" />
            {t('users:add_user')}
          </Button>
        </div>
      </div>

      <div className={consoleAdminTableShellClass}>
        <div className={consoleAdminTableScrollClass}>
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col className="w-1/6" />
              <col className="w-1/6" />
              <col className="w-1/6" />
              <col className="w-1/6" />
              <col className="w-1/6" />
              <col className="w-48" />
            </colgroup>
            <thead className="sticky top-0 z-10 console-table-head-sticky">
              <tr className={consoleTableHeadRowClass}>
                <th className={consoleTableHeadCellClass}>{t('users:field.user')}</th>
                <th className={consoleTableHeadCellClass}>{t('users:field.status')}</th>
                <th className={consoleTableHeadCellClass}>{t('users:field.usage')}</th>
                <th className={consoleTableHeadCellClass}>{t('users:usage.token_7d')}</th>
                <th className={consoleTableHeadCellClass}>{t('users:field.last_login')}</th>
                <th className={consoleTableHeadCellClass}>{t('common:table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className={`${consoleTableBodyCellClass} text-zinc-400`}>{t('common:state.loading')}</td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className={`${consoleTableBodyCellClass} text-center text-zinc-400`}>
                    {users.length === 0 ? t('users:empty.no_users', { defaultValue: 'No users yet.' }) : t('users:empty.no_match', { defaultValue: 'No users match your search.' })}
                  </td>
                </tr>
              ) : filteredUsers.map((user) => (
                <tr key={user.id} className="hover:bg-zinc-50/50">
                  <td className={consoleTableBodyCellClass}>
                    <div className="font-medium text-zinc-900 truncate">{user.username}</div>
                    <div className="text-xs text-zinc-400">{user.role}</div>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <StatusBadge tone={statusBadge(user.status).tone} icon={statusBadge(user.status).icon} label={statusBadge(user.status).label} />
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <div className="flex flex-col gap-0.5 text-xs text-zinc-600">
                      <span>{t('users:field.projects')} {user.projects_count}/{user.quotas?.max_projects == null ? t('common:state.unlimited') : user.quotas.max_projects}</span>
                      <span>{t('users:field.sessions')} {user.active_sessions}/{user.quotas?.max_sessions == null ? t('common:state.unlimited') : user.quotas.max_sessions}</span>
                      <span>{t('users:field.previews')} {user.active_previews}/{user.quotas?.max_previews == null ? t('common:state.unlimited') : user.quotas.max_previews}</span>
                    </div>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <button
                      type="button"
                      onClick={() => navigate(`/observability?section=usage&user=${user.id}`)}
                      className="font-mono text-xs tabular-nums text-zinc-700 hover:text-blue-600 hover:underline"
                      title={formatTokensFull(user.usage_7d_total_tokens || 0)}
                    >
                      {formatTokens(user.usage_7d_total_tokens || 0)}
                    </button>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <span className="text-xs text-zinc-500" title={user.last_login_at ? new Date(user.last_login_at).toLocaleString() : undefined}>
                      {formatRelativeTime(user.last_login_at) || '—'}
                    </span>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <RowActionsMenu
                      label={t('users:action.actions_for', { username: user.username })}
                      items={[
                        { icon: Pencil, label: t('common:action.edit'), onClick: () => openEdit(user) },
                        user.status === 'pending' && {
                          icon: CheckCircle,
                          label: t('common:action.approve'),
                          onClick: () => approveUser(user),
                        },
                        user.status !== 'pending' && (
                          user.status === 'active'
                            ? { icon: Pause, label: t('users:action.suspend', { defaultValue: 'Suspend' }), danger: true, onClick: () => toggleStatus(user) }
                            : { icon: Play, label: t('common:action.activate'), onClick: () => toggleStatus(user) }
                        ),
                      ].filter(Boolean)}
                    />
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
                    <label className={`block mb-1 ${consoleSectionLabelClass}`}>{t('users:field.username')}<span className="text-red-500 ml-0.5">*</span></label>
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
                      <label className={`block mb-1 ${consoleSectionLabelClass}`}>{t('users:field.password')}<span className="text-red-500 ml-0.5">*</span></label>
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
                  <h3 className={consoleSectionLabelClass}>{t('users:field.quota', { defaultValue: 'Quotas' })}</h3>
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
                  </div>
                </div>
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
                    {t('common:action.cancel')}
                  </Button>
                  <Button type="submit" size="md">
                    {t('users:action.save')}
                  </Button>
                </div>
              </form>
        </ConsoleDialogShell>
      )}
    </div>
  );
}
