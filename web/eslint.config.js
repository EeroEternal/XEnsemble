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
        },
    },
];
