const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    classifyForwardFailure,
    headerValue,
    ORIGIN_UPSTREAM,
    ORIGIN_GATEWAY_QUOTA,
    ORIGIN_GATEWAY_INFRA,
} = require('./proxy');

describe('LLM proxy failure attribution', () => {
    it('upstream attribution header wins regardless of status', () => {
        assert.equal(
            classifyForwardFailure(429, { 'x-gateway-attribution': 'upstream' }),
            ORIGIN_UPSTREAM,
        );
        assert.equal(
            classifyForwardFailure(503, { 'x-gateway-attribution': 'upstream' }),
            ORIGIN_UPSTREAM,
        );
    });

    it('gateway attribution header classifies as gateway infra', () => {
        assert.equal(
            classifyForwardFailure(502, { 'x-gateway-attribution': 'gateway' }),
            ORIGIN_GATEWAY_INFRA,
        );
    });

    it('429 without attribution header is the gateway own rate limit', () => {
        assert.equal(classifyForwardFailure(429, {}), ORIGIN_GATEWAY_QUOTA);
        assert.equal(classifyForwardFailure(429, null), ORIGIN_GATEWAY_QUOTA);
    });

    it('other non-2xx without attribution is gateway infra', () => {
        assert.equal(classifyForwardFailure(500, {}), ORIGIN_GATEWAY_INFRA);
        assert.equal(classifyForwardFailure(404, {}), ORIGIN_GATEWAY_INFRA);
    });

    it('headerValue unwraps single and array header values', () => {
        assert.equal(headerValue({ 'x-upstream-status': '429' }, 'x-upstream-status'), '429');
        assert.equal(headerValue({ 'x-upstream-status': ['429', '503'] }, 'x-upstream-status'), '429');
        assert.equal(headerValue({}, 'x-upstream-status'), undefined);
        assert.equal(headerValue(null, 'x-upstream-status'), undefined);
    });
});
