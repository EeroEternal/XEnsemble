import { useCallback, useEffect, useState, useMemo } from 'react';
import { ArrowLeft, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDot, GitPullRequest, GitMerge, Loader2, MessageSquare, RefreshCw, Send, X, XCircle, RotateCcw, Trash2, Pencil, CornerDownRight } from 'lucide-react';
import * as gitApi from '../../lib/gitApi';
import { apiFetch } from '../../lib/api';
import { confirm } from '../ConfirmDialog';
import { useToast } from '../Toast';
import { renderDiffLines, DiffText } from './DiffText';
import {
  consoleIconButtonClass,
  consoleIconButtonDangerClass,
  consoleButtonFocusClass,
  consoleInputClass,
  textPrimary,
  textSecondary,
  textPlaceholder,
} from '../../lib/consoleTokens';

const REVIEW_STATE_STYLES = {
  APPROVED: { icon: Check, bg: 'bg-green-50', text: 'text-green-700', label: 'Approved' },
  CHANGES_REQUESTED: { icon: X, bg: 'bg-red-50', text: 'text-red-700', label: 'Changes Requested' },
  COMMENTED: { icon: MessageSquare, bg: 'bg-blue-50', text: 'text-blue-700', label: 'Commented' },
  PENDING: { icon: CircleDot, bg: 'bg-yellow-50', text: 'text-yellow-700', label: 'Pending' },
  DISMISSED: { icon: X, bg: 'bg-zinc-50', text: 'text-zinc-500', label: 'Dismissed' },
};

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function ReviewBadge({ state }) {
  const style = REVIEW_STATE_STYLES[state] || REVIEW_STATE_STYLES.COMMENTED;
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}>
      <Icon className="h-3 w-3" />
      {style.label}
    </span>
  );
}

function ReviewItem({ review }) {
  return (
    <div className="rounded-xl bg-white shadow-sm border border-zinc-200 p-3.5 transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {review.user?.avatarUrl ? (
            <img src={review.user.avatarUrl} alt="" className="h-6 w-6 rounded-full ring-1 ring-zinc-200" />
          ) : (
            <div className="h-6 w-6 rounded-full bg-zinc-200" />
          )}
          <span className={`text-sm font-medium ${textPrimary} truncate`}>
            {review.user?.login || 'Unknown'}
          </span>
          <ReviewBadge state={review.state} />
        </div>
        <span className={`text-[10px] ${textPlaceholder} shrink-0`}>
          {formatDate(review.submittedAt)}
        </span>
      </div>
      {review.body && (
        <p className={`mt-2.5 text-xs ${textSecondary} whitespace-pre-wrap leading-relaxed`}>
          {review.body}
        </p>
      )}
    </div>
  );
}

function CommentActionButtons({ comment, isOwnComment, onReply, onEdit, onDelete, disabled }) {
  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {onReply && (
        <button
          type="button"
          onClick={() => onReply(comment)}
          disabled={disabled}
          title="Reply"
          className={`p-1 rounded text-zinc-400 hover:text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 ${consoleButtonFocusClass}`}
        >
          <CornerDownRight className="h-3 w-3" />
        </button>
      )}
      {isOwnComment && (
        <>
          <button
            type="button"
            onClick={() => onEdit(comment)}
            disabled={disabled}
            title="Edit"
            className={`p-1 rounded text-zinc-400 hover:text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 ${consoleButtonFocusClass}`}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(comment)}
            disabled={disabled}
            title="Delete"
            className={consoleIconButtonDangerClass}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}

function CommentItem({ comment, mrFiles, renderDiffLines, isOwnComment, onReply, onEdit, onDelete, actionLoading, hideDiff = false }) {
  const isInline = Boolean(comment.path);
  const fileDiff = isInline && !hideDiff ? (mrFiles || []).find((f) => f.path === comment.path)?.diff : null;
  const [codeExpanded, setCodeExpanded] = useState(true);
  const hasCode = Boolean(fileDiff || (comment.diffHunk && !fileDiff && !hideDiff));
  const isEditing = actionLoading?.type === 'edit' && actionLoading?.id === comment.id;
  const [editBody, setEditBody] = useState(comment.body || '');

  useEffect(() => {
    if (isEditing) setEditBody(comment.body || '');
  }, [isEditing, comment.body]);

  const handleSaveEdit = () => {
    onEdit(comment, editBody, 'save');
  };

  return (
    <div className={`rounded-xl bg-white shadow-sm border border-zinc-200 p-3.5 transition-shadow hover:shadow-md group ${comment._isReply ? 'ml-6 border-l-2 border-l-black/30' : ''}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {comment.user?.avatarUrl ? (
            <img src={comment.user?.avatarUrl} alt="" className="h-6 w-6 rounded-full ring-1 ring-zinc-200" />
          ) : (
            <div className="h-6 w-6 rounded-full bg-zinc-200" />
          )}
          <span className={`text-xs font-medium ${textPrimary}`}>
            {comment.user?.login || 'Unknown'}
          </span>
          <span className={`text-[10px] ${textPlaceholder}`}>
            {formatDate(comment.createdAt)}
          </span>
          {comment.updatedAt && comment.updatedAt !== comment.createdAt && (
            <span className={`text-[10px] ${textPlaceholder}`}>(edited)</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isInline && (
            <span className="font-mono text-[10px] bg-zinc-100 rounded-md px-1.5 py-0.5 text-zinc-500 truncate max-w-[10rem]">
              {comment.path}
            </span>
          )}
          {isInline && comment.line && (
            <span className="font-mono text-[10px] text-zinc-400">
              L{comment.line}
            </span>
          )}
          {hasCode && (
            <button
              type="button"
              onClick={() => setCodeExpanded((v) => !v)}
              title={codeExpanded ? 'Collapse code' : 'Expand code'}
              className={`p-0.5 rounded text-zinc-400 hover:text-zinc-500 hover:bg-zinc-100 ${consoleButtonFocusClass}`}
            >
              {codeExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          )}
          <CommentActionButtons
            comment={comment}
            isOwnComment={isOwnComment}
            onReply={onReply}
            onEdit={(c) => onEdit(c, null, 'start')}
            onDelete={onDelete}
            disabled={Boolean(actionLoading)}
          />
        </div>
      </div>

      {hasCode && codeExpanded && fileDiff && (
        <div className="mb-2.5 rounded-lg border border-zinc-200 overflow-hidden shadow-sm">
          <DiffText diff={fileDiff} showLineNumbers />
        </div>
      )}

      {hasCode && codeExpanded && !fileDiff && comment.diffHunk && (
        <pre className="mb-2.5 rounded-lg bg-zinc-100 p-2 text-[10px] font-mono text-zinc-500 max-h-20 overflow-auto whitespace-pre-wrap">
          {comment.diffHunk}
        </pre>
      )}

      {isEditing ? (
        <div className="space-y-2">
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            rows={2}
            autoFocus
            className={`w-full text-xs ${consoleInputClass} resize-none`}
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={!editBody.trim() || actionLoading?.pending}
              className={`flex items-center gap-1 px-2 h-6 text-[11px] font-medium rounded-md text-white bg-black hover:bg-zinc-800 disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
            >
              {actionLoading?.pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Save
            </button>
            <button
              type="button"
              onClick={() => onEdit(null, null, 'cancel')}
              className={`px-2 h-6 text-[11px] font-medium rounded-md text-zinc-500 bg-zinc-100 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className={`text-xs ${textSecondary} whitespace-pre-wrap leading-relaxed`}>
          {comment.body}
        </p>
      )}
    </div>
  );
}

function ThreadGroup({ thread, mrFiles, renderDiffLines, onReply, onEdit, onDelete, actionLoading, replyingTo, replyText, setReplyText, onSendReply, onCancelReply, remoteUsername }) {
  const [collapsed, setCollapsed] = useState(false);
  const firstComment = thread.comments[0];
  const path = firstComment?.path || '';
  const line = firstComment?.line;
  const fileDiff = (mrFiles || []).find((f) => f.path === path)?.diff;
  const [codeExpanded, setCodeExpanded] = useState(true);

  return (
    <div className="rounded-xl border border-zinc-200 overflow-hidden bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className={`w-full flex items-center gap-2 px-3 py-2 bg-zinc-50 hover:bg-zinc-100 transition-colors text-left ${consoleButtonFocusClass}`}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />}
        <span className="font-mono text-[10px] bg-zinc-100 rounded-md px-1.5 py-0.5 text-zinc-500 truncate max-w-[12rem]">
          {path}
        </span>
        {line && (
          <span className="font-mono text-[10px] text-zinc-400">L{line}</span>
        )}
        <span className="text-[10px] text-zinc-400">
          {thread.comments.length} {thread.comments.length === 1 ? 'comment' : 'comments'}
        </span>
      </button>
      {!collapsed && (
        <div className="p-2.5 space-y-2">
          {fileDiff && codeExpanded && (
            <div className="mb-1 rounded-lg border border-zinc-200 overflow-hidden">
              <div className="flex items-center justify-between px-2 py-1 bg-zinc-50">
                <span className="text-[10px] text-zinc-400">Diff context</span>
                <button
                  type="button"
                  onClick={() => setCodeExpanded(false)}
                  className={`p-0.5 rounded text-zinc-400 hover:text-zinc-500 ${consoleButtonFocusClass}`}
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
              <DiffText diff={fileDiff} showLineNumbers />
            </div>
          )}
          {fileDiff && !codeExpanded && (
            <button
              type="button"
              onClick={() => setCodeExpanded(true)}
              className={`text-[10px] text-black hover:text-zinc-800 ${consoleButtonFocusClass}`}
            >
              Show diff context
            </button>
          )}
          {thread.comments.map((comment, idx) => (
            <CommentItem
              key={comment.id || idx}
              comment={{ ...comment, _isReply: idx > 0 }}
              mrFiles={mrFiles}
              renderDiffLines={renderDiffLines}
              isOwnComment={comment.user?.login === remoteUsername}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              actionLoading={actionLoading}
              hideDiff={true}
            />
          ))}
          {replyingTo && thread.comments.some((c) => c.id === replyingTo) && (
            <div className="ml-6 flex items-end gap-2">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Reply…"
                rows={1}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    onSendReply();
                  }
                  if (e.key === 'Escape') onCancelReply();
                }}
                className={`flex-1 min-h-[28px] max-h-24 text-xs ${consoleInputClass} resize-none`}
              />
              <button
                type="button"
                onClick={onSendReply}
                disabled={!replyText.trim() || actionLoading?.pending}
                className={`shrink-0 flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-white bg-black hover:bg-zinc-800 disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
              >
                {actionLoading?.pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                Reply
              </button>
              <button
                type="button"
                onClick={onCancelReply}
                className={`shrink-0 px-2 h-7 text-[11px] font-medium rounded-md text-zinc-500 bg-zinc-100 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CodeReviewPanel({ projectId, mergeRequestId, mergeRequest, onBack, onChanged }) {
  const { showToast } = useToast();
  const [reviews, setReviews] = useState([]);
  const [comments, setComments] = useState([]);
  const [issueComments, setIssueComments] = useState([]);
  const [mrFiles, setMrFiles] = useState([]);
  const [expandedFiles, setExpandedFiles] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeTab, setActiveTab] = useState('reviews');
  const [actionLoading, setActionLoading] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [commentSending, setCommentSending] = useState(false);
  const [localMR, setLocalMR] = useState(mergeRequest);
  const [replyingTo, setReplyingTo] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [commentActionLoading, setCommentActionLoading] = useState(null);
  const [remoteUsername, setRemoteUsername] = useState(null);
  const COMMENTS_PER_PAGE = 50;

  useEffect(() => {
    if (!projectId) return;
    apiFetch('/api/v1/git/connections')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        const conns = data?.connections || [];
        const provider = mergeRequest?.provider;
        const conn = provider
          ? conns.find((c) => c.provider === provider)
          : conns[0];
        if (conn?.remote_username) setRemoteUsername(conn.remote_username);
      })
      .catch(() => {});
  }, [projectId, mergeRequest?.provider]);

  const fetchData = useCallback(async () => {
    if (!projectId || !mergeRequestId) return;
    setLoading(true);
    try {
      const [reviewsRes, commentsRes, issueRes, filesRes, mrRes] = await Promise.all([
        gitApi.listReviews(projectId, mergeRequestId),
        gitApi.listReviewComments(projectId, mergeRequestId, { per_page: COMMENTS_PER_PAGE }),
        gitApi.listIssueComments(projectId, mergeRequestId, { per_page: COMMENTS_PER_PAGE }),
        gitApi.listMrFiles(projectId, mergeRequestId),
        gitApi.getMergeRequest(projectId, mergeRequestId).catch(() => null),
      ]);
      setReviews(reviewsRes.reviews || []);
      setComments(commentsRes.comments || []);
      setIssueComments(issueRes.comments || []);
      setMrFiles(filesRes.files || []);
      if (mrRes) setLocalMR(mrRes);
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, mergeRequestId, showToast]);

  const fetchMrFiles = useCallback(async () => {
    if (!projectId || !mergeRequestId || mrFiles.length > 0) return;
    setMrFilesLoading(true);
    try {
      const res = await gitApi.listMrFiles(projectId, mergeRequestId);
      setMrFiles(res.files || []);
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setMrFilesLoading(false);
    }
  }, [projectId, mergeRequestId, mrFiles.length, showToast]);

  useEffect(() => {
    setLocalMR(mergeRequest);
  }, [mergeRequest]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleFileExpand = (path) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const STATUS_LABELS = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
  const STATUS_COLORS = { added: 'text-emerald-600', modified: 'text-red-600', deleted: 'text-red-600', renamed: 'text-black' };

  const approvedCount = reviews.filter((r) => r.state === 'APPROVED').length;
  const changesCount = reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length;

  // Build conversation with thread grouping
  const conversation = useMemo(() => {
    // Tag comments with their type
    const taggedReview = comments.map((c) => ({ ...c, _type: 'review' }));
    const taggedIssue = issueComments.map((c) => ({ ...c, _type: 'issue' }));

    // Group review comments into threads by path:line or discussionId
    const threadMap = new Map();
    const standaloneReview = [];
    for (const c of taggedReview) {
      const key = c.discussionId || `${c.path || 'unknown'}:${c.line || 0}`;
      if (c.path) {
        if (!threadMap.has(key)) threadMap.set(key, []);
        threadMap.get(key).push(c);
      } else {
        standaloneReview.push(c);
      }
    }

    // Build thread objects
    const threads = [];
    for (const [, group] of threadMap) {
      group.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      threads.push({ type: 'thread', comments: group, earliestAt: group[0]?.createdAt || 0 });
    }

    // Standalone items (issue comments + non-inline review comments)
    const standalones = [...standaloneReview, ...taggedIssue].map((c) => ({
      type: 'standalone',
      comments: [c],
      earliestAt: c.createdAt || 0,
    }));

    // Sort all by earliest timestamp
    return [...threads, ...standalones].sort((a, b) => new Date(a.earliestAt) - new Date(b.earliestAt));
  }, [comments, issueComments]);

  const mrTitle = localMR?.title || mergeRequest?.title || mergeRequest?.description || '';
  const mrNumber = localMR?.remoteMrNumber || mergeRequest?.remoteMrNumber || '';
  const mrStatus = localMR?.status || mergeRequest?.status || (mergeRequest?.remoteState === 'opened' ? 'open' : mergeRequest?.remoteState) || 'open';
  const isOpen = mrStatus === 'open';
  const isMerged = mrStatus === 'merged';
  const isClosed = mrStatus === 'closed';

  const refreshMR = () => {
    fetchData();
    onChanged?.();
  };

  const handleReopen = async () => {
    setActionLoading('reopen');
    try {
      await gitApi.reopenMergeRequest(projectId, mergeRequestId);
      showToast('success', 'Pull request reopened.');
      refreshMR();
    } catch (err) {
      if (err.code === 'REAUTH_REQUIRED') {
        showToast('warning', err.message);
        window.dispatchEvent(new CustomEvent('xe:open-settings'));
      } else {
        showToast('error', err.message);
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleMerge = async () => {
    if (!await confirm({ title: 'Merge Pull Request', message: 'Merge this pull request? This action cannot be undone.', confirmLabel: 'Merge', variant: 'primary' })) return;
    setActionLoading('merge');
    try {
      await gitApi.mergeMergeRequest(projectId, mergeRequestId);
      showToast('success', 'Pull request merged.');
      refreshMR();
    } catch (err) {
      if (err.code === 'REAUTH_REQUIRED') {
        showToast('warning', err.message);
        window.dispatchEvent(new CustomEvent('xe:open-settings'));
      } else {
        showToast('error', err.message);
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleClose = async () => {
    if (!await confirm({ title: 'Close Pull Request', message: 'Close this pull request without merging?', confirmLabel: 'Close', variant: 'secondary' })) return;
    setActionLoading('close');
    try {
      await gitApi.closeMergeRequest(projectId, mergeRequestId);
      showToast('success', 'Pull request closed.');
      refreshMR();
    } catch (err) {
      if (err.code === 'REAUTH_REQUIRED') {
        showToast('warning', err.message);
        window.dispatchEvent(new CustomEvent('xe:open-settings'));
      } else {
        showToast('error', err.message);
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleApprove = async () => {
    setActionLoading('approve');
    try {
      await gitApi.approveMergeRequest(projectId, mergeRequestId);
      showToast('success', 'Pull request approved.');
      refreshMR();
    } catch (err) {
      if (err.code === 'REAUTH_REQUIRED') {
        showToast('warning', err.message);
        window.dispatchEvent(new CustomEvent('xe:open-settings'));
      } else {
        showToast('error', err.message);
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleSendComment = async () => {
    if (!commentText.trim()) return;
    setCommentSending(true);
    try {
      await gitApi.addMergeRequestComment(projectId, mergeRequestId, commentText.trim());
      setCommentText('');
      showToast('success', 'Comment added.');
      refreshMR();
    } catch (err) {
      if (err.code === 'REAUTH_REQUIRED') {
        showToast('warning', err.message);
        window.dispatchEvent(new CustomEvent('xe:open-settings'));
      } else {
        showToast('error', err.message);
      }
    } finally {
      setCommentSending(false);
    }
  };

  // Comment reply/edit/delete handlers
  const handleReply = (comment) => {
    setReplyingTo(comment.id);
    setReplyText('');
  };

  const handleCancelReply = () => {
    setReplyingTo(null);
    setReplyText('');
  };

  const handleSendReply = async () => {
    if (!replyText.trim() || !replyingTo) return;
    const targetComment = comments.find((c) => c.id === replyingTo);
    if (!targetComment) return;
    setCommentActionLoading({ type: 'reply', id: replyingTo, pending: true });
    try {
      await gitApi.replyToReviewComment(projectId, mergeRequestId, replyingTo, replyText.trim(), targetComment.discussionId);
      setReplyText('');
      setReplyingTo(null);
      showToast('success', 'Reply added.');
      refreshMR();
    } catch (err) {
      if (err.code === 'REAUTH_REQUIRED') {
        showToast('warning', err.message);
        window.dispatchEvent(new CustomEvent('xe:open-settings'));
      } else {
        showToast('error', err.message);
      }
    } finally {
      setCommentActionLoading(null);
    }
  };

  const handleSaveEdit = async (comment, newBody) => {
    if (!newBody?.trim()) return;
    setCommentActionLoading({ type: 'edit', id: comment.id, pending: true });
    try {
      await gitApi.editMergeRequestComment(projectId, mergeRequestId, comment.id, newBody.trim(), comment._type || 'issue');
      showToast('success', 'Comment updated.');
      setCommentActionLoading(null);
      refreshMR();
    } catch (err) {
      if (err.code === 'REAUTH_REQUIRED') {
        showToast('warning', err.message);
        window.dispatchEvent(new CustomEvent('xe:open-settings'));
      } else {
        showToast('error', err.message);
      }
      setCommentActionLoading(null);
    }
  };

  const handleDeleteComment = async (comment) => {
    if (!await confirm({ title: 'Delete Comment', message: 'Delete this comment? This cannot be undone.', confirmLabel: 'Delete', variant: 'danger' })) return;
    setCommentActionLoading({ type: 'delete', id: comment.id, pending: true });
    try {
      await gitApi.deleteMergeRequestComment(projectId, mergeRequestId, comment.id, comment._type || 'issue');
      showToast('success', 'Comment deleted.');
      refreshMR();
    } catch (err) {
      if (err.code === 'REAUTH_REQUIRED') {
        showToast('warning', err.message);
        window.dispatchEvent(new CustomEvent('xe:open-settings'));
      } else {
        showToast('error', err.message);
      }
    } finally {
      setCommentActionLoading(null);
    }
  };

  const handleEditWrapper = (comment, body, mode) => {
    if (mode === 'start') {
      setCommentActionLoading({ type: 'edit', id: comment.id });
    } else if (mode === 'save') {
      handleSaveEdit(comment, body);
    } else {
      setCommentActionLoading(null);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between border-b border-zinc-300 px-3 py-2 shrink-0 bg-white shadow-sm z-10">
        <div className="flex items-center gap-2 min-w-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              title="Back to list"
              className={`p-1 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          {mrNumber && <span className="shrink-0 text-sm font-bold text-zinc-900">#{mrNumber}</span>}
          <span className="truncate text-sm font-semibold text-zinc-900">{mrTitle}</span>
          {(approvedCount > 0 || changesCount > 0) && (
            <div className="flex items-center gap-1 shrink-0">
              {approvedCount > 0 && (
                <span className="inline-flex items-center rounded-full bg-green-100 px-1.5 py-0.5 text-[9px] font-medium text-green-700">
                  {approvedCount} approved
                </span>
              )}
              {changesCount > 0 && (
                <span className="inline-flex items-center rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-medium text-red-700">
                  {changesCount} changes
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isOpen && (
            <>
              <button
                type="button"
                onClick={handleApprove}
                disabled={actionLoading !== null}
                title="Approve this pull request"
                className={`flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-green-700 bg-green-50 hover:bg-green-100 disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
              >
                {actionLoading === 'approve' ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                Approve
              </button>
              <button
                type="button"
                onClick={handleMerge}
                disabled={actionLoading !== null}
                title="Merge pull request"
                className={`flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
              >
                {actionLoading === 'merge' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
                Merge
              </button>
              <button
                type="button"
                onClick={handleClose}
                disabled={actionLoading !== null}
                title="Close pull request"
                className={`flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-zinc-500 bg-zinc-100 hover:bg-zinc-200 disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
              >
                {actionLoading === 'close' ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                Close
              </button>
            </>
          )}
          {isClosed && (
            <>
              <span className="flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-zinc-500 bg-zinc-100">
                <XCircle className="h-3.5 w-3.5" />
                Closed
              </span>
              <button
                type="button"
                onClick={handleReopen}
                disabled={actionLoading !== null}
                title="Reopen pull request"
                className={`flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-black bg-blue-50 hover:bg-blue-100 disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
              >
                {actionLoading === 'reopen' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Reopen
              </button>
            </>
          )}
          {isMerged && (
            <span className="flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-purple-700 bg-purple-50">
              <GitMerge className="h-3.5 w-3.5" />
              Merged
            </span>
          )}
          <button
            type="button"
            onClick={fetchData}
            disabled={loading}
            title="Refresh"
            className={consoleIconButtonClass}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {mergeRequestId && (localMR?.description || mergeRequest?.description) && (
        <div className="px-3 py-2 shrink-0 bg-zinc-50 border-b border-zinc-200">
          <p className={`text-xs ${textSecondary} whitespace-pre-wrap leading-relaxed max-h-24 overflow-y-auto`}>
            {localMR?.description || mergeRequest?.description}
          </p>
        </div>
      )}

      {!mergeRequestId ? (
        <div className="flex flex-col items-center justify-center py-8 gap-2 text-zinc-400">
          <GitPullRequest className="h-6 w-6" />
          <p className="text-[10px]">Select a pull request from the list to view review</p>
        </div>
      ) : (
        <>
          <div className="flex border-b border-zinc-300 px-3 shrink-0 bg-white gap-1 shadow-sm">
            <button
              type="button"
              onClick={() => setActiveTab('reviews')}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-all ${consoleButtonFocusClass} ${
                activeTab === 'reviews'
                  ? 'border-zinc-900 text-zinc-900'
                  : 'border-transparent text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded-t-md'
              }`}
            >
              Reviews ({reviews.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('conversation')}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-all ${consoleButtonFocusClass} ${
                activeTab === 'conversation'
                  ? 'border-zinc-900 text-zinc-900'
                  : 'border-transparent text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded-t-md'
              }`}
            >
              Conversation ({conversation.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('changes')}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-all ${consoleButtonFocusClass} ${
                activeTab === 'changes'
                  ? 'border-zinc-900 text-zinc-900'
                  : 'border-transparent text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded-t-md'
              }`}
            >
              Changes ({mrFiles.length})
            </button>
          </div>

          {activeTab === 'changes' ? (
            <div className="flex-1 min-h-0 overflow-auto bg-zinc-100 p-3">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading…
                </div>
              ) : mrFiles.length === 0 ? (
                <div className="text-center py-8">
                  <GitPullRequest className="mx-auto h-8 w-8 text-zinc-400 mb-2" />
                  <p className={`text-sm ${textSecondary}`}>No file changes.</p>
                </div>
              ) : (
                <div className="rounded-xl bg-white shadow-sm border border-zinc-200 overflow-hidden">
                {mrFiles.map((f) => {
                  const fileName = f.path.split('/').pop();
                  const dirPath = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
                  const isExpanded = expandedFiles.has(f.path);
                  const label = STATUS_LABELS[f.status] || 'M';
                  const colorCls = STATUS_COLORS[f.status] || 'text-zinc-400';
                  return (
                    <div key={f.path} className="border-b border-zinc-200 last:border-b-0">
                      <div className="flex items-center group hover:bg-zinc-100 transition-colors">
                        <button
                          onClick={() => toggleFileExpand(f.path)}
                          className="shrink-0 p-0.5 ml-2 text-zinc-400 hover:text-zinc-600"
                        >
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={() => toggleFileExpand(f.path)}
                          className={`flex items-center gap-2 flex-1 min-w-0 px-2 py-2 text-left transition-colors ${consoleButtonFocusClass}`}
                        >
                          <span className={`w-4 text-center font-mono text-[11px] font-semibold ${colorCls} shrink-0`}>
                            {label}
                          </span>
                          <span className="truncate text-zinc-900 text-xs">{fileName}</span>
                          {dirPath && (
                            <span className="truncate text-zinc-400 text-[10px]">{dirPath}</span>
                          )}
                          {f.additions != null && f.deletions != null && (
                            <span className="ml-auto text-[10px] shrink-0">
                              <span className="text-emerald-600">+{f.additions}</span>
                              <span className="text-red-600"> -{f.deletions}</span>
                            </span>
                          )}
                        </button>
                      </div>
                      {isExpanded && f.diff && (
                        <div className="border-t border-zinc-200 bg-zinc-50">
                          <div className="text-[11px] leading-relaxed overflow-x-auto font-mono select-text" style={{ tabSize: 4, MozTabSize: 4 }}>
                            {renderDiffLines(f.diff)}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
              )}
            </div>
          ) : (
          <div className="flex-1 min-h-0 overflow-auto bg-zinc-100 p-3 space-y-2.5">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : activeTab === 'reviews' ? (
              reviews.length === 0 ? (
                <div className="text-center py-8">
                  <MessageSquare className="mx-auto h-8 w-8 text-zinc-400 mb-2" />
                  <p className={`text-sm ${textSecondary}`}>No reviews yet.</p>
                </div>
              ) : (
                reviews.map((review, idx) => (
                  <ReviewItem key={review.id || idx} review={review} />
                ))
              )
            ) : (
              conversation.length === 0 ? (
                <div className="text-center py-8">
                  <MessageSquare className="mx-auto h-8 w-8 text-zinc-400 mb-2" />
                  <p className={`text-sm ${textSecondary}`}>No conversation yet.</p>
                </div>
              ) : (
                <>
                  {conversation.map((item, idx) => {
                    if (item.type === 'thread' && item.comments.length > 0) {
                      const threadHasReply = item.comments.some((c) => c.id === replyingTo);
                      return (
                        <ThreadGroup
                          key={`thread-${idx}`}
                          thread={item}
                          mrFiles={mrFiles}
                          renderDiffLines={renderDiffLines}
                          onReply={handleReply}
                          onEdit={handleEditWrapper}
                          onDelete={handleDeleteComment}
                          actionLoading={commentActionLoading}
                          replyingTo={threadHasReply ? replyingTo : null}
                          replyText={replyText}
                          setReplyText={setReplyText}
                          onSendReply={handleSendReply}
                          onCancelReply={handleCancelReply}
                          remoteUsername={remoteUsername}
                        />
                      );
                    }
                    const comment = item.comments[0];
                    return (
                      <div key={`standalone-${comment.id || idx}`}>
                        <CommentItem
                          comment={comment}
                          mrFiles={mrFiles}
                          renderDiffLines={renderDiffLines}
                          isOwnComment={comment.user?.login === remoteUsername}
                          onReply={comment._type === 'review' ? handleReply : null}
                          onEdit={handleEditWrapper}
                          onDelete={handleDeleteComment}
                          actionLoading={commentActionLoading}
                        />
                        {replyingTo === comment.id && (
                          <div className="ml-6 mt-2 flex items-end gap-2">
                            <textarea
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                              placeholder="Reply…"
                              rows={1}
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                  e.preventDefault();
                                  handleSendReply();
                                }
                                if (e.key === 'Escape') handleCancelReply();
                              }}
                              className={`flex-1 min-h-[28px] max-h-24 text-xs ${consoleInputClass} resize-none`}
                            />
                            <button
                              type="button"
                              onClick={handleSendReply}
                              disabled={!replyText.trim() || commentActionLoading?.pending}
                              className={`shrink-0 flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-white bg-black hover:bg-zinc-800 disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
                            >
                              {commentActionLoading?.pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                              Reply
                            </button>
                            <button
                              type="button"
                              onClick={handleCancelReply}
                              className={`shrink-0 px-2 h-7 text-[11px] font-medium rounded-md text-zinc-500 bg-zinc-100 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {(comments.length >= COMMENTS_PER_PAGE || issueComments.length >= COMMENTS_PER_PAGE) && (
                    <div className="flex justify-center pt-2">
                      <button
                        type="button"
                        onClick={async () => {
                          setLoadingMore(true);
                          try {
                            const commentPage = Math.floor(comments.length / COMMENTS_PER_PAGE) + 1;
                            const issuePage = Math.floor(issueComments.length / COMMENTS_PER_PAGE) + 1;
                            const [moreComments, moreIssues] = await Promise.all([
                              gitApi.listReviewComments(projectId, mergeRequestId, { page: commentPage, per_page: COMMENTS_PER_PAGE }).catch(() => ({ comments: [] })),
                              gitApi.listIssueComments(projectId, mergeRequestId, { page: issuePage, per_page: COMMENTS_PER_PAGE }).catch(() => ({ comments: [] })),
                            ]);
                            if (moreComments.comments?.length) setComments((prev) => [...prev, ...moreComments.comments]);
                            if (moreIssues.comments?.length) setIssueComments((prev) => [...prev, ...moreIssues.comments]);
                            if (!moreComments.comments?.length && !moreIssues.comments?.length) {
                              showToast('info', 'No more comments to load.');
                            }
                          } catch (err) {
                            showToast('error', err.message);
                          } finally {
                            setLoadingMore(false);
                          }
                        }}
                        disabled={loadingMore}
                        className={`text-xs text-black hover:text-zinc-800 ${consoleButtonFocusClass}`}
                      >
                        {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Load more'}
                      </button>
                    </div>
                  )}
                </>
              )
            )}
          </div>
          )}
        </>
      )}
      {isOpen && (
        <div className="flex items-end gap-2 border-t border-zinc-300 px-3 py-2 shrink-0 bg-white">
          <textarea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Leave a comment…"
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSendComment();
              }
            }}
            className={`flex-1 min-h-[28px] max-h-24 text-xs ${consoleInputClass} resize-none`}
          />
          <button
            type="button"
            onClick={handleSendComment}
            disabled={!commentText.trim() || commentSending}
            title="Comment (Ctrl+Enter)"
            className={`shrink-0 flex items-center gap-1 px-2.5 h-7 text-[11px] font-medium rounded-md text-white bg-black hover:bg-zinc-800 disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
          >
            {commentSending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Comment
          </button>
        </div>
      )}
    </div>
  );
}
