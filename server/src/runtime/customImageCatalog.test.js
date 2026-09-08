const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORY_AGENT,
  CATEGORY_LANGUAGE,
  CUSTOM_IMAGE_CATALOG,
  getCatalog,
  getComponentById,
  getInstallFragment,
  validateSelection,
  selectionToInstallList,
} = require('./customImageCatalog');

test('catalog includes both agent and language components', () => {
  const catalog = getCatalog();
  const agentIds = catalog.filter((c) => c.category === CATEGORY_AGENT);
  const langIds = catalog.filter((c) => c.category === CATEGORY_LANGUAGE);

  assert.ok(agentIds.length > 0, 'should have agent components');
  assert.ok(langIds.length > 0, 'should have language components');

  const langComponents = ['python', 'go', 'java', 'nodejs'];
  for (const lang of langComponents) {
    assert.ok(
      catalog.some((c) => c.id === `lang:${lang}`),
      `should have lang:${lang}`,
    );
  }
});

test('agent components have latest version', () => {
  const catalog = getCatalog();
  for (const entry of catalog.filter((c) => c.category === CATEGORY_AGENT)) {
    assert.deepEqual(entry.versions, [{ version: 'latest', is_default: true }]);
    assert.equal(entry.defaultVersion, 'latest');
  }
});

test('language components declare default version', () => {
  const catalog = getCatalog();
  for (const entry of catalog.filter((c) => c.category === CATEGORY_LANGUAGE)) {
    assert.ok(entry.defaultVersion, `${entry.id} should have a defaultVersion`);
    const defaultEntry = entry.versions.find((v) => v.is_default);
    assert.ok(defaultEntry, `${entry.id} should have a default version entry`);
    assert.equal(entry.defaultVersion, defaultEntry.version);
  }
});

test('getComponentById returns component or null', () => {
  assert.ok(getComponentById('lang:python'), 'should find lang:python');
  assert.equal(getComponentById('nonexistent'), null, 'should return null for unknown');
});

test('getInstallFragment returns install for valid components', () => {
  assert.ok(
    getInstallFragment('lang:python', '3.12').includes('Python-3.12'),
    'should return python install script',
  );
  assert.equal(
    getInstallFragment('lang:nonexistent', '1.0'),
    null,
    'should return null for unknown language',
  );
  assert.equal(
    getInstallFragment('lang:python', '999'),
    null,
    'should return null for unknown version',
  );
});

test('validateSelection accepts valid agent + language selection', () => {
  const result = validateSelection([
    { component_id: 'agent:claude-code', version: 'latest' },
    { component_id: 'lang:python', version: '3.12' },
  ]);
  assert.equal(result.ok, true, 'valid selection should pass');
  assert.equal(result.error, undefined);
});

test('validateSelection rejects unknown component', () => {
  const result = validateSelection([
    { component_id: 'hack:evil', version: '1.0' },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown component/);
});

test('validateSelection rejects unknown version', () => {
  const result = validateSelection([
    { component_id: 'lang:python', version: '999.999' },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /not available for component/);
});

test('validateSelection rejects arbitrary input (no prefix)', () => {
  const result = validateSelection([
    { component_id: 'curl_hack', version: '1.0' },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown component/);
});

test('validateSelection rejects empty array', () => {
  const result = validateSelection([]);
  assert.equal(result.ok, false);
  assert.match(result.error, /non-empty/);
});

test('validateSelection rejects duplicate component', () => {
  const result = validateSelection([
    { component_id: 'lang:python', version: '3.12' },
    { component_id: 'lang:python', version: '3.13' },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /duplicate/);
});

test('validateSelection rejects missing fields', () => {
  const r1 = validateSelection([{}]);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /component_id is required/);

  const r2 = validateSelection([{ component_id: 'lang:python' }]);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /version is required/);
});

test('selectionToInstallList maps selection to install fragments', () => {
  const list = selectionToInstallList([
    { component_id: 'lang:python', version: '3.12' },
    { component_id: 'agent:claude-code', version: 'latest' },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].component_id, 'lang:python');
  assert.equal(list[0].version, '3.12');
  assert.equal(list[0].category, CATEGORY_LANGUAGE);
  assert.ok(list[0].install.includes('Python-3.12'));

  assert.equal(list[1].component_id, 'agent:claude-code');
  assert.equal(list[1].category, CATEGORY_AGENT);
});

// --- Agent × Node.js cross-compatibility tests ---

// Helper: test all agents that require Node.js >= 22
const NODE22_AGENTS = ['kimi-code', 'claude-code', 'qwen-code', 'openclaw', 'pi'];
for (const agentId of NODE22_AGENTS) {
  test(`validateSelection rejects ${agentId} with Node.js 18`, () => {
    const result = validateSelection([
      { component_id: `agent:${agentId}`, version: 'latest' },
      { component_id: 'lang:nodejs', version: '18' },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /requires Node.js >= 22.*Node.js 18/);
  });

  test(`validateSelection rejects ${agentId} with Node.js 20`, () => {
    const result = validateSelection([
      { component_id: `agent:${agentId}`, version: 'latest' },
      { component_id: 'lang:nodejs', version: '20' },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /requires Node.js >= 22.*Node.js 20/);
  });

  test(`validateSelection accepts ${agentId} with Node.js 22`, () => {
    const result = validateSelection([
      { component_id: `agent:${agentId}`, version: 'latest' },
      { component_id: 'lang:nodejs', version: '22' },
    ]);
    assert.equal(result.ok, true);
  });

  test(`validateSelection accepts ${agentId} without explicit Node.js`, () => {
    const result = validateSelection([
      { component_id: `agent:${agentId}`, version: 'latest' },
      { component_id: 'lang:python', version: '3.11' },
    ]);
    assert.equal(result.ok, true);
  });
}

// Helper: test all agents that require Node.js >= 20
const NODE20_AGENTS = ['qoder', 'commandcode'];
for (const agentId of NODE20_AGENTS) {
  test(`validateSelection rejects ${agentId} with Node.js 18`, () => {
    const result = validateSelection([
      { component_id: `agent:${agentId}`, version: 'latest' },
      { component_id: 'lang:nodejs', version: '18' },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /requires Node.js >= 20.*Node.js 18/);
  });

  test(`validateSelection accepts ${agentId} with Node.js 20`, () => {
    const result = validateSelection([
      { component_id: `agent:${agentId}`, version: 'latest' },
      { component_id: 'lang:nodejs', version: '20' },
    ]);
    assert.equal(result.ok, true);
  });
}

// Helper: test all agents that require Node.js >= 18
const NODE18_AGENTS = ['glm-agent', 'minimax-cli'];
for (const agentId of NODE18_AGENTS) {
  test(`validateSelection accepts ${agentId} with Node.js 18`, () => {
    const result = validateSelection([
      { component_id: `agent:${agentId}`, version: 'latest' },
      { component_id: 'lang:nodejs', version: '18' },
    ]);
    assert.equal(result.ok, true);
  });
}

// Agents without minNodeVersion — should accept any Node.js version
const NO_REQUIREMENT_AGENTS = ['opencode', 'cline', 'codebuddy', 'github-copilot', 'droid'];
for (const agentId of NO_REQUIREMENT_AGENTS) {
  test(`validateSelection accepts ${agentId} with Node.js 18 (no minNodeVersion)`, () => {
    const result = validateSelection([
      { component_id: `agent:${agentId}`, version: 'latest' },
      { component_id: 'lang:nodejs', version: '18' },
    ]);
    assert.equal(result.ok, true);
  });
}

test('validateSelection reports error for the highest-requirement agent when multiple selected', () => {
  const result = validateSelection([
    { component_id: 'agent:kimi-code', version: 'latest' },
    { component_id: 'agent:qoder', version: 'latest' },
    { component_id: 'lang:nodejs', version: '18' },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /kimi-code.*requires Node.js >= 22/);
  assert.match(result.error, /qoder.*requires Node.js >= 20/);
});

test('catalog exposes minNodeVersion for agents that declare it', () => {
  const catalog = getCatalog();
  const kimi = catalog.find((c) => c.id === 'agent:kimi-code');
  assert.equal(kimi.minNodeVersion, '22');

  const opencode = catalog.find((c) => c.id === 'agent:opencode');
  assert.equal(opencode.minNodeVersion, undefined);
});
