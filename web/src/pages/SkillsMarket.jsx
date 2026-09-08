import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Sparkles, Search, Download, User, Clock, Eye, X, Loader2,
  Database, GitBranch, Bug, ShieldCheck, Cloud, Puzzle, Layers, CheckCircle, FileEdit, Check, Copy, RefreshCw,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { getSkill } from '../lib/skillsApi';
import SelectMenu from '../components/SelectMenu';
import Button from '../components/Button';
import { useToast } from '../components/Toast';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import {
  consoleButtonFocusClass,
  consoleEmptyStateClass,
  consoleToolbarInputClass,
  consoleIconButtonClass,
} from '../lib/consoleTokens';

const PAGE_SIZE = 18;
const CATEGORY_ICONS = {
  database: Database,
  workflow: GitBranch,
  debug: Bug,
  convention: ShieldCheck,
  devops: Cloud,
  codegen: Puzzle,
};

// 分类配色（图标底色 / 徽章）——丰富卡片视觉层次
const CATEGORY_TINTS = {
  database: 'bg-blue-50 text-blue-700',
  workflow: 'bg-violet-50 text-violet-700',
  debug: 'bg-orange-50 text-orange-700',
  convention: 'bg-emerald-50 text-emerald-700',
  devops: 'bg-cyan-50 text-cyan-700',
  codegen: 'bg-pink-50 text-pink-700',
};

const CATEGORY_OPTIONS = [
  { value: '', labelKey: 'all_categories' },
  { value: 'workflow', labelKey: 'category_workflow' },
  { value: 'convention', labelKey: 'category_convention' },
  { value: 'debug', labelKey: 'category_debug' },
  { value: 'database', labelKey: 'category_database' },
  { value: 'devops', labelKey: 'category_devops' },
  { value: 'codegen', labelKey: 'category_codegen' },
];

const SORT_OPTIONS = [
  { value: 'hot', labelKey: 'sort_hot' },
  { value: 'newest', labelKey: 'sort_newest' },
  { value: 'installs', labelKey: 'sort_installs' },
];

function SkillIcon({ category }) {
  const Icon = CATEGORY_ICONS[category] || Sparkles;
  const tint = CATEGORY_TINTS[category] || 'bg-zinc-100 text-zinc-700';
  return (
    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${tint}`}>
      <Icon className="w-5 h-5" strokeWidth={1.75} />
    </div>
  );
}

export default function SkillsMarket({ className = '', 'aria-hidden': ariaHidden }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('hot');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [installingId, setInstallingId] = useState(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    const id = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('sort', sort);
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      if (category) params.set('category', category);
      if (debouncedSearch) params.set('q', debouncedSearch);
      const res = await apiFetch(`/api/v1/skills/market?${params.toString()}`);
      if (!res.ok) throw new Error('load_failed');
      const json = await res.json();
      if (id === requestIdRef.current) {
        setData({ items: json.items || [], total: Number(json.total) || 0 });
      }
    } catch {
      if (id === requestIdRef.current) setError(t('skills:empty_market', { defaultValue: 'Failed to load market' }));
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  }, [category, sort, debouncedSearch, page, t]);

  useEffect(() => { void load(); }, [load]);

  // 卡片内快速安装：直接复制为私有 skill，完成后刷新列表
  const quickInstall = useCallback(async (skill) => {
    if (installingId) return;
    setInstallingId(skill.id);
    try {
      const res = await apiFetch(`/api/v1/skills/market/${encodeURIComponent(skill.id)}/install`, { method: 'POST' });
      if (!res.ok) throw new Error('install_failed');
      showToast('success', t('skills:install_done', { defaultValue: 'Copied to My Skills' }));
      void load();
    } catch {
      showToast('error', t('skills:install_failed', { defaultValue: 'Failed to install skill' }));
    } finally {
      setInstallingId(null);
    }
  }, [installingId, load, showToast, t]);

  const categoryLabel = (v) => {
    const opt = CATEGORY_OPTIONS.find((o) => o.value === v);
    return opt ? t(`skills:${opt.labelKey}`) : '';
  };
  const sortLabel = (v) => {
    const opt = SORT_OPTIONS.find((o) => o.value === v);
    return opt ? t(`skills:${opt.labelKey}`) : '';
  };

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const selectedSkill = data.items.find((s) => s.id === selectedId) || null;

  const categoryOptions = CATEGORY_OPTIONS.map((o) => ({ value: o.value, label: t(`skills:${o.labelKey}`) }));
  const sortOptions = SORT_OPTIONS.map((o) => ({ value: o.value, label: t(`skills:${o.labelKey}`) }));

  return (
    <div className={`flex h-full min-h-0 flex-1 flex-col bg-surface ${className}`} aria-hidden={ariaHidden}>
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-200 px-6 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900">{t('skills:market_title')}</h1>
            <p className="mt-1 text-sm text-zinc-500">{t('skills:subtitle')}</p>
          </div>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-6 py-3">
        <div className="w-44">
          <SelectMenu value={category} onChange={(v) => { setCategory(v); setPage(1); }} options={categoryOptions} placeholder={t('skills:all_categories')} />
        </div>
        <div className="w-40">
          <SelectMenu value={sort} onChange={(v) => { setSort(v); setPage(1); }} options={sortOptions} placeholder={t('skills:sort_hot')} />
        </div>
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('skills:search_placeholder')}
            className={`${consoleToolbarInputClass} pl-8`}
          />
        </div>
        {!loading && data.total > 0 && (
          <span className="ml-auto text-xs text-zinc-500">
            {t('skills:result_count', { total: data.total, shown: data.items.length })}
          </span>
        )}
      </div>

      {/* Cards */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <div className={`${consoleEmptyStateClass} h-full`}>
            <p className="text-sm text-zinc-500">{error}</p>
          </div>
        ) : data.items.length === 0 ? (
          <div className={`${consoleEmptyStateClass} h-full`}>
            <p className="text-sm text-zinc-500">{t('skills:empty_market')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.items.map((s) => {
              const isMine = s.isMine;
              const description = s.description || '';
              const tint = CATEGORY_TINTS[s.category] || 'bg-zinc-100 text-zinc-700';
              return (
                <div
                  key={s.id}
                  className="group bg-surface border border-zinc-200 rounded-xl p-4 flex flex-col gap-3 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:border-zinc-300"
                >
                  <div className="flex items-start justify-between gap-2">
                    <SkillIcon category={s.category} />
                    <div className="flex items-center gap-1.5">
                      {isMine && (
                        <span className="text-[10px] font-medium text-emerald-700 bg-emerald-50 rounded-full px-2 py-0.5">
                          {t('skills:mine_badge')}
                        </span>
                      )}
                      {/* P2：已安装 / 有更新 角标（isInstalled/hasUpdate 由市场接口标注） */}
                      {s.isInstalled && !s.hasUpdate && (
                        <span className="text-[10px] font-medium text-zinc-600 bg-zinc-100 rounded-full px-2 py-0.5">
                          {t('skills:installed_badge', { defaultValue: 'Installed' })}
                        </span>
                      )}
                      {s.isInstalled && s.hasUpdate && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">
                          <RefreshCw className="w-2.5 h-2.5" />
                          {t('skills:update_badge', { defaultValue: 'Update available' })}
                        </span>
                      )}
                      {s.category && (
                        <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 ${tint}`}>
                          {categoryLabel(s.category)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="min-h-[52px]">
                    <h3 className="font-semibold text-sm text-zinc-900 leading-snug group-hover:text-zinc-950">{s.title}</h3>
                    {description ? (
                      <p className="text-xs text-zinc-500 mt-1 leading-relaxed line-clamp-2">{description}</p>
                    ) : null}
                  </div>
                  {s.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {s.tags.map((tag, i) => (
                        <span key={i} className="text-[10px] bg-zinc-100 text-zinc-600 rounded px-1.5 py-0.5">{tag}</span>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 mt-auto pt-2 border-t border-zinc-100">
                    <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                      <span className="inline-flex items-center gap-1"><Download className="w-3 h-3" /> {s.installCount ?? 0}</span>
                      <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {formatRelativeTime(s.publishedAt)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSelectedId(s.id)}
                        className={`inline-flex items-center gap-1 text-[11px] font-medium text-zinc-700 border border-zinc-300 rounded-md px-2.5 py-1 hover:bg-zinc-50 ${consoleButtonFocusClass}`}
                      >
                        <Eye className="w-3 h-3" />
                        {t('skills:preview')}
                      </button>
                      {/* P2：已安装 → 禁用；有更新 → 引导去「我的技能」同步 */}
                      {s.isInstalled ? (
                        <button
                          type="button"
                          onClick={() => navigate('/skills')}
                          title={t('skills:install_go_manage', { defaultValue: 'Manage in My Skills' })}
                          className={`inline-flex items-center gap-1 text-[11px] font-medium text-zinc-700 border border-zinc-300 rounded-md px-2.5 py-1 hover:bg-zinc-50 ${consoleButtonFocusClass}`}
                        >
                          {s.hasUpdate ? <RefreshCw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                          {s.hasUpdate ? t('skills:update_badge', { defaultValue: 'Update available' }) : t('skills:installed_badge', { defaultValue: 'Installed' })}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isMine || installingId === s.id}
                          title={t('skills:install')}
                          onClick={() => quickInstall(s)}
                          className={`inline-flex items-center gap-1 text-[11px] font-medium text-zinc-50 bg-zinc-900 rounded-md px-2.5 py-1 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
                        >
                          {installingId === s.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Copy className="w-3 h-3" />}
                          {installingId === s.id ? t('skills:install_loading', { defaultValue: 'Copying…' }) : t('skills:install')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {!loading && data.total > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-zinc-200 px-6 py-2.5">
          <span className="text-xs text-zinc-500">{t('skills:result_count', { total: data.total, shown: data.items.length })}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-100 disabled:pointer-events-none disabled:opacity-40 ${consoleButtonFocusClass}`}
              aria-label={t('skills:prev_page')}
            >
              <span aria-hidden>‹</span>
            </button>
            <span className="text-xs text-zinc-500">{page} / {totalPages}</span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-100 disabled:pointer-events-none disabled:opacity-40 ${consoleButtonFocusClass}`}
              aria-label={t('skills:next_page')}
            >
              <span aria-hidden>›</span>
            </button>
          </div>
        </div>
      )}

      {selectedSkill && createPortal(
        <SkillDetailDrawer skill={selectedSkill} onClose={() => setSelectedId(null)} />,
        document.body,
      )}
    </div>
  );
}

/* ---------------- Detail drawer ---------------- */

function SkillDetailDrawer({ skill, onClose }) {
  const { t } = useTranslation();
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [full, setFull] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getSkill(skill.id)
      .then((data) => { if (!cancelled) setFull(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [skill.id]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const detail = full || skill;

  const doInstall = async () => {
    if (installing || installed) return;
    setInstalling(true);
    try {
      const res = await apiFetch(`/api/v1/skills/market/${encodeURIComponent(skill.id)}/install`, { method: 'POST' });
      if (!res.ok) throw new Error('install_failed');
      setInstalled(true);
    } catch {
      // keep button recoverable
    } finally {
      setInstalling(false);
    }
  };

  const categoryLabel = (v) => {
    const opt = CATEGORY_OPTIONS.find((o) => o.value === v);
    return opt ? t(`skills:${opt.labelKey}`) : '';
  };

  const SigIcon = CATEGORY_ICONS[detail.category] || Sparkles;
  const authorName = detail.authorName || (detail.userId ? detail.userId.slice(0, 8) : null);

  return (
    <div className="fixed inset-0 z-[120]" role="dialog" aria-modal="true">
      <div className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${mounted ? 'opacity-100' : 'opacity-0'}`} onClick={onClose} />
      <div className={`absolute right-0 top-0 flex h-full w-full max-w-[720px] flex-col border-l border-zinc-200 bg-surface shadow-2xl transition-transform duration-200 ${mounted ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-zinc-100 flex items-center justify-center shrink-0">
              <SigIcon className="w-5 h-5 text-zinc-700" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-zinc-900">{detail.title}</h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                <span className="inline-flex items-center gap-1"><User className="w-3 h-3" /> {authorName}</span>
                <span className="inline-flex items-center gap-1"><Download className="w-3 h-3" /> {t('skills:installs', { count: detail.installCount ?? 0 })}</span>
                <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {formatRelativeTime(detail.publishedAt)}</span>
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} className={consoleIconButtonClass} aria-label={t('skills:open_detail')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {detail.signals && (() => {
            // P2：信号条 = 自动提炼的溯源证据。无任何可展示项时整体隐藏，
            // 避免出现只剩标题的空壳条；置信度补充展示（auto 技能均有）。
            const items = [];
            if (detail.clusterSize > 1) {
              items.push(
                <span key="cluster" className="inline-flex items-center gap-1"><Layers className="w-3.5 h-3.5" /> {t('skills:from_sessions', { count: detail.clusterSize })}</span>,
              );
            }
            if (detail.signals.successExit) {
              items.push(
                <span key="exit" className="inline-flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> {t('skills:success_exit')}</span>,
              );
            }
            if ((detail.signals.filesTouched ?? 0) > 0) {
              items.push(
                <span key="files" className="inline-flex items-center gap-1"><FileEdit className="w-3.5 h-3.5" /> {t('skills:files_touched', { count: detail.signals.filesTouched })}</span>,
              );
            }
            if (Number.isFinite(detail.confidence)) {
              items.push(
                <span key="confidence" className="inline-flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> {t('skills:confidence', { percent: Math.round(detail.confidence * 100) })}</span>,
              );
            }
            if (items.length === 0) return null;
            return (
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-600 bg-zinc-50 border border-zinc-200 rounded-lg p-3">
                <span className="font-semibold uppercase tracking-wider text-zinc-400">{t('skills:signals_evidence', { defaultValue: 'Distilled from sessions' })}</span>
                {items}
              </div>
            );
          })()}

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">{t('skills:detail_scenario')}</div>
            {/* P2：SKILL.md 是 markdown，按 markdown 渲染（标题/列表/代码块/表格） */}
            <div className="skill-md text-sm text-zinc-700 leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ node, ...props }) => <h2 className="mt-3 mb-1.5 text-base font-semibold text-zinc-900 first:mt-0" {...props} />,
                  h2: ({ node, ...props }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold text-zinc-900 first:mt-0" {...props} />,
                  h3: ({ node, ...props }) => <h4 className="mt-2.5 mb-1 text-sm font-semibold text-zinc-800 first:mt-0" {...props} />,
                  p: ({ node, ...props }) => <p className="mb-2 last:mb-0" {...props} />,
                  ul: ({ node, ...props }) => <ul className="mb-2 list-disc pl-5 space-y-0.5 last:mb-0" {...props} />,
                  ol: ({ node, ...props }) => <ol className="mb-2 list-decimal pl-5 space-y-0.5 last:mb-0" {...props} />,
                  a: ({ node, ...props }) => <a className="text-blue-600 underline break-all" target="_blank" rel="noreferrer" {...props} />,
                  code: ({ node, className, children, ...props }) => {
                    // react-markdown v10：无 inline prop，含 language-* 的代码块由 pre 兜底样式渲染
                    const isBlock = /language-/.test(className || '');
                    if (isBlock) return <code className="block font-mono text-xs" {...props}>{children}</code>;
                    return <code className="px-1 py-0.5 rounded bg-zinc-100 text-[12px] font-mono text-zinc-800" {...props}>{children}</code>;
                  },
                  pre: ({ node, ...props }) => <pre className="mb-2 p-2.5 rounded-md bg-zinc-100 border border-zinc-200 text-xs font-mono overflow-x-auto last:mb-0" {...props} />,
                  blockquote: ({ node, ...props }) => <blockquote className="mb-2 border-l-2 border-zinc-300 pl-3 text-zinc-500" {...props} />,
                  table: ({ node, ...props }) => <table className="mb-2 w-full text-xs border-collapse" {...props} />,
                  th: ({ node, ...props }) => <th className="border border-zinc-200 bg-zinc-50 px-2 py-1 text-left font-medium" {...props} />,
                  td: ({ node, ...props }) => <td className="border border-zinc-200 px-2 py-1" {...props} />,
                  hr: () => <hr className="my-3 border-zinc-200" />,
                }}
              >
                {detail.content || ''}
              </ReactMarkdown>
            </div>
          </div>

          {detail.tags?.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">{t('skills:detail_steps')}</div>
              <div className="flex flex-wrap gap-1.5">
                {detail.tags.map((tag, i) => (
                  <span key={i} className="text-[10px] bg-zinc-100 text-zinc-600 rounded px-1.5 py-0.5">{tag}</span>
                ))}
              </div>
            </div>
          )}

          {Array.isArray(detail.scripts) && detail.scripts.length > 0 && (
            <div className="border border-zinc-200 rounded-lg p-3 bg-zinc-50">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">{t('skills:field_scripts', { defaultValue: 'Scripts (optional, JSON array)' })}</div>
              <div className="space-y-2">
                {detail.scripts.map((sc, i) => (
                  <div key={i} className="border border-zinc-200 rounded-md bg-surface overflow-hidden">
                    <div className="px-2.5 py-1 bg-zinc-100 text-[10px] font-mono text-zinc-500 border-b border-zinc-200 truncate">{sc.path}</div>
                    <pre className="px-2.5 py-2 text-xs text-zinc-700 whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">{sc.content}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border border-zinc-200 rounded-lg p-3 bg-zinc-50">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">{t('skills:detail_inject_preview')}</div>
            <pre className="text-xs text-zinc-600 leading-relaxed whitespace-pre-wrap font-mono">{`# 用户 AGENTS.md（仅一行引导指针，不污染 git）\n<!-- xe-skills-pointer:start -->\nXEnsemble Skills 索引详见 \`.xensemble/AGENTS.md\`（技能列表按需加载）\n<!-- xe-skills-pointer:end -->\n\n# 平台索引 .xensemble/AGENTS.md（gitignore 内）\n<!-- xe-skills:start -->\n## XEnsemble Skills\n\n### ${detail.title}\n${detail.description || ''}\n\n详见 .xensemble/skills/${(detail.title || '').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)}/SKILL.md\n<!-- xe-skills:end -->`}</pre>
          </div>
        </div>

        {/* footer */}
        <div className="shrink-0 border-t border-zinc-200 px-4 py-3 flex items-center gap-2">
          <button
            type="button"
            onClick={doInstall}
            disabled={installing || installed}
            className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-zinc-900 text-zinc-50 text-sm font-medium h-9 hover:bg-zinc-800 disabled:opacity-60 ${consoleButtonFocusClass}`}
          >
            {installed ? <Check className="w-4 h-4" /> : installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
            {installed ? t('skills:install_done') : installing ? t('skills:install_loading') : t('skills:install_private')}
          </button>
        </div>
      </div>
    </div>
  );
}
