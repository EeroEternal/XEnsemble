// SSE 客户端注册表：res -> userId。broadcastSse 按 userId 过滤，避免跨账号事件泄露
// （例如用户 A 的部署完成提示被用户 B 看到）。
const sseClients = new Map();

function addSseClient(res, userId) {
    sseClients.set(res, userId);
    res.on('close', () => sseClients.delete(res));
}

function broadcastSse(event) {
    if (sseClients.size === 0) return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const [res, userId] of sseClients) {
        if (!event.userId || event.userId !== userId) continue;
        try {
            res.write(data);
        } catch (_) {
            sseClients.delete(res);
        }
    }
}

module.exports = { addSseClient, broadcastSse };
