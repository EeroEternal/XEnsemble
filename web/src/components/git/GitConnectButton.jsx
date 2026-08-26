import { GitBranch, Loader2, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import {
  bgActive,
  bgInverse,
  textInverse,
  textPlaceholder,
  textPrimary,
  textSecondary,
  transitionBase,
  consoleIconButtonClass,
} from '../../lib/consoleTokens';
import { getProviderLabel } from '../../lib/gitLabels';

export default function GitConnectButton({
  provider = 'github',
  connection,
  loading,
  onConnect,
  onDisconnect,
  disabled = false,
  disabledReason,
  className,
}) {
  const { t } = useTranslation();
  const label = getProviderLabel(provider) || provider;
  const username = connection?.remote_username || connection?.remoteUsername
    || connection?.github_username || connection?.githubUsername || '';

  if (connection) {
    return (
      <div className={cn('flex items-center gap-3', className)}>
        {connection.avatar_url || connection.github_avatar || connection.githubAvatar ? (
          <img
            src={connection.avatar_url || connection.github_avatar || connection.githubAvatar}
            alt=""
            className="h-6 w-6 rounded-full"
          />
        ) : (
          <div className={`flex h-6 w-6 items-center justify-center rounded-full ${bgActive}`}>
            <GitBranch className={`h-3.5 w-3.5 ${textSecondary}`} />
          </div>
        )}
        <div className="min-w-0">
          <p className={`truncate text-sm font-medium ${textPrimary}`}>
            {username || label}
          </p>
          <p className={`text-xs ${textSecondary}`}>
            {t('git:connected_to', { label })}
            {connection.connection_type === 'pat' && (
              <span className="ml-1 rounded bg-zinc-100 px-1 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                {t('git:via_pat')}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onDisconnect}
          disabled={loading}
          title={t('git:disconnect', { label })}
          aria-label={t('git:disconnect', { label })}
          className={cn(consoleIconButtonClass, 'ml-auto')}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Unlink className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={loading || disabled}
      title={disabled ? (disabledReason || t('git:oauth_not_configured_short')) : undefined}
      className={cn(
        `inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium ${bgInverse} ${textInverse} hover:bg-zinc-700 disabled:opacity-50 ${transitionBase}`,
        className,
      )}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <GitBranch className="h-4 w-4" />
      )}
      {t('git:connect_to', { label })}
    </button>
  );
}
