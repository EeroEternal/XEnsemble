// Read-only diagnostics: tail recent sessions' chat transcripts to verify
// whether role:'error' events are being recorded by the LLM proxy.
//
// Usage (from server/):
//   node --env-file=.env scripts/diag-chat-tail.js              # list recent sessions
//   node --env-file=.env scripts/diag-chat-tail.js <sessionId>  # tail that session's chat events
//   node --env-file=.env scripts/diag-chat-tail.js --events [sessionId]  # recent llm_proxy_forward events
const postgres = require('postgres');

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const sessionId = process.argv[2];

async function main() {
    if (sessionId === '--events') {
        const sid = process.argv[3];
        const rows = sid
            ? await sql`
                select created_at, data
                from events
                where type = 'llm_proxy_forward' and subject_id = ${sid}
                order by created_at desc
                limit 6`
            : await sql`
                select created_at, subject_id, data
                from events
                where type = 'llm_proxy_forward'
                order by created_at desc
                limit 6`;
        console.log(JSON.stringify(rows, null, 2));
    } else if (sessionId) {
        const rows = await sql`
            select seq, ts, role, left(content, 160) as content
            from session_chat_messages
            where session_id = ${sessionId}
            order by seq desc
            limit 8`;
        rows.reverse();
        console.log(JSON.stringify(rows, null, 2));
    } else {
        const sessions = await sql`
            select id, coalesce(title, '') as title, status,
                   to_timestamp(updated_at / 1000.0) as updated
            from sessions
            order by updated_at desc
            limit 5`;
        console.log(JSON.stringify(sessions, null, 2));
    }
    await sql.end();
}

main().catch((err) => {
    console.error('diag failed:', err.message);
    process.exit(1);
});
