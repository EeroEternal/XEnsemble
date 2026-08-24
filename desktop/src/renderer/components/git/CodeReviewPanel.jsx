import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDot, GitPullRequest, GitMerge, Loader2, MessageSquare, RefreshCw, Send, X, XCircle } from 'lucide-react';
import * as gitApi from '../../lib/gitApi.js';
import { useToast } from '../Toast';
import {
  consoleIconButtonClass,
  consoleButtonFocusClass,
  consoleInputClass,
  textPrimary,
  textSecondary,
  textPlaceholder,
  borderHairline,
  bgCanvas,
} from '../../lib/consoleTheme';
import { useTranslation } from 'react-i18next';

const REVIEW_STATE_STYLES = {
  APPROVED: { icon: Check, bg: 'bg-green-50', text: 'text-green-700' },
  CHANGES_REQUESTED: { icon: X, bg: 'bg-red-50', text: 'text-red-700' },
  COMMENTED: { icon: MessageSquare, bg: 'bg-blue-50', text: 'text-blue-700' },
  PENDING: { icon: CircleDot, bg: 'bg-yellow-50', text: 'text-yellow-700' },
  DISMISSED: { icon: X, bg: 'bg-zinc-50', text: 'text-zinc-500' },
};

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function ReviewBadge({ state }) {
  const { t } = useTranslation();
  const style = REVIEW_STATE_STYLES[state] || REVIEW_STATE_STYLES.COMMENTED;
  const Icon = style.icon;
  const reviewLabels = {
    APPROVED: t('git:review_state.approved', { defaultValue: 'Approved' }),
    CHANGES_REQUESTED: t('git:review_state.changes_requested', { defaultValue: 'Changes Requested' }),
    COMMENTED: t('git:review_state.commented', { defaultValue: 'Commented' }),
    PENDING: t('common:state.pending'),
    DISMISSED: t('git:review_state.dismissed', { defaultValue: 'Dismissed' }),
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}>
      <Icon className="h-3 w-3" />
      {reviewLabels[state] || reviewLabels.COMMENTED}
    </span>
  );
}

function ReviewItem({ review }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl bg-white shadow-sm border border-[#E8EAED] p-3.5 transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {review.user?.avatarUrl ? (
            <img src={review.user.avatarUrl} alt="" className="h-6 w-6 rounded-full ring-1 ring-[#E8EAED]" />
          ) : (
            <div className="h-6 w-6 rounded-full bg-[#E8EAED]" />
          )}
          <span className={`text-sm font-medium ${textPrimary} truncate`}>
            {review.user?.login || t('common:user.unknown', { defaultValue: 'Unknown' })}
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

function CommentItem({ comment, mrFiles, renderDiffLines }) {
  const { t } = useTranslation();
  const isInline = Boolean(comment.path);
  const fileDiff = isInline ? (mrFiles || []).find((f) => f.path === comment.path)?.diff : null;
  const [codeExpanded, setCodeExpanded] = useState(true);
  const hasCode = Boolean(fileDiff || (comment.diffHunk && !fileDiff));

  return (
    <div className="rounded-xl bg-white shadow-sm border border-[#E8EAED] p-3.5 transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {comment.user?.avatarUrl ? (
            <img src={comment.user?.avatarUrl} alt="" className="h-6 w-6 rounded-full ring-1 ring-[#E8EAED]" />
          ) : (
            <div className="h-6 w-6 rounded-full bg-[#E8EAED]" />
          )}
          <span className={`text-xs font-medium ${textPrimary}`}>
            {comment.user?.login || t('common:user.unknown', { defaultValue: 'Unknown' })}
          </span>
          <span className={`text-[10px] ${textPlaceholder}`}>
            {formatDate(comment.createdAt)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isInline && (
            <span className="font-mono text-[10px] bg-[#F4F5F6] rounded-md px-1.5 py-0.5 text-[#5F6368] truncate max-w-[10rem]">
              {comment.path}
            </span>
          )}
          {isInline && comment.line && (
            <span className="font-mono text-[10px] text-[#9AA0A6]">
              L{comment.line}
            </span>
          )}
          {hasCode && (
            <button
              type="button"
              onClick={() => setCodeExpanded((v) => !v)}
              title={codeExpanded ? t('git:action.collapse_code', { defaultValue: 'Collapse code' }) : t('git:action.expand_code', { defaultValue: 'Expand code' })}
              className={`p-0.5 rounded text-[#9AA0A6] hover:text-[#5F6368] hover:bg-[#F4F5F6] ${consoleButtonFocusClass}`}
            >
              {codeExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>

      {hasCode && codeExpanded && fileDiff && (
        <div className="mb-2.5 rounded-lg border border-[#E8EAED] overflow-hidden shadow-sm">
          <div className="text-[11px] leading-relaxed overflow-x-auto font-mono select-text max-h-40 overflow-y-auto" style={{ tabSize: 4, MozTabSize: 4 }}>
            {renderDiffLines(fileDiff)}
          </div>
        </div>
      )}

      {hasCode && codeExpanded && !fileDiff && comment.diffHunk && (
        <pre className="mb-2.5 rounded-lg bg-[#F4F5F6] p-2 text-[10px] font-mono text-[#5F6368] max-h-20 overflow-auto whitespace-pre-wrap">
          {comment.diffHunk}
        </pre>
      )}

      <p className={`text-xs ${textSecondary} whitespace-pre-wrap leading-relaxed`}>
        {comment.body}
      </p>
    </div>
  );
}

export default function CodeReviewPanel({ projectId, mergeRequestId, mergeRequest, onBack, onChanged }) {
  const { t } = useTranslation();
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
  const COMMENTS_PER_PAGE = 50;

  const fetchData = useCallback(async () => {
    if (!projectId || !mergeRequestId) return;
    setLoading(true);
    try {
      const [reviewsRes, commentsRes, issueRes, filesRes] = await Promise.all([
        gitApi.listReviews(projectId, mergeRequestId),
        gitApi.listReviewComments(projectId, mergeRequestId, { per_page: COMMENTS_PER_PAGE }),
        gitApi.listIssueComments(projectId, mergeRequestId, { per_page: COMMENTS_PER_PAGE }),
        gitApi.listMrFiles(projectId, mergeRequestId),
      ]);
      setReviews(reviewsRes.reviews || []);
      setComments(commentsRes.comments || []);
      setIssueComments(issueRes.comments || []);
      setMrFiles(filesRes.files || []);
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, mergeRequestId, showToast]);

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

  const renderDiffLines = (raw) => {
    if (!raw) return null;
    return raw.split('\n').map((line, i) => {
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted ') || line.startsWith('\\ No newline')) return null;
      if (line[0] === '@') return null;
      if (line[0] === '+') return <div key={i} className="bg-[#DFF7E4] text-[#1A7F37] pl-2">{line.slice(1)}</div>;
      if (line[0] === '-') return <div key={i} className="bg-[#FFEBE9] text-[#CF222E] pl-2">{line.slice(1)}</div>;
      return <div key={i} className="bg-white text-[#1F2328] pl-2">{line || ' '}</div>;
    });
  };

  const STATUS_LABELS = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
  const STATUS_COLORS = { added: 'text-[#4A7C59]', modified: 'text-[#C06C5D]', deleted: 'text-[#C06C5D]', renamed: 'text-[#5B8DB8]' };

  const approvedCount = reviews.filter((r) => r.state === 'APPROVED').length;
  const changesCount = reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length;

  const conversation = [
    ...comments,
    ...issueComments,
  ].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

  const mrTitle = mergeRequest?.title || mergeRequest?.description || '';
  const mrNumber = mergeRequest?.remoteMrNumber || mergeRequest?.remote_mr_number || '';
  const mrStatus = mergeRequest?.status || (mergeRequest?.remoteState === 'opened' ? 'open' : mergeRequest?.remoteState) || 'open';
  const isOpen = mrStatus === 'open';
  const isMerged = mrStatus === 'merged';
  const isClosed = mrStatus === 'closed';

  const refreshMR = () => {
    fetchData();
    onChanged?.();
  };

  const handleMerge = async () => {
    if (!window.confirm('Merge this pull request? This action cannot be undone.')) return;
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
    if (!window.confirm('Close this pull request without merging?')) return;
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

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between border-b border-[#DADCE0] px-3 py-2 shrink-0 bg-white shadow-sm z-10">
        <div className="flex items-center gap-2 min-w-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              title="Back to list"
              className={`p-1 rounded-md text-[#5F6368] hover:text-[#202124] hover:bg-[#E8EAED] ${consoleButtonFocusClass}`}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          {mrNumber && <span className="shrink-0 text-sm font-bold text-[#202124]">#{mrNumber}</span>}
          <span className="truncate text-sm font-semibold text-[#202124]">{mrTitle}</span>
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
                className={`flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-white bg-[#4A7C59] hover:bg-[#3d684a] disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
              >
                {actionLoading === 'merge' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
                Merge
              </button>
              <button
                type="button"
                onClick={handleClose}
                disabled={actionLoading !== null}
                title="Close pull request"
                className={`flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-[#5F6368] bg-[#F4F5F6] hover:bg-[#E8EAED] disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
              >
                {actionLoading === 'close' ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                Close
              </button>
            </>
          )}
          {isMerged && (
            <span className="flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-purple-700 bg-purple-50">
              <GitMerge className="h-3.5 w-3.5" />
              Merged
            </span>
          )}
          {isClosed && (
            <span className="flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-[#5F6368] bg-[#F4F5F6]">
              <XCircle className="h-3.5 w-3.5" />
              Closed
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

      {!mergeRequestId ? (
        <div className="flex flex-col items-center justify-center py-8 gap-2 text-zinc-400">
          <GitPullRequest className="h-6 w-6" />
          <p className="text-[10px]">Select a pull request from the list to view review</p>
        </div>
      ) : (
        <>
          <div className="flex border-b border-[#DADCE0] px-3 shrink-0 bg-white gap-1 shadow-sm">
            <button
              type="button"
              onClick={() => setActiveTab('reviews')}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-all ${consoleButtonFocusClass} ${
                activeTab === 'reviews'
                  ? 'border-[#202124] text-[#202124]'
                  : 'border-transparent text-[#5F6368] hover:text-[#202124] hover:bg-[#F4F5F6] rounded-t-md'
              }`}
            >
              Reviews ({reviews.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('conversation')}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-all ${consoleButtonFocusClass} ${
                activeTab === 'conversation'
                  ? 'border-[#202124] text-[#202124]'
                  : 'border-transparent text-[#5F6368] hover:text-[#202124] hover:bg-[#F4F5F6] rounded-t-md'
              }`}
            >
              Conversation ({conversation.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('changes')}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-all ${consoleButtonFocusClass} ${
                activeTab === 'changes'
                  ? 'border-[#202124] text-[#202124]'
                  : 'border-transparent text-[#5F6368] hover:text-[#202124] hover:bg-[#F4F5F6] rounded-t-md'
              }`}
            >
              Changes ({mrFiles.length})
            </button>
          </div>

          {activeTab === 'changes' ? (
            <div className="flex-1 min-h-0 overflow-auto bg-[#F0F1F3] p-3">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#5F6368]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading…
                </div>
              ) : mrFiles.length === 0 ? (
                <div className="text-center py-8">
                  <GitPullRequest className="mx-auto h-8 w-8 text-[#9AA0A6] mb-2" />
                  <p className={`text-sm ${textSecondary}`}>No file changes.</p>
                </div>
              ) : (
                <div className="rounded-xl bg-white shadow-sm border border-[#E8EAED] overflow-hidden">
                {mrFiles.map((f) => {
                  const fileName = f.path.split('/').pop();
                  const dirPath = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
                  const isExpanded = expandedFiles.has(f.path);
                  const label = STATUS_LABELS[f.status] || 'M';
                  const colorCls = STATUS_COLORS[f.status] || 'text-zinc-400';
                  return (
                    <div key={f.path} className="border-b border-[#E8EAED] last:border-b-0">
                      <div className="flex items-center group hover:bg-[#F4F5F6] transition-colors">
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
                          <span className="truncate text-[#202124] text-xs">{fileName}</span>
                          {dirPath && (
                            <span className="truncate text-[#9AA0A6] text-[10px]">{dirPath}</span>
                          )}
                          {f.additions != null && f.deletions != null && (
                            <span className="ml-auto text-[10px] shrink-0">
                              <span className="text-[#1A7F37]">+{f.additions}</span>
                              <span className="text-[#CF222E]"> -{f.deletions}</span>
                            </span>
                          )}
                        </button>
                      </div>
                      {isExpanded && f.diff && (
                        <div className="border-t border-[#E8EAED] bg-[#FAFBFC]">
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
          <div className="flex-1 min-h-0 overflow-auto bg-[#F0F1F3] p-3 space-y-2.5">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#5F6368]">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : activeTab === 'reviews' ? (
              reviews.length === 0 ? (
                <div className="text-center py-8">
                  <MessageSquare className="mx-auto h-8 w-8 text-[#9AA0A6] mb-2" />
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
                  <MessageSquare className="mx-auto h-8 w-8 text-[#9AA0A6] mb-2" />
                  <p className={`text-sm ${textSecondary}`}>No conversation yet.</p>
                </div>
              ) : (
                <>
                  {conversation.map((comment, idx) => (
                    <CommentItem key={comment.id || idx} comment={comment} mrFiles={mrFiles} renderDiffLines={renderDiffLines} />
                  ))}
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
                        className={`text-xs text-[#5B8DB8] hover:text-[#4A7298] ${consoleButtonFocusClass}`}
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
        <div className="flex items-end gap-2 border-t border-[#DADCE0] px-3 py-2 shrink-0 bg-white">
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
            className={`shrink-0 flex items-center gap-1 px-2.5 h-7 text-[11px] font-medium rounded-md text-white bg-[#5B8DB8] hover:bg-[#4A7298] disabled:opacity-40 transition-colors ${consoleButtonFocusClass}`}
          >
            {commentSending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Comment
          </button>
        </div>
      )}
    </div>
  );
}