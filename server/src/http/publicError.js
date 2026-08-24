const { t } = require('../i18n');

/**
 * 将 Drizzle/PostgreSQL 原始错误转为对用户安全的文案，避免泄露 SQL。
 */

function errorDetail(err) {
    if (!err) return '';
    const parts = [err.message, err.cause?.message, err.cause?.code].filter(Boolean);
    return parts.join(' ');
}

function isDatabaseError(err) {
    if (!err) return false;
    const detail = errorDetail(err);
    if (/Failed query:|DrizzleQueryError|PostgresError|permission denied for (table|schema|database)/i.test(detail)) {
        return true;
    }
    if (err.cause?.code && /^[0-9A-Z]{5}$/.test(String(err.cause.code))) {
        return true;
    }
    return false;
}

function isUniqueViolation(err) {
    const detail = errorDetail(err);
    return /23505|duplicate key|UNIQUE constraint|unique constraint/i.test(detail);
}

function mapPostgresError(err) {
    const code = err?.cause?.code;
    const detail = errorDetail(err);

    if (isUniqueViolation(err)) {
        if (/users_username_unique|username/i.test(detail)) {
            return { statusCode: 400, code: 'username_exists' };
        }
        return { statusCode: 400, code: 'record_exists' };
    }

    switch (code) {
        case '23503':
            return { statusCode: 400, code: 'related_not_found' };
        case '23502':
            return { statusCode: 400, code: 'required_field_missing' };
        case '42501':
            return { statusCode: 403, code: 'operation_not_permitted' };
        case '42P01':
            return { statusCode: 500, code: 'db_not_ready' };
        default:
            return null;
    }
}

/**
 * @param {Error & { statusCode?: number, code?: string }} err
 * @param {string} [fallback='Request failed']
 * @param {string} [locale='en']
 * @returns {{ statusCode: number, message: string, code?: string }}
 */
function sanitizePublicError(err, fallback = 'Request failed', locale = 'en') {
    if (!err) {
        return { statusCode: 500, message: t('errors:request_failed', {}, locale) };
    }

    if (isDatabaseError(err)) {
        const mapped = mapPostgresError(err);
        if (mapped) {
            const message = t('errors:' + mapped.code, mapped.params || {}, locale);
            const result = { statusCode: mapped.statusCode, message };
            if (err.code) result.code = err.code;
            return result;
        }
        const message = t('errors:request_failed', {}, locale);
        return err.code
            ? { statusCode: 500, message, code: err.code }
            : { statusCode: 500, message };
    }

    if (err.statusCode) {
        const result = {
            statusCode: err.statusCode,
            message: err.message || t('errors:request_failed', {}, locale),
        };
        if (err.code) result.code = err.code;
        return result;
    }

    const message = t('errors:request_failed', {}, locale);
    return err.code
        ? { statusCode: 500, message, code: err.code }
        : { statusCode: 500, message };
}

/**
 * @param {import('fastify').FastifyReply} reply
 * @param {Error & { statusCode?: number, code?: string }} err
 * @param {string} [fallback='Request failed']
 * @param {number} [defaultCode=500]
 * @param {string} [locale='en']
 */
function sendPublicError(reply, err, fallback = 'Request failed', defaultCode = 500, locale = 'en') {
    const sanitized = sanitizePublicError(err, fallback, locale);
    const statusCode = err.statusCode || sanitized.statusCode || defaultCode;
    const body = { error: sanitized.message };
    if (sanitized.code || err.code) body.code = sanitized.code || err.code;
    return reply.code(statusCode).send(body);
}

module.exports = {
    isDatabaseError,
    isUniqueViolation,
    sanitizePublicError,
    sendPublicError,
};
