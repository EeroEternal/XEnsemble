import { useState, useEffect, useCallback, useMemo } from 'react';
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
  consoleIconButtonClass,
  consoleSectionLabelClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
  consoleTableShellClass,
} from '../lib/consoleTokens';

import { apiFetch } from '../lib/api';
import { formatRelativeTime } from '../lib/formatRelativeTime';

function statusBadge(status) {
  const map = {
    active: { tone: 'success', icon: CheckCircle, label: 'Active' },
    pending: { tone: 'warning', icon: Clock, label: 'Pending' },
    suspended: { tone: 'danger', icon: Pause, label: 'Suspended' },
  };
  return map[status] || { tone: 'neutral', icon: null, label: status || 'Unknown' };
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
};

export default function UsersAdmin() {
  
  const { showToast } = useToast();
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
          showToast('error', 'Password must be at least 8 characters.');
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
        showToast('success', 'User created.');
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
            showToast('error', 'New password must be at least 8 characters.');
            return;
          }
          const pwRes = await apiFetch(`/api/v1/admin/users/${editingUser.id}/reset-password`, {
            method: 'POST',
            
            body: JSON.stringify({ password: resetPassword }),
          });
          const pwData = await pwRes.json();
          if (!pwRes.ok) throw new Error(pwData.error);
        }

        showToast('success', 'User updated.');
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
      showToast('success', next === 'active' ? 'User activated.' : 'User suspended.');
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
      showToast('success', 'User approved.');
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
      <PageHeader title="Users" />

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-zinc-500 shrink-0">{users.length} users</span>
        <div className="flex items-center gap-2">
          <div className="relative w-64 shrink-0">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search users…"
              className="w-full pl-8"
            />
          </div>
          <button
            type="button"
            onClick={() => fetchUsers()}
            disabled={refreshing}
            className={consoleIconButtonClass}
            title="Refresh"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <Button type="button" onClick={openCreate} size="md" className="shrink-0">
            <Plus className="w-4 h-4" />
            Add User
          </Button>
        </div>
      </div>

      <div className={consoleTableShellClass}>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col className="w-1/6" />
              <col className="w-1/6" />
              <col className="w-1/6" />
              <col className="w-1/6" />
              <col className="w-1/6" />
              <col className="w-48" />
            </colgroup>
            <thead>
              <tr className={consoleTableHeadRowClass}>
                <th className={consoleTableHeadCellClass}>User</th>
                <th className={consoleTableHeadCellClass}>Status</th>
                <th className={consoleTableHeadCellClass}>Usage</th>
                <th className={consoleTableHeadCellClass} title="Resource tier — controls LLM request rate">Tier</th>
                <th className={consoleTableHeadCellClass}>Last login</th>
                <th className={consoleTableHeadCellClass}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className={`${consoleTableBodyCellClass} text-zinc-400`}>Loading…</td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className={`${consoleTableBodyCellClass} text-center text-zinc-400`}>
                    {users.length === 0 ? 'No users yet.' : 'No users match your search.'}
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
                      <span>Workspaces {user.projects_count}/{user.quotas?.max_projects == null ? 'Unlimited' : user.quotas.max_projects}</span>
                      <span>Sessions {user.active_sessions}/{user.quotas?.max_sessions == null ? 'Unlimited' : user.quotas.max_sessions}</span>
                      <span>Previews {user.active_previews}/{user.quotas?.max_previews == null ? 'Unlimited' : user.quotas.max_previews}</span>
                    </div>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <span className="text-xs text-zinc-500">{user.quotas?.resource_tier ?? 'basic'}</span>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <span className="text-xs text-zinc-500" title={user.last_login_at ? new Date(user.last_login_at).toLocaleString() : undefined}>
                      {formatRelativeTime(user.last_login_at) || '—'}
                    </span>
                  </td>
                  <td className={consoleTableBodyCellClass}>
                    <RowActionsMenu
                      label={`Actions for ${user.username}`}
                      items={[
                        { icon: Pencil, label: 'Edit', onClick: () => openEdit(user) },
                        user.status === 'pending' && {
                          icon: CheckCircle,
                          label: 'Approve',
                          onClick: () => approveUser(user),
                        },
                        user.status !== 'pending' && (
                          user.status === 'active'
                            ? { icon: Pause, label: 'Suspend', danger: true, onClick: () => toggleStatus(user) }
                            : { icon: Play, label: 'Activate', onClick: () => toggleStatus(user) }
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
                {dialogMode === 'create' ? 'Create user' : `Edit ${editingUser?.username}`}
              </h2>
              <form onSubmit={handleSave} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={`block mb-1 ${consoleSectionLabelClass}`}>Username</label>
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
                      <label className={`block mb-1 ${consoleSectionLabelClass}`}>Password</label>
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
                    <label className={`block mb-1 ${consoleSectionLabelClass}`}>Role</label>
                    <SelectMenu
                      value={form.role}
                      onChange={(v) => setForm({ ...form, role: v })}
                      options={[
                        { value: 'user', label: 'User' },
                        { value: 'admin', label: 'Admin' },
                      ]}
                    />
                  </div>
                  <div>
                    <label className={`block mb-1 ${consoleSectionLabelClass}`}>Status</label>
                    <SelectMenu
                      value={form.status}
                      onChange={(v) => setForm({ ...form, status: v })}
                      options={[
                        { value: 'active', label: 'Active' },
                        { value: 'pending', label: 'Pending' },
                        { value: 'suspended', label: 'Suspended' },
                      ]}
                    />
                  </div>
                </div>

                {form.role !== 'admin' && (
                <div className={`${consoleCardClass} p-4 space-y-3`}>
                  <h3 className={consoleSectionLabelClass}>Quotas</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-zinc-500">Workspaces</label>
                      <Input
                        type="number"
                        min={0}
                        value={form.max_projects}
                        onChange={(e) => setForm({ ...form, max_projects: e.target.value })}
                        className="h-8 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500">Sessions</label>
                      <Input
                        type="number"
                        min={0}
                        value={form.max_sessions}
                        onChange={(e) => setForm({ ...form, max_sessions: e.target.value })}
                        className="h-8 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500">Previews</label>
                      <Input
                        type="number"
                        min={0}
                        value={form.max_previews}
                        onChange={(e) => setForm({ ...form, max_previews: e.target.value })}
                        className="h-8 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500" title="Controls LLM request rate">Tier</label>
                      <SelectMenu
                        value={form.resource_tier}
                        onChange={(v) => setForm({ ...form, resource_tier: v })}
                        options={[
                          { value: 'basic', label: 'Basic' },
                          { value: 'pro', label: 'Pro' },
                          { value: 'enterprise', label: 'Enterprise' },
                        ]}
                      />
                    </div>
                  </div>
                </div>
                )}

                {dialogMode === 'edit' && (
                  <div>
                    <label className={`flex items-center gap-1 mb-1 ${consoleSectionLabelClass}`}>
                      <KeyRound className="w-3 h-3" />
                      Reset password (optional)
                    </label>
                    <Input
                      type="password"
                      placeholder="Leave blank to keep current"
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      className="h-9 py-1.5"
                    />
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="secondary" size="md" onClick={closeDialog}>
                    Cancel
                  </Button>
                  <Button type="submit" size="md">
                    Save
                  </Button>
                </div>
              </form>
        </ConsoleDialogShell>
      )}
    </div>
  );
}
