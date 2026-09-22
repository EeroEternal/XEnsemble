const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildClaudeGatewayModelPickerPatch,
    mergeClaudeSettingsJson,
} = require('./claudeConfigBootstrap');

test('buildClaudeGatewayModelPickerPatch: >= 2.1.242 replaces builtins with prefixed gateway ids', () => {
    const patch = buildClaudeGatewayModelPickerPatch('2.1.278', [
        'personal_glm/glm-5.3',
        'personal_glm/glm-5.3-flash',
    ]);
    assert.deepEqual(patch.availableModels, [
        'anthropic.personal_glm/glm-5.3',
        'anthropic.personal_glm/glm-5.3-flash',
    ]);
    assert.equal(patch.enforceAvailableModels, true);
    assert.equal(patch.modelPicker.replaceBuiltInOptions, true);
    assert.deepEqual(patch.modelPicker.options, [
        { model: 'anthropic.personal_glm/glm-5.3', label: 'glm-5.3' },
        { model: 'anthropic.personal_glm/glm-5.3-flash', label: 'glm-5.3-flash' },
    ]);
});

test('buildClaudeGatewayModelPickerPatch: 2.1.175..241 writes whitelist without modelPicker', () => {
    const patch = buildClaudeGatewayModelPickerPatch('2.1.237', ['personal_glm/glm-5.3']);
    assert.deepEqual(patch.availableModels, ['anthropic.personal_glm/glm-5.3']);
    assert.equal(patch.enforceAvailableModels, true);
    assert.equal(patch.modelPicker, undefined);
});

test('buildClaudeGatewayModelPickerPatch: older than 2.1.175 only writes availableModels', () => {
    const patch = buildClaudeGatewayModelPickerPatch('2.1.100', ['personal_glm/glm-5.3']);
    assert.deepEqual(patch.availableModels, ['anthropic.personal_glm/glm-5.3']);
    assert.equal(patch.enforceAvailableModels, undefined);
    assert.equal(patch.modelPicker, undefined);
});

test('buildClaudeGatewayModelPickerPatch: does not double-prefix anthropic. ids', () => {
    const patch = buildClaudeGatewayModelPickerPatch('2.1.278', [
        'anthropic.personal_glm/glm-5.3',
    ]);
    assert.deepEqual(patch.availableModels, ['anthropic.personal_glm/glm-5.3']);
    assert.equal(patch.modelPicker.options[0].model, 'anthropic.personal_glm/glm-5.3');
});

test('buildClaudeGatewayModelPickerPatch: empty targets returns null', () => {
    assert.equal(buildClaudeGatewayModelPickerPatch('2.1.278', []), null);
    assert.equal(buildClaudeGatewayModelPickerPatch('2.1.278', null), null);
});

test('mergeClaudeSettingsJson: patches picker fields without dropping permissions', () => {
    const merged = mergeClaudeSettingsJson(
        { permissions: { allow: ['Bash'] }, env: { FOO: '1' } },
        buildClaudeGatewayModelPickerPatch('2.1.278', ['personal_glm/glm-5.3']),
    );
    assert.deepEqual(merged.permissions, { allow: ['Bash'] });
    assert.equal(merged.env.FOO, '1');
    assert.equal(merged.modelPicker.replaceBuiltInOptions, true);
    assert.deepEqual(merged.availableModels, ['anthropic.personal_glm/glm-5.3']);
});

test('ensureClaudeGatewayModelPicker: merges settings.json without wiping permissions', async () => {
    const { ensureClaudeGatewayModelPicker } = require('./claudeConfigBootstrap');
    let written = '';
    const runtime = {
        exec: {
            exec: async (_cmd, args) => {
                const script = args?.[1] || '';
                if (script.startsWith('cat ') && script.includes('2>/dev/null')) {
                    return { stdout: JSON.stringify({ permissions: { allow: ['Bash'] } }) };
                }
                written = script;
                return { stdout: '', exitCode: 0 };
            },
        },
    };
    await ensureClaudeGatewayModelPicker({
        runtime,
        stateDirPath: '/state',
        modelTargets: ['personal_glm/glm-5.3'],
        version: '2.1.278',
    });
    assert.match(written, /replaceBuiltInOptions/);
    assert.match(written, /anthropic\.personal_glm\/glm-5\.3/);
    assert.match(written, /"permissions"/);
});

test('ensureClaudeGatewayModelPicker: skips when no targets', async () => {
    const { ensureClaudeGatewayModelPicker } = require('./claudeConfigBootstrap');
    let called = 0;
    const runtime = { exec: { exec: async () => { called += 1; return { stdout: '{}' }; } } };
    await ensureClaudeGatewayModelPicker({
        runtime,
        stateDirPath: '/state',
        modelTargets: [],
        version: '2.1.278',
    });
    assert.equal(called, 0);
});
