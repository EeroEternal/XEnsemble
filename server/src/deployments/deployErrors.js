const { t } = require('../i18n');

// Environment-image errors raised by the deploy/preview pipelines. The service
// layer throws machine-readable codes; the HTTP/SSE boundary localizes them so
// the frontend keeps showing the existing failure view unchanged.
const ENV_ERROR_CODES = new Set([
    'custom_image_build_failed',
    'custom_image_build_timeout',
    'custom_image_not_ready',
    'custom_image_builds_unavailable',
]);

function localizeDeployError(result, locale) {
    if (!result || result.ok) return result;
    const code = result.code || result.errorCode;
    if (!code || !ENV_ERROR_CODES.has(code)) return result;
    return { ...result, code, error: t(`errors:${code}`, {}, locale || 'en') };
}

module.exports = { ENV_ERROR_CODES, localizeDeployError };
