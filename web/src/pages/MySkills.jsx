import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Pencil, CheckCircle, Archive, Play, Trash2, UploadCloud, ArrowDownToLine,
  Loader2, RefreshCw, Search, ArrowUpCircle, Store,
} from 'lucide-react';

import Button from '../components/Button';
import Input from '../components/Input';
import PageHeader from '../components/PageHeader';
import RowActionsMenu from '../components/RowActionsMenu';
import SelectMenu from '../components/SelectMenu';
import StatusBadge from '../components/StatusBadge';
import { ConsoleDialogShell, ConsoleStructuredDialogHeader, ConsoleStructuredDialogBody, ConsoleStructuredDialogFooter } from '../components/ConsoleDialog';
import { confirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import {
  consoleAdminPageClass,
  consoleAdminTableScrollClass,
  consoleAdminTableShellClass,
  consoleIconButtonClass,
  consoleStructuredDialogPanelClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
} from '../lib/consoleTokens';

import {
  listMySkills, createSkill, updateSkill, changeStatus, deleteSkill, publishSkill, unpublishSkill,
  importSkillFromFiles, syncSkill,
} from '../lib/skillsApi';

const STATUS_META = {
  draft: { tone: 'neutral', icon: null, key: 'status_draft' },
  active: { tone: 'success', icon: Play, key: 'status_active' },
  archived: { tone: 'warning', icon: Archive, key: 'status_archived' },
};

const emptyForm = { title: '', content: '', tags: '', category: '', scripts: '[]' };

/** scripts 数组 ↔ 表单 JSON 文本 */
function scriptsToText(scripts) {
  try {
    return JSON.stringify(Array.isArray(scripts) ? scripts : [], null, 2);
  } catch {
    return '[]';
  }
}

function textToScripts(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const parsed = JSON.parse(t);
  if (!Array.isArray(parsed)) throw new Error('not array');
  return parsed;
}

export default function MySkills({ className = '', 'aria-hidden': ariaHidden }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [dialogMode, setDialogMode] = useState(null); // 'create' | 'edit'
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  const fetchSkills = useCallback(({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    return listMySkills({ status: statusFilter || '', q: searchQuery.trim() })
      .then((data) => setSkills(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [statusFilter, searchQuery]);

  useEffect(() => { void fetchSkills(); }, [fetchSkills]);

  // P3: 提炼/其他页面创建技能后自动刷新本列表
  useEffect(() => {
    const onSkillsChanged = () => void fetchSkills({ silent: true });
    window.addEventListener('xensemble:skills_changed', onSkillsChanged);
    return () => window.removeEventListener('xensemble:skills_changed', onSkillsChanged);
  }, [fetchSkills]);

  const openCreate = () => {
    setForm(emptyForm);
    setEditing(null);
    setDialogMode('create');
  };

  const openEdit = (skill) => {
    setEditing(skill);
    setForm({
      title: skill.title,
      content: skill.content,
      tags: (skill.tags || []).join(', '),
      category: skill.category || '',
      scripts: scriptsToText(skill.scripts),
    });
    setDialogMode('edit');
  };

  const closeDialog = () => { setDialogMode(null); setEditing(null); };

  const save = async () => {
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      showToast('error', t('skills:toast_required', { defaultValue: 'Title and content are required' }));
      return;
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(title)) {
      showToast('error', t('skills:name_invalid', { defaultValue: 'Only lowercase letters, numbers, and hyphens allowed (e.g. my-skill)' }));
      return;
    }
    let scripts = [];
    try {
      scripts = textToScripts(form.scripts);
    } catch {
      showToast('error', t('skills:scripts_invalid_json', { defaultValue: 'Scripts must be a valid JSON array' }));
      return;
    }
    setSaving(true);
    try {
      const tags = form.tags.split(',').map((s) => s.trim()).filter(Boolean);
      if (dialogMode === 'create') {
        await createSkill({ title, content, tags, category: form.category || null, scripts });
        showToast('success', t('skills:toast_created', { defaultValue: 'Skill created.' }));
      } else {
        await updateSkill(editing.id, { title, content, tags, category: form.category || null, scripts });
        showToast('success', t('skills:toast_updated', { defaultValue: 'Skill updated.' }));
      }
      closeDialog();
      fetchSkills({ silent: true });
    } catch (err) {
      // P0 安全治理：安全扫描拦截 → 专用提示（含命中规则明细）
      if (err?.code === 'skill_script_blocked') {
        const detail = (err.findings || []).map((f) => `${f.path}: ${f.rule}`).join('; ');
        showToast('error', detail ? `${t('skills:error_script_blocked')} (${detail})` : t('skills:error_script_blocked'));
        return;
      }
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn, okMsg, errMsg) => {
    try {
      await fn();
      showToast('success', okMsg);
      fetchSkills({ silent: true });
    } catch (err) {
      // 0021：激活未过落盘门槛 → 明确提示原因
      if (err?.code === 'skill_not_landable') {
        showToast('error', t('skills:error_not_landable', { defaultValue: 'Skill cannot be activated (frontmatter/confidence not satisfied).' }));
        return;
      }
      // P0-2：draft/archived 直接发布 → 引导先激活
      if (err?.code === 'skill_publish_requires_active') {
        showToast('error', t('skills:error_publish_requires_active', { defaultValue: 'Only active skills can be published. Activate the skill first.' }));
        return;
      }
      // P0-1：发布时安全扫描拦截
      if (err?.code === 'skill_script_blocked') {
        const detail = (err.findings || []).map((f) => `${f.path}: ${f.rule}`).join('; ');
        showToast('error', detail ? `${t('skills:error_script_blocked')} (${detail})` : t('skills:error_script_blocked'));
        return;
      }
      showToast('error', err.message || errMsg);
    }
  };

  // 0024：浏览器选择本地文件夹 → 读取全部文件 → 上传导入（无需服务端可见路径）
  const fileInputRef = useRef(null);
  const handleImportFolder = (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = ''; // 允许重复选择同一文件夹
    if (picked.length === 0) return;
    if (picked.length > 500) {
      showToast('error', t('skills:import_too_many', { defaultValue: 'Too many files (max 500).' }));
      return;
    }
    setImporting(true);
    const readers = picked.map((file) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ path: file.webkitRelativePath || file.name, content: String(reader.result || '') });
      reader.onerror = () => resolve({ path: file.webkitRelativePath || file.name, content: '' });
      reader.readAsText(file);
    }));
    Promise.all(readers)
      .then((files) => importSkillFromFiles(files))
      .then((res) => {
        // P0 安全治理：部分技能被扫描拦截时提示（导入成功的照常展示）
        const blockedCount = Array.isArray(res.blocked) ? res.blocked.length : 0;
        showToast('success', t('skills:import_done', { count: res.imported, defaultValue: '{{count}} skill(s) imported.' }));
        if (blockedCount > 0) {
          const names = res.blocked.map((b) => b.name).join(', ');
          showToast('error', `${t('skills:error_import_blocked', { defaultValue: 'Some imported skills were blocked by the security scan.' })} (${names})`);
        }
        fetchSkills({ silent: true });
      })
      .catch((err) => {
        if (err?.code === 'skill_import_blocked' || err?.code === 'skill_script_blocked') {
          const detail = (err.findings || []).map((f) => `${f.path ?? f.name}: ${f.rule}`).join('; ');
          showToast('error', detail ? `${t('skills:error_script_blocked')} (${detail})` : t('skills:error_script_blocked'));
          return;
        }
        showToast('error', err.message || t('skills:toast_action_failed', { defaultValue: 'Action failed.' }));
      })
      .finally(() => setImporting(false));
  };

  const togglePublish = (skill) => act(
    () => (skill.visibility === 'public' ? unpublishSkill(skill.id) : publishSkill(skill.id)),
    t(skill.visibility === 'public' ? 'skills:toast_unpublished' : 'skills:toast_published', { defaultValue: 'Done.' }),
    t('skills:toast_action_failed', { defaultValue: 'Action failed.' }),
  );

  // 同步已安装技能到源的最新版本
  const handleSync = (skill) => act(
    () => syncSkill(skill.id),
    t('skills:toast_synced', { defaultValue: 'Synced to latest.' }),
    t('skills:toast_action_failed', { defaultValue: 'Action failed.' }),
  );

  // 删除前二次确认（对齐 ConfirmDialog 规范）
  const handleDelete = async (skill) => {
    const ok = await confirm({
      title: t('common:dialog.confirm_delete', { name: skill.title, defaultValue: `Delete "${skill.title}"?` }),
      message: t('common:dialog.cannot_undo', { defaultValue: 'This action cannot be undone.' }),
      confirmLabel: t('common:action.delete'),
      cancelLabel: t('common:action.cancel'),
      variant: 'danger',
    });
    if (!ok) return;
    await act(() => deleteSkill(skill.id), t('skills:toast_deleted', { defaultValue: 'Skill deleted.' }), t('skills:toast_action_failed', { defaultValue: 'Action failed.' }));
  };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => (s.title || '').toLowerCase().includes(q));
  }, [skills, searchQuery]);

  const statusOptions = [
    { value: '', label: t('skills:filter_all_status', { defaultValue: 'All statuses' }) },
    { value: 'draft', label: t('skills:status_draft', { defaultValue: 'Draft' }) },
    { value: 'active', label: t('skills:status_active', { defaultValue: 'Active' }) },
    { value: 'archived', label: t('skills:status_archived', { defaultValue: 'Archived' }) },
  ];

  return (
    <div className={`${consoleAdminPageClass} px-4 sm:px-6 lg:px-8 py-6 ${className}`} aria-hidden={ariaHidden}>
      <PageHeader title={t('skills:my_skills')} />

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-zinc-500 shrink-0">{t('skills:count', { count: skills.length, defaultValue: '{{count}} skills' })}</span>
        <div className="flex items-center gap-2">
          <div className="w-40 shrink-0">
            <SelectMenu value={statusFilter} onChange={(v) => setStatusFilter(v)} options={statusOptions} placeholder={t('skills:filter_all_status', { defaultValue: 'All statuses' })} />
          </div>
          <div className="relative w-56 shrink-0">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder={t('skills:search_placeholder')} className="w-full pl-8" />
          </div>
          <button type="button" onClick={() => fetchSkills()} disabled={refreshing} className={consoleIconButtonClass} title={t('common:action.refresh')}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <Button type="button" onClick={() => navigate('/skills/market')} variant="secondary" size="md" className="shrink-0">
            <Store className="w-4 h-4" />
            {t('skills:market', { defaultValue: 'Skills Market' })}
          </Button>
          <Button type="button" onClick={() => fileInputRef.current?.click()} disabled={importing} variant="secondary" size="md" className="shrink-0">
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
            {t('skills:import', { defaultValue: 'Import Skill' })}
          </Button>
          <Button type="button" onClick={openCreate} size="md" className="shrink-0">
            <Plus className="w-4 h-4" />
            {t('skills:create', { defaultValue: 'New Skill' })}
          </Button>
          <input ref={fileInputRef} type="file" className="hidden" webkitdirectory="" directory="" onChange={handleImportFolder} title={t('skills:import_folder', { defaultValue: 'Select a folder containing skills' })} />
        </div>
      </div>

      <div className={consoleAdminTableShellClass}>
        <div className={consoleAdminTableScrollClass}>
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col className="w-2/5" />
              <col className="w-1/6" />
              <col className="w-1/6" />
              <col className="w-1/6" />
              <col className="w-40" />
            </colgroup>
            <thead>
              <tr className={consoleTableHeadRowClass}>
                <th className={consoleTableHeadCellClass}>{t('skills:field_title', { defaultValue: 'Title' })}</th>
                <th className={consoleTableHeadCellClass}>{t('skills:field_status', { defaultValue: 'Status' })}</th>
                <th className={consoleTableHeadCellClass}>{t('skills:field_market', { defaultValue: 'Market' })}</th>
                <th className={consoleTableHeadCellClass}>{t('skills:field_source', { defaultValue: 'Source' })}</th>
                <th className={consoleTableHeadCellClass}>{t('common:table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading ? (
                <tr><td colSpan={5} className={`${consoleTableBodyCellClass} text-zinc-400`}>{t('common:state.loading')}</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={5} className={`${consoleTableBodyCellClass} text-center text-zinc-400`}>{t('skills:empty_my', { defaultValue: 'No skills yet.' })}</td></tr>
              ) : filtered.map((s) => {
                const meta = STATUS_META[s.status] || STATUS_META.draft;
                return (
                  <tr key={s.id} className="hover:bg-zinc-50/50">
                    <td className={consoleTableBodyCellClass}>
                      <div className="font-medium text-zinc-900 truncate">{s.title}</div>
                      <div className="text-xs text-zinc-400 truncate">{s.content}</div>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <StatusBadge tone={meta.tone} icon={meta.icon} label={t(`skills:${meta.key}`, { defaultValue: s.status })} />
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      {s.visibility === 'public' && s.publishedAt ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                          <UploadCloud className="w-3.5 h-3.5" />
                          {t('skills:published_badge')} · {s.installCount ?? 0}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-400">{t('skills:private_badge', { defaultValue: 'Private' })}</span>
                      )}
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <span className="text-xs text-zinc-500">{t(`skills:source_${s.source}`, { defaultValue: s.source })}</span>
                    </td>
                    <td className={consoleTableBodyCellClass}>
                      <RowActionsMenu
                        label={t('skills:actions_for', { title: s.title, defaultValue: 'Actions for skill' })}
                        items={[
                          s.status !== 'active' && s.source !== 'installed' && { icon: Pencil, label: t('common:action.edit'), onClick: () => openEdit(s) },
                          s.status === 'draft' && { icon: CheckCircle, label: t('skills:action_activate', { defaultValue: 'Activate' }), onClick: () => act(() => changeStatus(s.id, 'activate'), t('skills:toast_updated', { defaultValue: 'Done.' })) },
                          s.status === 'active' && { icon: Archive, label: t('skills:action_archive', { defaultValue: 'Archive' }), onClick: () => act(() => changeStatus(s.id, 'archive'), t('skills:toast_updated', { defaultValue: 'Done.' })) },
                          s.status === 'archived' && { icon: Play, label: t('skills:action_restore', { defaultValue: 'Restore' }), onClick: () => act(() => changeStatus(s.id, 'restore'), t('skills:toast_updated', { defaultValue: 'Done.' })) },
                          // P0-2：仅 active 技能可上架（后端 skill_publish_requires_active 兜底）
                          s.status === 'active' && s.source !== 'installed' && { icon: s.visibility === 'public' ? ArrowDownToLine : UploadCloud, label: t(s.visibility === 'public' ? 'skills:action_unpublish' : 'skills:action_publish', { defaultValue: 'Toggle market' }), onClick: () => togglePublish(s) },
                          s.updateInfo?.hasUpdate && { icon: ArrowUpCircle, label: t('skills:action_sync', { defaultValue: 'Sync to latest' }), onClick: () => handleSync(s) },
                          { icon: Trash2, label: t('common:action.delete'), danger: true, onClick: () => handleDelete(s) },
                        ].filter(Boolean)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {dialogMode && (
        <ConsoleDialogShell
          onClose={closeDialog}
          panelClassName={consoleStructuredDialogPanelClass}
        >
          <ConsoleStructuredDialogHeader
            title={t(dialogMode === 'create' ? 'skills:create' : 'skills:edit', { defaultValue: dialogMode === 'create' ? 'New Skill' : 'Edit Skill' })}
          />
          <ConsoleStructuredDialogBody>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">{t('skills:field_name', { defaultValue: 'Name (slug)' })}</label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="my-skill-name" autoFocus />
              {form.title && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(form.title) && (
                <p className="text-xs text-red-500 mt-1">{t('skills:name_invalid', { defaultValue: 'Only lowercase letters, numbers, and hyphens allowed (e.g. my-skill)' })}</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">{t('skills:field_category', { defaultValue: 'Category' })}</label>
              <SelectMenu
                value={form.category}
                onChange={(v) => setForm({ ...form, category: v })}
                options={[
                  { value: '', label: t('skills:all_categories') },
                  { value: 'workflow', label: t('skills:category_workflow') },
                  { value: 'convention', label: t('skills:category_convention') },
                  { value: 'debug', label: t('skills:category_debug') },
                  { value: 'database', label: t('skills:category_database') },
                  { value: 'devops', label: t('skills:category_devops') },
                  { value: 'codegen', label: t('skills:category_codegen') },
                ]}
                placeholder={t('skills:all_categories')}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">{t('skills:field_tags', { defaultValue: 'Tags' })}</label>
              <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder={t('skills:tags_placeholder', { defaultValue: 'drizzle, postgres, migration' })} />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">{t('skills:field_content', { defaultValue: 'Content (markdown)' })}</label>
              <textarea
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                rows={8}
                placeholder={t('skills:content_placeholder')}
                className="w-full bg-surface border border-zinc-300 rounded-md px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">{t('skills:field_scripts', { defaultValue: 'Scripts (optional, JSON array)' })}</label>
              <textarea
                value={form.scripts}
                onChange={(e) => setForm({ ...form, scripts: e.target.value })}
                rows={5}
                placeholder={t('skills:scripts_placeholder')}
                className="w-full bg-surface border border-zinc-300 rounded-md px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors font-mono"
              />
              <p className="mt-1 text-[11px] text-zinc-400">{t('skills:scripts_hint')}</p>
            </div>
          </ConsoleStructuredDialogBody>
          <ConsoleStructuredDialogFooter>
            <Button variant="ghost" onClick={closeDialog}>{t('common:action.cancel')}</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('common:action.save')}
            </Button>
          </ConsoleStructuredDialogFooter>
        </ConsoleDialogShell>
      )}
    </div>
  );
}
