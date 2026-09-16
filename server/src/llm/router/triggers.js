function resolveTrigger({ sticky, compacted, stickyReleasedByFailures }) {
    if (!sticky) {
        return { trigger: 'first_turn', reevaluate: true };
    }
    if (compacted) {
        return { trigger: 'compaction', reevaluate: true };
    }
    if (stickyReleasedByFailures || sticky.failCount >= 2) {
        return { trigger: 'provider_fail', reevaluate: true };
    }
    return { trigger: 'sticky', reevaluate: false };
}

module.exports = { resolveTrigger };
