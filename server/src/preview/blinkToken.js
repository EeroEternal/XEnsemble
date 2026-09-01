// 沙箱后端经宿主控制面反向代理访问 blink-server 时的 scoped 凭据。
// 部署时为每个 preview 签发一个绑定 deploymentId + 过期时间的 HMAC token，
// 由 twoStage 写入沙箱 BLINK_AUTH_TOKEN；宿主 gateway 的 /__blink 代理用同一 secret 校验。
// 复用宿主 JWT/加密密钥，保证只有控制面能签发/校验，沙箱无法伪造。
const crypto = require('crypto');

function secret() {
    return process.env.JWT_SECRET || process.env.ENCRYPTION_KEY || '';
}

function signBlinkToken(deploymentId, expiresAt) {
    const payload = `${deploymentId}.${expiresAt}`;
    const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

function verifyBlinkToken(token, deploymentId) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [dep, expRaw, sig] = parts;
    if (dep !== deploymentId) return null;
    const expiresAt = Number(expRaw);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
    const expect = crypto.createHmac('sha256', secret()).update(`${dep}.${expRaw}`).digest('base64url');
    let ok = false;
    try {
        ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
    } catch {
        ok = false;
    }
    if (!ok) return null;
    return { deploymentId: dep, expiresAt };
}

module.exports = { signBlinkToken, verifyBlinkToken };
