const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const {
    fetchModelCatalog,
    lookupCatalog,
    findCatalogEntries,
    usdEstimateFromEntry,
    modelFamily,
} = require('./modelCatalog');

function catalog(entries) {
    return { version: 1, currency: 'USD', entries };
}

test('modelFamily collapses dated flash snapshots and DeepSeek aliases', () => {
    assert.equal(modelFamily('glm-5.3-flash'), 'glm-5.3-flash');
    assert.equal(modelFamily('glm-5.3'), 'glm-5.3');
    assert.equal(modelFamily('glm-5-3-flash-260826'), 'glm-5.3-flash');
    assert.equal(modelFamily('deepseek-v4-flash-ga-260731'), 'deepseek-v4-flash');
    assert.equal(modelFamily('deepseek-chat'), 'deepseek-v4-flash');
    assert.equal(modelFamily('minimax/minimax-m3:free'), 'minimax-m3');
    assert.equal(modelFamily('glm-4.5'), 'glm-4.5');
});

test('lookupCatalog prefers exact provider+model then same-family price', () => {
    const cat = catalog([
        {
            provider: 'personal_glm',
            model: 'glm-5.3-flash',
            canonical_model_id: 'glm-5.3-flash',
            family: 'glm-5.3-flash',
            capability: 0.92,
            price: { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: null },
        },
        {
            provider: 'xjx',
            model: 'glm-5-3-flash-260826',
            canonical_model_id: 'glm-5-3-flash-260826',
            family: 'glm-5.3-flash',
            capability: 0.92,
            price: { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: null },
        },
    ]);
    const exact = lookupCatalog(cat, { provider: 'personal_glm', model: 'glm-5.3-flash' });
    assert.equal(exact.provider, 'personal_glm');
    const cross = lookupCatalog(cat, { provider: 'unknown_glm', model: 'glm-5.3-flash' });
    assert.equal(cross.family, 'glm-5.3-flash');
    assert.equal(usdEstimateFromEntry(cross).input, 0.15);
});

test('explicit zero is priced; missing price is not', () => {
    assert.deepEqual(
        usdEstimateFromEntry({
            price: { input: 0, output: 0, cache_read: 0, cache_write: null },
        }),
        { currency: 'USD', cache_read: 0, cache_write: null, input: 0, output: 0 },
    );
    assert.equal(usdEstimateFromEntry({ price: { input: null, output: null, cache_read: null, cache_write: null } }), null);
});

test('findCatalogEntries returns every provider sharing the model family', () => {
    const cat = catalog([
        {
            provider: 'openrouter-zxs',
            model: 'minimax/minimax-m3:free',
            canonical_model_id: 'minimax-m3:free',
            family: 'minimax-m3',
            capability: 0.86,
            price: { input: 0, output: 0, cache_read: 0, cache_write: null },
        },
        {
            provider: 'openrouter-zxs2',
            model: 'minimax/minimax-m3:free',
            canonical_model_id: 'minimax-m3:free',
            family: 'minimax-m3',
            capability: 0.86,
            price: { input: 0, output: 0, cache_read: 0, cache_write: null },
        },
        {
            provider: 'personal_glm',
            model: 'glm-5.3-flash',
            canonical_model_id: 'glm-5.3-flash',
            family: 'glm-5.3-flash',
            capability: 0.92,
            price: { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: null },
        },
    ]);
    const hits = findCatalogEntries(cat, { model: 'minimax/minimax-m3:free' });
    assert.equal(hits.length, 2);
});

test('fetchModelCatalog reads the on-disk table and caches until mtime changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    const catalogPath = path.join(dir, 'modelCatalog.json');
    const payload = catalog([
        {
            provider: 'personal_glm',
            model: 'glm-5.3-flash',
            canonical_model_id: 'glm-5.3-flash',
            family: 'glm-5.3-flash',
            capability: 0.92,
            price: { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: null },
        },
    ]);
    fs.writeFileSync(catalogPath, JSON.stringify(payload));
    const first = fetchModelCatalog({ catalogPath });
    const second = fetchModelCatalog({ catalogPath });
    assert.equal(first, second);
    assert.equal(first.entries[0].capability, 0.92);
    const later = new Date(Date.now() + 2000);
    payload.entries[0].capability = 0.91;
    fs.writeFileSync(catalogPath, JSON.stringify(payload));
    fs.utimesSync(catalogPath, later, later);
    const third = fetchModelCatalog({ catalogPath });
    assert.equal(third.entries[0].capability, 0.91);
});

test('on-disk project catalog keys are provider+model', () => {
    const cat = fetchModelCatalog({
        catalogPath: path.join(__dirname, 'modelCatalog.json'),
    });
    assert.ok(cat.entries.length >= 1);
    for (const entry of cat.entries) {
        assert.ok(entry.provider);
        assert.ok(entry.model);
        assert.equal(typeof entry.capability, 'number');
        assert.ok(entry.price);
    }
    const glmFlash = lookupCatalog(cat, { provider: 'personal_glm', model: 'glm-5.3-flash' });
    assert.equal(glmFlash.capability, 0.8);
    assert.equal(glmFlash.price.input, 0.15);
    const glm53 = lookupCatalog(cat, { provider: 'personal_glm', model: 'glm-5.3' });
    assert.equal(glm53.model, 'glm-5.3');
    assert.equal(glm53.capability, 0.95);
    assert.equal(glm53.price.input, 1.4);
    assert.notEqual(modelFamily('glm-5.3'), modelFamily('glm-5.3-flash'));
});
