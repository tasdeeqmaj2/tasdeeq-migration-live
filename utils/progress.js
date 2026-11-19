function formatCount(n) {
  return Number(n).toLocaleString('en-US');
}

function reportDone(label, count) {
  console.log(`✔ ${formatCount(count)} ${label}`);
}

/**
 * Live progress line for long-running migrations.
 * Example: User Document Verification — added 1,500 | processed 2,000/10,000 | left 8,000
 */
function reportProgress(label, stats) {
  const parts = [`${label} —`];

  if (stats.added != null) {
    parts.push(`added ${formatCount(stats.added)}`);
  }
  if (stats.processed != null && stats.total != null) {
    parts.push(
      `processed ${formatCount(stats.processed)}/${formatCount(stats.total)}`
    );
    const left = Math.max(0, stats.total - stats.processed);
    parts.push(`left ${formatCount(left)}`);
  }
  if (stats.skipped != null) {
    parts.push(`skipped ${formatCount(stats.skipped)}`);
  }
  if (stats.unmatched != null) {
    parts.push(`unmatched ${formatCount(stats.unmatched)}`);
  }
  if (stats.batch != null) {
    parts.push(`batch ${stats.batch}`);
  }

  console.log(parts.join(' | '));
}

module.exports = { formatCount, reportDone, reportProgress };
