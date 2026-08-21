# AgentHarness

agent run platform

- **系统架构**（执行面云迁移、Runtime、Preview/Deployment 唯一规范）：[docs/Architecture.md](docs/Architecture.md)
- **Agent 镜像**（boxlite 构建、agent 绑定、Admin 注册）：[docs/Agent-Images.md](docs/Agent-Images.md)
- UI 规范（对齐 ParaRouter Console）：[docs/Designs.md](docs/Designs.md)
- Agent 说明：[docs/agents.md](docs/agents.md)
- 用户管理（角色、配额、运维 CLI）：[docs/UserManagement.md](docs/UserManagement.md)
- Agent 协作规则：[AGENTS.md](AGENTS.md)

## Local Runtime

后端建议固定使用 Node 20 LTS。`node-pty` 含 native 模块，Node 24 下安装或构建可能卡住。

本地开发需 PostgreSQL。可用 Docker 一键启动：

```bash
docker compose -f docker-compose.postgres.yml up -d
```

```bash
nvm use
cd server
npm install
npm run db:migrate
npm run dev
```
