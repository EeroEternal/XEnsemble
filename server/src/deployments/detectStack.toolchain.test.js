// detectSystemDeps toolchain 生产者契约测试（独立小文件，避免被 `--test-force-exit`
// 在大型 detectStack.test.js 上截断而漏跑）。
//
// 回归背景：recordToolchain 早期签名是 (tool, evidence)，只 push {tool, evidence}，
// 把 TOOLCHAIN_FILES 里定义好的 packages 丢了。消费端 twoStage.ensureGuestToolchains
// 用 `if (pkgs.length)` 作闸门 → items 恒空 → 前置预装静默空转 → verify agent 只能现场
// `apt-get install openjdk… maven`，单条 run_shell 600s 超时 + dpkg 锁残留，部署卡 10+ 分钟。
//
// 这里锁死：detectSystemDeps 产出的每个 toolchain 必须带 packages 数组，且与沙箱
// （Debian bookworm）可安装的 apt 包映射一致；无官方包的语言（dart/.NET）留空数组。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectSystemDeps } = require('./detectStack');

function makeProject(layout) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detectstack-tc-'));
    for (const [rel, content] of Object.entries(layout)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (content !== null && content !== undefined) fs.writeFileSync(full, content);
    }
    return dir;
}

function rm(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('detectSystemDeps: java/maven toolchain carries installable apt packages (nested subdir)', () => {
    const dir = makeProject({
        'server-manage-server/manage-api/pom.xml': '<project><properties><java.version>17</java.version></properties></project>',
    });
    try {
        const r = detectSystemDeps(dir);
        const tc = r.toolchains.find((t) => t.tool === 'jdk-maven');
        assert.ok(tc, `jdk-maven not detected: ${JSON.stringify(r.toolchains)}`);
        assert.ok(
            Array.isArray(tc.packages) && tc.packages.includes('default-jdk') && tc.packages.includes('maven'),
            `jdk-maven packages must be carried through: ${JSON.stringify(tc)}`,
        );
        assert.match(tc.evidence || '', /server-manage-server\/manage-api/);
    } finally { rm(dir); }
});

test('detectSystemDeps: gradle/ruby/elixir carry packages; dart is empty (no bookworm apt pkg)', () => {
    const dir = makeProject({
        'build.gradle': 'plugins {}',
        'Gemfile': 'source "https://rubygems.org"',
        'mix.exs': 'defmodule App do end',
        'pubspec.yaml': 'name: app',
    });
    try {
        const r = detectSystemDeps(dir);
        const by = Object.fromEntries(r.toolchains.map((t) => [t.tool, t]));
        assert.deepEqual(by['jdk-gradle']?.packages, ['default-jdk', 'gradle']);
        assert.deepEqual(by['ruby']?.packages, ['ruby', 'ruby-bundler']);
        assert.deepEqual(by['elixir']?.packages, ['elixir']);
        assert.deepEqual(by['dart']?.packages, []);
    } finally { rm(dir); }
});

test('detectSystemDeps: .NET csproj yields dotnet toolchain with empty packages (no bookworm apt pkg)', () => {
    const dir = makeProject({
        'src/App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    });
    try {
        const r = detectSystemDeps(dir);
        const tc = r.toolchains.find((t) => t.tool === 'dotnet');
        assert.ok(tc, `dotnet not detected: ${JSON.stringify(r.toolchains)}`);
        assert.deepEqual(tc.packages, []);
    } finally { rm(dir); }
});

test('detectSystemDeps: every emitted toolchain always has a packages array (consumer contract)', () => {
    const dir = makeProject({
        'server/pom.xml': '<project></project>',
        'web/pubspec.yaml': 'name: web',
    });
    try {
        const r = detectSystemDeps(dir);
        assert.ok(r.toolchains.length > 0, 'expected at least one toolchain');
        for (const tc of r.toolchains) {
            assert.ok(Array.isArray(tc.packages), `toolchain ${tc.tool} missing packages array`);
        }
    } finally { rm(dir); }
});
