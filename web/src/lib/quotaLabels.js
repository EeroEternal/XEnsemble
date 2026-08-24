import i18next from 'i18next';

export function quotaDimensionLabel(dimension) {
  const labels = {
    max_projects: i18next.t('users:field.projects'),
    projects: i18next.t('users:field.projects'),
    max_sessions: i18next.t('users:field.sessions'),
    sessions: i18next.t('users:field.sessions'),
    max_previews: i18next.t('users:field.previews'),
    previews: i18next.t('users:field.previews'),
  };
  return labels[dimension] || dimension;
}

export function formatQuotaExceeded(dimension, current, limit) {
  return i18next.t('errors:quota_exceeded', { dimension: quotaDimensionLabel(dimension), current, limit });
}
