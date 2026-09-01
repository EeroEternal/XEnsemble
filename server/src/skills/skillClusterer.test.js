const { test } = require('node:test');
const assert = require('node:assert/strict');
const clusterer = require('./skillClusterer');

test('tokenize lowercases, strips punctuation and stopwords', () => {
    const tokens = clusterer.tokenize('Fix the Login Bug! (auth)');
    assert.ok(!tokens.includes('the'));
    assert.ok(!tokens.includes('!'));
    assert.ok(tokens.includes('fix'));
    assert.ok(tokens.includes('login'));
    assert.ok(tokens.includes('bug'));
    assert.ok(tokens.includes('auth'));
});

test('tokenize handles Chinese text and stopwords', () => {
    const tokens = clusterer.tokenize('修复了数据库连接池的泄漏问题');
    // 中文按 2-gram 切分
    assert.ok(tokens.includes('数据'));
    assert.ok(tokens.includes('连接'));
    assert.ok(tokens.includes('泄漏'));
    // 停用词 '了' '的' 不会以单字存在；2-gram 不会命中它们
    assert.ok(!tokens.includes('了'));
});

test('fingerprint returns space-joined normalized tokens', () => {
    assert.equal(clusterer.fingerprint('Fix the login bug'), 'fix login bug');
    assert.equal(clusterer.fingerprint(''), '');
});

test('jaccard similarity', () => {
    assert.equal(clusterer.jaccard(['a', 'b'], ['a', 'b']), 1);
    assert.equal(clusterer.jaccard(['a', 'b'], ['a', 'c']), 1 / 3);
    assert.equal(clusterer.jaccard(['a'], ['b']), 0);
    assert.equal(clusterer.jaccard([], []), 1); // 两集合皆空视为相似
    assert.equal(clusterer.jaccard(['a'], []), 0);
});

test('areSimilar uses threshold 0.6', () => {
    assert.equal(clusterer.areSimilar('fix the login bug', 'fix the login bug in auth'), true);
    assert.equal(clusterer.areSimilar('fix login bug', 'add new feature page'), false);
});

test('cluster groups similar candidates by transitive closure', () => {
    const candidates = [
        { sessionId: 's1', overview: 'fix the login bug' },
        { sessionId: 's2', overview: 'fix the login bug in auth' },
        { sessionId: 's3', overview: 'add new feature page' },
    ];
    const groups = clusterer.cluster(candidates);
    // s1 & s2 相似 → 同簇；s3 独立
    assert.equal(groups.length, 2);
    const s1Group = groups.find((g) => g.sessionIds.includes('s1'));
    assert.ok(s1Group);
    assert.equal(s1Group.size, 2);
    // 簇 id = 簇内最早候选 sessionId
    assert.equal(s1Group.clusterId, 's1');
});

test('cluster respects injected similarityFn', () => {
    const candidates = [
        { sessionId: 'a', overview: 'x' },
        { sessionId: 'b', overview: 'x' },
    ];
    // 强制全部相似
    const groups = clusterer.cluster(candidates, { similarityFn: () => true });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].size, 2);
});
