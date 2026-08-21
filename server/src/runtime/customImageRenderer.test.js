const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getBaseImage,
  renderInstallSteps,
  renderDockerfile,
  renderBuildContext,
} = require('./customImageRenderer');

test('getBaseImage returns default when no env set', () => {
  assert.match(getBaseImage(), /box-base/);
});

test('renderInstallSteps includes selected language versions', () => {
  const selection = [
    { component_id: 'lang:python', version: '3.12' },
    { component_id: 'lang:nodejs', version: '22' },
  ];
  const steps = renderInstallSteps(selection);
  assert.ok(steps.includes('Python-3.12'), 'should install python 3.12');
  assert.ok(steps.includes('nodejs'), 'should install nodejs');
  assert.ok(steps.includes('RUN set -eux;'), 'should use set -eux');
});

test('renderInstallSteps includes agent components', () => {
  const selection = [
    { component_id: 'agent:claude-code', version: 'latest' },
  ];
  const steps = renderInstallSteps(selection);
  assert.ok(steps.includes('claude-code'), 'should mention agent name');
  assert.ok(steps.includes('npm install'), 'should include npm install');
});

test('renderDockerfile is deterministic - same selection yields identical output', () => {
  const selection = [
    { component_id: 'lang:python', version: '3.12' },
    { component_id: 'agent:claude-code', version: 'latest' },
  ];

  const first = renderDockerfile(selection);
  const second = renderDockerfile(selection);

  assert.equal(first, second, 'same selection should yield identical Dockerfile');
});

test('renderInstallSteps is deterministic - same inputs same outputs', () => {
  const selection = [
    { component_id: 'lang:java', version: '21' },
    { component_id: 'lang:go', version: '1.23' },
  ];

  const first = renderInstallSteps(selection);
  const second = renderInstallSteps(selection);

  assert.equal(first, second, 'same selection should yield identical install steps');
});

test('renderBuildContext returns dockerfile and baseImage', () => {
  const result = renderBuildContext([
    { component_id: 'lang:python', version: '3.12' },
  ]);
  assert.ok(result.dockerfile, 'should have dockerfile');
  assert.ok(result.baseImage, 'should have baseImage');
  assert.ok(result.dockerfile.includes('Python-3.12'), 'dockerfile should include install');
  assert.ok(result.dockerfile.includes('FROM ${BASE_IMAGE}'), 'should use ARG for base');
});

test('renderDockerfile sorts output sections consistently', () => {
  const reversed = renderDockerfile([
    { component_id: 'lang:python', version: '3.12' },
    { component_id: 'lang:go', version: '1.23' },
  ]);
  const direct = renderDockerfile([
    { component_id: 'lang:go', version: '1.23' },
    { component_id: 'lang:python', version: '3.12' },
  ]);

  assert.equal(reversed, direct, 'order in selection should not change Dockerfile order');
});

test('renderDockerfile includes cleanup step', () => {
  const selection = [{ component_id: 'lang:python', version: '3.12' }];
  const dockerfile = renderDockerfile(selection);
  assert.ok(dockerfile.includes('rm -rf'), 'should include cleanup');
  assert.ok(dockerfile.includes('WORKDIR /workspace'), 'should set workspace');
});

test('renderDockerfile configures npm and pip mirrors for reliable CN builds', () => {
  const dockerfile = renderDockerfile([{ component_id: 'lang:python', version: '3.12' }]);
  assert.ok(dockerfile.includes('npm_config_registry='), 'should set npm registry');
  assert.ok(dockerfile.includes('registry.npmmirror.com'), 'should default to npmmirror');
  assert.ok(dockerfile.includes('PIP_INDEX_URL='), 'should set pip index url');
});

test('renderDockerfile honors custom npm registry override', () => {
  const prev = process.env.CUSTOM_IMAGE_NPM_REGISTRY;
  process.env.CUSTOM_IMAGE_NPM_REGISTRY = 'https://my-mirror.example.com';
  try {
    const dockerfile = renderDockerfile([{ component_id: 'lang:python', version: '3.12' }]);
    assert.ok(dockerfile.includes('my-mirror.example.com'), 'should use overridden registry');
    assert.ok(!dockerfile.includes('registry.npmmirror.com'), 'should not include default');
  } finally {
    if (prev === undefined) delete process.env.CUSTOM_IMAGE_NPM_REGISTRY;
    else process.env.CUSTOM_IMAGE_NPM_REGISTRY = prev;
  }
});

test('renderDockerfile only outputs catalog-approved tokens', () => {
  const selection = [
    { component_id: 'lang:python', version: '3.12' },
  ];
  const dockerfile = renderDockerfile(selection);

  const forbidden = [
    { token: '$(', max: 2 },
    { token: '`', max: 0 },
    { token: '; rm', max: 0 },
    { token: '|| true', max: 6 },
    { token: '> /dev', max: 1 },
  ];
  for (const { token, max } of forbidden) {
    const count = (dockerfile.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.ok(
      count <= max,
      `token "${token}" appears ${count} times in Dockerfile (limit ${max}) — should only appear in known-safe patterns`,
    );
  }
});
