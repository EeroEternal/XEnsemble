import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['dist/**', 'node_modules/**'] },
    {
        files: ['**/*.{js,jsx}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            parserOptions: {
                ecmaFeatures: { jsx: true },
            },
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        plugins: {
            js,
        },
        rules: {
            ...js.configs.recommended.rules,
            // no-unused-vars 误报治理：
            //  - `_` 前缀 = 有意忽略的参数/变量/捕获（`(_)=>{}`、`catch (_){}`）
            //  - ignoreRestSiblings = 解构排他提取惯用法（如 react-markdown
            //    `({ node, ...props })` 剔除 node 后透传其余 props）
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
                ignoreRestSiblings: true,
            }],
            // 尽力而为式调用（execCommand 副本、fitAddon.fit() 的布局竞态、
            // OSC/寄存器探测等）在代码库中统一使用空 catch 静默降级，
            // 不视为需要注释的空块
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        // 终端组件/工具需要用 \x1b（ESC）、\x07（BEL）等控制字符构造
        // ANSI/VT 序列的匹配与剥离正则，控制字符即匹配目标本身
        files: ['src/components/AgentConsole.jsx', 'src/lib/terminalFrameDrop.js'],
        rules: {
            'no-control-regex': 'off',
        },
    },
];
