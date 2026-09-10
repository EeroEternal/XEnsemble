'use strict';

// ──────────────────────────────────────────────────────────────────────────
// 通用数据库适配（与具体项目/DB 无关）
//
// 设计原则：
//  1) 类型维度抽象：postgres / mysql / redis / mongodb... 走同一接口，不再有
//     "postgres 专用增强预配 + 其他只装不配"的割裂（历史通用性缺口）。
//  2) 适配 app、不强制改写：优先沿用 app 自身配置里的 db/user/password，在沙箱内
//     建同名库/用户；平台只把 **host 本地化**（远端 → 127.0.0.1），其余照搬。
//  3) 默认本地 + 可显式远端：preview 默认在沙箱内起 DB；需要连远端的项目由
//     平台级 preview_db_mode / 项目级 dbMode 显式开启（不硬编码）。
//
// 本模块只做"纯逻辑"：解析连接配置、判定远端、生成方言 SQL/命令、发现 schema 文件。
// 实际在 guest 里执行由 twoStage 负责，便于单测。
// ──────────────────────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', 'host.docker.internal']);

function isRemoteHost(host) {
    const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return false;
    if (LOCAL_HOSTS.has(h)) return false;
    return true;
}

function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
function sqlStr(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "''"); }
function sqlIdent(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_]/g, ''); }
function shq(s) { return `'${String(s == null ? '' : s).replace(/'/g, `'\\''`)}'`; }

// ── 方言元数据：scheme/端口/默认值/DSN/建库建用户 ──
const DIALECTS = {
    postgres: {
        aliases: ['postgres', 'postgresql', 'psql', 'pg'],
        defaultPort: 5432,
        defaults: { database: 'app', user: 'app', password: 'app' },
        dsn: ({ host, port, db, user, password }) => `postgres://${enc(user)}:${enc(password)}@${host}:${port}/${db}`,
        schemaGlobs: '*.sql',
    },
    mysql: {
        aliases: ['mysql', 'mariadb'],
        defaultPort: 3306,
        defaults: { database: 'app', user: 'root', password: 'root' },
        dsn: ({ host, port, db, user, password }) => `mysql://${enc(user)}:${enc(password)}@${host}:${port}/${db}`,
        schemaGlobs: '*.sql',
    },
};

function schemeToDialect(scheme) {
    const s = String(scheme || '').trim().toLowerCase();
    for (const [name, d] of Object.entries(DIALECTS)) {
        if (d.aliases.includes(s)) return name;
    }
    return null;
}

function fillDefaults(dialect, conn) {
    const d = DIALECTS[dialect];
    if (!d) return conn;
    return {
        database: conn.database || conn.db || d.defaults.database,
        user: conn.user || d.defaults.user,
        password: (conn.password != null && conn.password !== '') ? conn.password : d.defaults.password,
        host: conn.host || '127.0.0.1',
        port: Number(conn.port) || d.defaultPort,
        evidence: conn.evidence || null,
        source: conn.source || 'default',
    };
}

// ── 解析器：从一批 {path, text} 文件里提取各类型的连接配置（尽量沿用 app 自身值）──

function parseUrlInto(conns, rawUrl, evidence) {
    const m = String(rawUrl || '').match(/^\s*([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:([^:@/\s]+)(?::([^@/\s]*))?@)?([^:/?\s]+)(?::(\d+))?\/([^?\s#]*)/);
    if (!m) return;
    const [, scheme, user, password, host, port, db] = m;
    const dialect = schemeToDialect(scheme);
    if (!dialect) return;
    // 同类型已有更完整来源则不覆盖（后者优先，允许后写覆盖）
    conns[dialect] = fillDefaults(dialect, {
        user: user ? decodeURIComponent(user) : undefined,
        password: password ? decodeURIComponent(password) : undefined,
        host,
        port: port ? Number(port) : undefined,
        database: db ? db.replace(/\/+$/, '') : undefined,
        evidence,
        source: 'url',
    });
}

// spring: spring.datasource.url=jdbc:mysql://host:port/db (+ .username / .password)
function parseSpringDatasource(conns, text, evidence) {
    const urlRe = /jdbc:(mysql|mariadb|postgresql):\/\/([^/\s:]+)(?::(\d+))?\/([A-Za-z0-9_$-]+)/gi;
    let m;
    while ((m = urlRe.exec(text))) {
        const dialect = m[1].toLowerCase().startsWith('postgres') ? 'postgres' : 'mysql';
        const [, , host, port, db] = m;
        // username/password：取该 url 之后最近的同名键
        const tail = text.slice(m.index, m.index + 600);
        // 值里允许 #（YAML 里 # 前无空格不算注释），去掉尾部 " #comment"
        const val = (re) => tail.match(re)?.[1]?.replace(/\s+#.*$/, '');
        const user = val(/(?:^|\n)\s*(?:spring\.datasource\.)?(?:username|user)\s*:\s*['"]?([^\s'"]+)/i);
        const pass = val(/(?:^|\n)\s*(?:spring\.datasource\.)?(?:password)\s*:\s*['"]?([^\s'"]+)/i);
        conns[dialect] = fillDefaults(dialect, {
            host, port: port ? Number(port) : undefined, database: db,
            user, password: pass, evidence, source: 'spring',
        });
    }
}

// .env 风格：POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB / MYSQL_* / DB_* / *_HOST / *_PORT
function parseKeyVals(conns, text, evidence) {
    const pick = (keys) => {
        for (const k of keys) {
            const m = text.match(new RegExp(`(?:^|\\n)\\s*${k}\\s*=\\s*['"]?([^\\s'"#]+)`, 'i'));
            if (m) return m[1];
        }
        return undefined;
    };
    const groups = [
        { dialect: 'postgres', prefix: ['POSTGRES', 'PG'] },
        { dialect: 'mysql', prefix: ['MYSQL', 'MARIADB'] },
    ];
    for (const g of groups) {
        const p = g.prefix;
        const user = pick(p.map((x) => `${x}_USER`).concat(['DB_USER']));
        const pass = pick(p.map((x) => `${x}_PASSWORD`).concat(['DB_PASSWORD']));
        const db = pick(p.flatMap((x) => [`${x}_DB`, `${x}_DATABASE`]).concat(['DB_NAME']));
        const host = pick(p.map((x) => `${x}_HOST`).concat(['DB_HOST']));
        const port = pick(p.map((x) => `${x}_PORT`).concat(['DB_PORT']));
        if (!user && !pass && !db) continue;
        conns[g.dialect] = fillDefaults(g.dialect, {
            user, password: pass, database: db, host, port: port ? Number(port) : undefined,
            evidence, source: 'env',
        });
    }
}

// 主入口：files = [{ path, text }]
function detectDbConnections(files) {
    const conns = {};
    for (const f of Array.isArray(files) ? files : []) {
        const text = String(f?.text || '');
        const evidence = f?.path || null;
        if (!text) continue;
        // 1) 任意 *_URL / DATABASE_URL / REDIS_URL（按 scheme 识别类型）
        const urlRe = /(?:DATABASE_URL|DB_URL|[A-Z0-9_]*_DATABASE_URL|[A-Z0-9_]*_URL)\s*[:=]\s*['"]?([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"#]+)/g;
        let m;
        while ((m = urlRe.exec(text))) parseUrlInto(conns, m[1], evidence);
        // 2) 裸连接串（写在脚本/代码里的 host/user/pass@host/db）
        const bareRe = /((?:postgres(?:ql)?|mysql|mariadb):\/\/[^\s'"#]+)/gi;
        let b;
        while ((b = bareRe.exec(text))) parseUrlInto(conns, b[1], evidence);
        // 3) spring jdbc datasource
        parseSpringDatasource(conns, text, evidence);
        // 4) env 分组
        parseKeyVals(conns, text, evidence);
    }
    return conns;
}

// 生成"在 guest 内建库/建用户"的 shell 命令（方言各自实现，但同一接口）。
function buildProvisionCommand(dialect, conn) {
    const c = fillDefaults(dialect, conn || {});
    if (dialect === 'postgres') {
        const u = sqlIdent(c.user) || 'app';
        const d = sqlIdent(c.database) || 'app';
        const p = sqlStr(c.password);
        return [
            `su postgres -c "psql -tAc \\"SELECT 1 FROM pg_roles WHERE rolname='${u}'\\"" 2>/dev/null | grep -q 1 || su postgres -c "psql -c \\"CREATE USER ${u} WITH PASSWORD '${p}'\\""`,
            `su postgres -c "psql -c \\"ALTER USER ${u} WITH PASSWORD '${p}'\\"" 2>/dev/null || true`,
            `su postgres -c "psql -tAc \\"SELECT 1 FROM pg_database WHERE datname='${d}'\\"" 2>/dev/null | grep -q 1 || su postgres -c "createdb -O ${u} ${d}"`,
        ].join('; ');
    }
    if (dialect === 'mysql') {
        const u = sqlIdent(c.user) || 'root';
        const d = sqlIdent(c.database) || 'app';
        const p = sqlStr(c.password);
        const stmts = [`CREATE DATABASE IF NOT EXISTS \`${d}\``];
        if (u === 'root') {
            // app 用 root：把 root 密码适配为 app 的密码（localhost + 127.0.0.1 两面）。
            // 注意：这之后平台/调用方的后续 mysql 命令必须使用 app 密码（见 buildSchemaImportCommand 阶梯）。
            stmts.push(`ALTER USER 'root'@'localhost' IDENTIFIED VIA mysql_native_password USING PASSWORD('${p}')`);
            stmts.push(`CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED VIA mysql_native_password USING PASSWORD('${p}')`);
            stmts.push(`ALTER USER 'root'@'127.0.0.1' IDENTIFIED VIA mysql_native_password USING PASSWORD('${p}')`);
            stmts.push(`GRANT ALL ON *.* TO 'root'@'127.0.0.1'`);
        } else {
            stmts.push(`CREATE USER IF NOT EXISTS '${u}'@'%' IDENTIFIED BY '${p}'`);
            stmts.push(`ALTER USER '${u}'@'%' IDENTIFIED BY '${p}'`);
            stmts.push(`GRANT ALL ON \`${d}\`.* TO '${u}'@'%'`);
        }
        stmts.push('FLUSH PRIVILEGES');
        const sql = stmts.join('; ');
        // 凭据阶梯（密码用 MYSQL_PWD 传，避免 -p 对 * # 等特殊字符的解析问题）：
        //   平台预配 root/root → app 自身密码（root 密码可能已被改成这个）→ socket 免密。
        // 末尾打印**真实退出码**；绝不用 `| tail`（那会把 mysql 的失败掩盖成 tail 的 0）。
        return `set +e; `
            + `MYSQL_PWD=root mysql -uroot -e ${shq(sql)} 2>&1 `
            + `|| MYSQL_PWD=${shq(c.password)} mysql -uroot -e ${shq(sql)} 2>&1 `
            + `|| mysql -uroot -e ${shq(sql)} 2>&1; `
            + `echo "__DBPROV_EXIT__=$?"`;
    }
    return null;
}

// 导入 schema：用 app 自身凭据（provision 可能已把 root 密码改成 app 密码），退回 root/root；
// 末尾打印真实退出码（不掩盖失败）。
function buildSchemaImportCommand(dialect, conn, relPath) {
    const c = fillDefaults(dialect, conn || {});
    if (dialect === 'postgres') {
        return `set +e; su postgres -c "psql -d ${sqlIdent(c.database)} -f ${shq(relPath)}" 2>&1; echo "__DBIMP_EXIT__=$?"`;
    }
    if (dialect === 'mysql') {
        const u = sqlIdent(c.user) || 'root';
        const d = sqlIdent(c.database) || 'app';
        return `set +e; MYSQL_PWD=${shq(c.password)} mysql -u${u} ${d} < ${shq(relPath)} 2>&1 `
            + `|| MYSQL_PWD=root mysql -uroot ${d} < ${shq(relPath)} 2>&1; `
            + `echo "__DBIMP_EXIT__=$?"`;
    }
    return null;
}

// 从 schema 文件集合里挑出该类型的 .sql（通用：先 sql/ 目录，再 init/schema 命名）
function pickSchemaFiles(dialect, files) {
    const list = (Array.isArray(files) ? files : [])
        .map((f) => (typeof f === 'string' ? f : f?.path))
        .filter(Boolean);
    if (!DIALECTS[dialect]) return [];
    const sql = list.filter((p) => /\.sql$/i.test(p));
    const ranked = [
        ...sql.filter((p) => /(^|\/)(init|schema|create|ddl)\.sql$/i.test(p)),
        ...sql.filter((p) => /(^|\/)migrations?\//i.test(p)),
        ...sql,
    ];
    return [...new Set(ranked)].slice(0, 5);
}

module.exports = {
    DIALECTS,
    LOCAL_HOSTS,
    isRemoteHost,
    schemeToDialect,
    fillDefaults,
    detectDbConnections,
    buildProvisionCommand,
    buildSchemaImportCommand,
    pickSchemaFiles,
    _internal: { parseUrlInto, parseSpringDatasource, parseKeyVals, sqlStr, sqlIdent, shq },
};
