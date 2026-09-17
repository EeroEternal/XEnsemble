const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchModelPortraits } = require('./modelPortraits');

test('fetchModelPortraits reuses memory cache until the file mtime changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portraits-'));
    const registryPath = path.join(dir, 'reg.json');
    fs.writeFileSync(registryPath, JSON.stringify({
        registry_version: 'v1',
        offerings: [],
    }));
    const first = fetchModelPortraits({ registryPath });
    const second = fetchModelPortraits({ registryPath });
    assert.equal(first.registry_version, 'v1');
    assert.equal(first, second);

    const later = new Date(Date.now() + 2000);
    fs.writeFileSync(registryPath, JSON.stringify({
        registry_version: 'v2',
        offerings: [],
    }));
    fs.utimesSync(registryPath, later, later);
    const third = fetchModelPortraits({ registryPath });
    assert.equal(third.registry_version, 'v2');
    assert.notEqual(third, first);
});
