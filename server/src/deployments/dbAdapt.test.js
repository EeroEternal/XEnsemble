// 通用数据库适配层单测：连接配置解析 + 远端判定 + DSN + 建库建用户命令 + schema 发现。
// 覆盖真实事故：server-manage 的 Spring 配置 jdbc:mysql://10.1.52.241:49158/server_manage
// （远端 host + app 自己的 password），应被解析出来并本地化为 127.0.0.1，而非强制 root/root。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    isRemoteHost, schemeToDialect, detectDbConnections, buildProvisionCommand, buildSchemaImportCommand, pickSchemaFiles,
} = require('./dbAdapt');

test('isRemoteHost: 本地地址不算远端，LAN/公网/主机名算远端', () => {
    assert.equal(isRemoteHost('127.0.0.1'), false);
    assert.equal(isRemoteHost('localhost'), false);
    assert.equal(isRemoteHost(''), false);
    assert.equal(isRemoteHost('10.1.52.241'), true);
    assert.equal(isRemoteHost('mariadb-sql'), true);
    assert.equal(isRemoteHost('192.168.1.5'), true);
});

test('schemeToDialect: postgres/mariadb 别名归一', () => {
    assert.equal(schemeToDialect('postgresql'), 'postgres');
    assert.equal(schemeToDialect('pg'), 'postgres');
    assert.equal(schemeToDialect('mariadb'), 'mysql');
    assert.equal(schemeToDialect('redis'), null);
});

test('detectDbConnections: Spring jdbc url + username/password（适配 app，保留远端 host）', () => {
    const text = [
        'spring:',
        '  datasource:',
        '    url: jdbc:mysql://10.1.52.241:49158/server_manage?useUnicode=true',
        '    username: root',
        '    password: 2UG8gE*Mta#z',
    ].join('\n');
    const conns = detectDbConnections([{ path: 'application-dev.yml', text }]);
    assert.ok(conns.mysql, 'mysql should be detected');
    assert.equal(conns.mysql.host, '10.1.52.241');
    assert.equal(conns.mysql.port, 49158);
    assert.equal(conns.mysql.database, 'server_manage');
    assert.equal(conns.mysql.user, 'root');
    assert.equal(conns.mysql.password, '2UG8gE*Mta#z');
    assert.equal(isRemoteHost(conns.mysql.host), true);
});

test('detectDbConnections: DATABASE_URL 按 scheme 识别类型', () => {
    const conns = detectDbConnections([
        { path: '.env', text: 'DATABASE_URL=postgres://appuser:secret@db.internal:5432/appdb\n' },
    ]);
    assert.equal(conns.postgres.host, 'db.internal');
    assert.equal(conns.postgres.database, 'appdb');
    assert.equal(conns.postgres.user, 'appuser');
    assert.equal(conns.postgres.password, 'secret');
});

test('detectDbConnections: POSTGRES_*/MYSQL_* env 分组', () => {
    const conns = detectDbConnections([
        { path: '.env', text: 'POSTGRES_USER=u1\nPOSTGRES_PASSWORD=p1\nPOSTGRES_DB=d1\nPOSTGRES_HOST=10.0.0.2\nPOSTGRES_PORT=5433\n' },
    ]);
    assert.deepEqual(
        { d: conns.postgres.database, u: conns.postgres.user, p: conns.postgres.password, h: conns.postgres.host, port: conns.postgres.port },
        { d: 'd1', u: 'u1', p: 'p1', h: '10.0.0.2', port: 5433 },
    );
});

test('buildProvisionCommand: mysql app 用 root 时适配密码 + 建库 + 真实退出码', () => {
    const cmd = buildProvisionCommand('mysql', { database: 'server_manage', user: 'root', password: '2UG8gE*Mta#z' });
    assert.match(cmd, /CREATE DATABASE IF NOT EXISTS `server_manage`/);
    assert.match(cmd, /2UG8gE\*Mta#z/);
    assert.match(cmd, /GRANT ALL ON \*\.\*/);
    // 凭据阶梯（平台 root/root → app 密码）与真实退出码（不再被 | tail 掩盖）
    assert.match(cmd, /MYSQL_PWD=root/);
    assert.match(cmd, /MYSQL_PWD='2UG8gE\*Mta#z'/);
    assert.ok(cmd.includes('__DBPROV_EXIT__='), 'must echo real exit code');
    assert.ok(!/\|\s*tail/.test(cmd), 'must not mask exit code with | tail');
});

test('buildProvisionCommand: mysql 独立用户时建用户并授权到该库', () => {
    const cmd = buildProvisionCommand('mysql', { database: 'shop', user: 'shop_u', password: 'pw' });
    assert.match(cmd, /shop_u/);
    assert.match(cmd, /GRANT ALL ON `shop`\.\*/);
    assert.ok(cmd.includes('__DBPROV_EXIT__='));
});

test('buildSchemaImportCommand: 用 app 凭据 + 真实退出码（不再硬编码 -proot 被 tail 掩盖）', () => {
    const cmd = buildSchemaImportCommand('mysql', { database: 'server_manage', user: 'root', password: 'pw' }, 'sql/init.sql');
    assert.match(cmd, /MYSQL_PWD='pw' mysql -uroot server_manage </);
    assert.ok(cmd.includes('__DBIMP_EXIT__='));
    assert.ok(!/\|\s*tail/.test(cmd), 'must not mask exit code with | tail');
    const pg = buildSchemaImportCommand('postgres', { database: 'appdb' }, 'db/schema.sql');
    assert.match(pg, /psql -d appdb -f/);
    assert.ok(pg.includes('__DBIMP_EXIT__='));
});

test('buildProvisionCommand: postgres 建用户 + 授权到库（保留 app 凭据）', () => {
    const cmd = buildProvisionCommand('postgres', { database: 'appdb', user: 'appuser', password: "p'o" });
    assert.match(cmd, /CREATE USER appuser WITH PASSWORD 'p''o'/);
    assert.match(cmd, /createdb -O appuser appdb/);
});

test('pickSchemaFiles: 优先 init/schema，其次 migrations，去重', () => {
    const files = [
        'server-manage-server/manage-service/src/main/resources/sql/init.sql',
        'server-manage-upgrade/src/main/resources/update_version.sql',
        'db/migrations/001_x.sql',
        'README.md',
    ];
    const picked = pickSchemaFiles('mysql', files);
    assert.equal(picked[0], 'server-manage-server/manage-service/src/main/resources/sql/init.sql');
    assert.ok(picked.includes('db/migrations/001_x.sql'));
    assert.ok(!picked.includes('README.md'));
});
