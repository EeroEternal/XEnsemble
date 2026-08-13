# TODO / 待办事项

## 内网环境下 Git OAuth 代理支持

**状态**：待实现
**优先级**：中
**日期**：2026-08-13

### 问题描述

内网环境下，XEnsemble 服务器无法直连 `github.com`（需通过 SOCKS5 代理 `socks5h://127.0.0.1:1234`）。
当前 Node.js 代码使用原生 `fetch()`（undici），**不读取 `https_proxy` 环境变量**，
导致 GitHub OAuth 流程中服务器端交换 code、获取用户信息等请求全部超时。

### 影响范围

- GitHub OAuth 连接（Connect to GitHub）完全不可用
- GitLab OAuth 同理（如果 GitLab 在外网）
- 任何 `fetch()` 发起的外网 HTTPS 请求都不走代理

### 根因

- `GitHubAdapter.js` / `GitLabAdapter.js` / `GiteaAdapter.js` 使用 Node.js 22 原生 `fetch()`
- `undici` 的 `fetch()` 不会自动使用 `https_proxy` / `HTTP_PROXY` 环境变量
- 项目未安装 `socks-proxy-agent` / `undici ProxyAgent` / `global-agent` 等代理库
- `http-proxy` 依赖仅用于创建 LLM 代理服务器，不用于客户端代理

### 临时方案

使用 Personal Access Token (PAT) 代替 OAuth：
1. 浏览器开代理访问 `https://github.com/settings/tokens` 生成 PAT
2. 在 XEnsemble 中选择 "Connect with PAT" 粘贴 token
3. PAT 方式不需要服务器访问 GitHub

### 建议实现

在 `server/src/server.js` 启动时，读取 `https_proxy` 环境变量并设置 undici 全局代理：

```js
const { setGlobalDispatcher, ProxyAgent } = require('undici');
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
}
```

注意事项：
- SOCKS5 代理需要 `socks-proxy-agent` 库（undici 的 `ProxyAgent` 仅支持 HTTP/HTTPS 代理）
- 或在本地部署 HTTP-to-SOCKS 桥接（如 `privoxy`），使用 HTTP 代理地址
- 需要测试 `fetch()`、`http-proxy`（LLM proxy）、`http.request` 等所有出站请求是否都走代理
- 内网地址（`127.0.0.1`、`192.168.x.x`、`gitlab.local`）应配置 `no_proxy` 旁路
