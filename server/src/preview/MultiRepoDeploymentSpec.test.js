const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMultiRepoSpec, resolvePreviewByPath, resolveDefaultPreview } = require('./MultiRepoDeploymentSpec');

test('buildMultiRepoSpec: 旧 spec.preview 转 previews[]', () => {
    const r = buildMultiRepoSpec([], { preview: { port: 3000 } });
    assert.equal(r.previews.length, 1);
    assert.equal(r.previews[0].port, 3000);
    assert.equal(r.previews[0].name, 'default');
});

test('buildMultiRepoSpec: 已有 previews[] 原样返回', () => {
    const spec = { previews: [{ name: 'web', port: 3000 }] };
    assert.equal(buildMultiRepoSpec([], spec), spec);
});

test('buildMultiRepoSpec: 无 preview 配置 → previews 为空数组', () => {
    assert.deepEqual(buildMultiRepoSpec([], {}).previews, []);
});

test('resolvePreviewByPath: 按前缀最长匹配', () => {
    const previews = [
        { name: 'frontend', port: 3000 },
        { name: 'frontend/admin', port: 3001 },
    ];
    assert.equal(resolvePreviewByPath(previews, '/frontend/admin/users').name, 'frontend/admin');
    assert.equal(resolvePreviewByPath(previews, '/frontend/dashboard').name, 'frontend');
});

test('resolvePreviewByPath: 前缀必须按段匹配（/front 不匹配 /frontend）', () => {
    const previews = [{ name: 'frontend', port: 3000 }];
    assert.equal(resolvePreviewByPath(previews, '/frontendx'), null);
});

test('resolvePreviewByPath: 未匹配返回 null（不静默回退）', () => {
    const previews = [{ name: 'frontend', port: 3000 }];
    assert.equal(resolvePreviewByPath(previews, '/backend/api'), null);
    assert.equal(resolvePreviewByPath(previews, '/'), null);
});

test('resolveDefaultPreview: 优先 isPrimary，否则第一个', () => {
    assert.equal(resolveDefaultPreview([
        { name: 'api', port: 3001 },
        { name: 'web', port: 3000, isPrimary: true },
    ]).name, 'web');
    assert.equal(resolveDefaultPreview([{ name: 'only', port: 8080 }]).name, 'only');
    assert.equal(resolveDefaultPreview([]), null);
});
