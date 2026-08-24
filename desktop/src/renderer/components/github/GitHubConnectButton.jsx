import React from 'react';
import { Github, Loader2, Unlink } from 'lucide-react';
import { cn } from '../../lib/utils';
import { consoleIconButtonClass } from '../../lib/consoleTheme';
import { useTranslation } from 'react-i18next';

export default function GitHubConnectButton({
  connection,
  loading,
  onConnect,
  onDisconnect,
  className,
}) {
  const { t } = useTranslation();

  if (connection) {
    return (
      <div className={cn('flex items-center gap-3', className)}>
        {connection.github_avatar || connection.githubAvatar ? (
          <img
            src={connection.github_avatar || connection.githubAvatar}
            alt=""
            className="h-6 w-6 rounded-full"
          />
        ) : (
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100">
            <Github className="h-3.5 w-3.5 text-zinc-600" />
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-900">
            {connection.github_username || connection.githubUsername || 'GitHub'}
          </p>
          <p className="text-xs text-zinc-500">{t('git:connected')}</p>
        </div>
        <button
          type="button"
          onClick={onDisconnect}
          disabled={loading}
          title={t('git:disconnect_github', { defaultValue: 'Disconnect GitHub' })}
          aria-label={t('git:disconnect_github', { defaultValue: 'Disconnect GitHub' })}
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
      disabled={loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50',
        className,
      )}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Github className="h-4 w-4" />
      )}
      {t('git:connect_to_github', { defaultValue: 'Connect to GitHub' })}
    </button>
  );
}
