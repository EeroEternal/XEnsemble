// 回归测试：verify agent 未产出 final（跑满 60 轮/空转 break）时，fallback 的成败判定。
//
// 事故：server-manage（Vue 前端 + Spring Boot 后端，多仓库）后端 8081 起不来（MySQL 连不上），
// 但前端 vite dev 在 8000 正常 serve。fallback 的 assertAppIsServed 命中前端 → 旧逻辑把
// fallbackOk 置 true，后端复核 `if (!fallbackOk && hasBackend)` 被短路 → preview 报成功、
// 隧道指向前端 8000 → 用户交互全 500。今天多次"前端假活"修复都打在正常路径（agent 有 final），
// 没覆盖这条"跑满轮数 fallback"路径。
//
// 这里锁死规则：项目有后端证据时，前端 serve 不足以判成功，必须后端存活。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveFallbackOutcome } = require('./analyzeVerify');

test('fallback: 无后端证据（纯前端/静态站）前端 serve 即成功', () => {
    assert.equal(resolveFallbackOutcome({ frontendOk: true, needsBackend: false, backendAlive: false }), 'ok');
});

test('fallback: 无后端证据且前端也没起 → no_app', () => {
    assert.equal(resolveFallbackOutcome({ frontendOk: false, needsBackend: false, backendAlive: false }), 'no_app');
});

test('fallback: 有后端证据 + 后端存活 → ok（前端可选）', () => {
    assert.equal(resolveFallbackOutcome({ frontendOk: true, needsBackend: true, backendAlive: true }), 'ok');
    assert.equal(resolveFallbackOutcome({ frontendOk: false, needsBackend: true, backendAlive: true }), 'ok');
});

test('fallback: 有后端证据但后端未起 → 失败（核心回归：前端 serve 不能放行）', () => {
    // 前端在 serve、后端没起：必须判失败（旧逻辑会误判 ok）
    assert.equal(resolveFallbackOutcome({ frontendOk: true, needsBackend: true, backendAlive: false }), 'frontend_served_backend_down');
    // 前后端都没起：backend_down
    assert.equal(resolveFallbackOutcome({ frontendOk: false, needsBackend: true, backendAlive: false }), 'backend_down');
});
