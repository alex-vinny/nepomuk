'use strict';

const { stripHtml } = (() => {
  function stripHtml(html = '') {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .trim();
  }
  return { stripHtml };
})();

function printWorkItem(wi) {
  const f = wi.fields || {};
  const lines = [
    `ID:          ${wi.id}`,
    `Type:        ${f['System.WorkItemType'] || '—'}`,
    `State:       ${f['System.State'] || '—'}`,
    `Title:       ${f['System.Title'] || '—'}`,
    `Assigned to: ${f['System.AssignedTo']?.displayName || '—'}`,
    `Area:        ${f['System.AreaPath'] || '—'}`,
    `Iteration:   ${f['System.IterationPath'] || '—'}`,
    `Priority:    ${f['Microsoft.VSTS.Common.Priority'] ?? '—'}`,
    `Created:     ${f['System.CreatedDate'] ? new Date(f['System.CreatedDate']).toLocaleString() : '—'}`,
    `Changed:     ${f['System.ChangedDate'] ? new Date(f['System.ChangedDate']).toLocaleString() : '—'}`,
  ];

  const desc = f['System.Description'] || f['Microsoft.VSTS.TCM.ReproSteps'] || '';
  if (desc) {
    lines.push('', 'Description:', stripHtml(desc));
  }

  const ac = f['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
  if (ac) {
    lines.push('', 'Acceptance Criteria:', stripHtml(ac));
  }

  const tags = f['System.Tags'] || '';
  if (tags) lines.push('', `Tags: ${tags}`);

  console.log(lines.join('\n'));
}

function printPullRequest(pr) {
  const lines = [
    `PR #${pr.pullRequestId}: ${pr.title}`,
    `Status:    ${pr.status}`,
    `Author:    ${pr.createdBy?.displayName || '—'}`,
    `Source:    ${pr.sourceRefName}`,
    `Target:    ${pr.targetRefName}`,
    `Created:   ${pr.creationDate ? new Date(pr.creationDate).toLocaleString() : '—'}`,
    `URL:       ${pr.url || '—'}`,
  ];
  if (pr.description) lines.push('', 'Description:', pr.description);
  console.log(lines.join('\n'));
}

function printCommentThreads(threads) {
  const active = (threads.value || []).filter((t) => !t.isDeleted);
  if (!active.length) {
    console.log('No comment threads.');
    return;
  }
  active.forEach((thread, i) => {
    const ctx = thread.threadContext;
    const location = ctx?.filePath ? `${ctx.filePath}:${ctx.rightFileStart?.line ?? '?'}` : 'PR-level';
    console.log(`\n[Thread ${i + 1}] (id ${thread.id}) ${location} — status: ${thread.status}`);
    (thread.comments || [])
      .filter((c) => !c.isDeleted)
      .forEach((c) => {
        const author = c.author?.displayName || '?';
        const date = c.publishedDate ? new Date(c.publishedDate).toLocaleString() : '';
        console.log(`  ${author} (${date}):`);
        console.log(`    ${stripHtml(c.content).replace(/\n/g, '\n    ')}`);
      });
  });
}

function printWorkItemComments(result) {
  const comments = result.comments || result.value || [];
  if (!comments.length) {
    console.log('No comments.');
    return;
  }
  comments.forEach((c, i) => {
    const author = c.createdBy?.displayName || '?';
    const date = c.createdDate ? new Date(c.createdDate).toLocaleString() : '';
    console.log(`\n[${i + 1}] ${author} (${date}):`);
    console.log(`  ${stripHtml(c.text || c.content || '').replace(/\n/g, '\n  ')}`);
  });
}

function printAttachments(attachments) {
  if (!attachments.length) {
    console.log('No attachments.');
    return;
  }
  attachments.forEach((a, i) => {
    console.log(`[${i + 1}] ${a.name}`);
    if (a.comment) console.log(`     Comment: ${a.comment}`);
    console.log(`     URL: ${a.url}`);
  });
}

function printBranchDiff(diff, sourceRef, targetRef) {
  const changes = diff.changes || [];
  const files = changes.filter((c) => !c.item?.isFolder);
  console.log(`Branch diff: ${sourceRef} → ${targetRef}`);
  console.log(`Ahead: ${diff.aheadCount ?? '?'} commits | Behind: ${diff.behindCount ?? '?'} commits`);
  console.log(`Files changed: ${files.length}\n`);
  if (!files.length) {
    console.log('No file changes found.');
    return;
  }
  files.forEach((c) => {
    const changeType = c.changeType || 'edit';
    const marker = changeType === 'add' ? '[+]' : changeType === 'delete' ? '[-]' : '[~]';
    console.log(`${marker} ${c.item?.path || '?'}`);
  });
}

function printFileContents(files) {
  files.forEach(({ path: filePath, changeType, content }) => {
    const marker = changeType === 'add' ? 'ADDED' : changeType === 'delete' ? 'DELETED' : 'MODIFIED';
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`[${marker}] ${filePath}`);
    console.log('─'.repeat(70));
    if (content) {
      console.log(content);
    } else {
      console.log('(no content — file deleted or binary)');
    }
  });
}

function computeUnifiedDiff(filePath, oldContent, newContent) {
  const toStr = (c) => {
    if (c == null) return c;
    if (typeof c === 'string') return c;
    if (Buffer.isBuffer(c)) return c.toString('utf8');
    if (typeof c === 'object' && typeof c.content === 'string') return c.content;
    return String(c);
  };
  oldContent = toStr(oldContent);
  newContent = toStr(newContent);
  const oldLines = (oldContent || '').split(/\r?\n/);
  const newLines = (newContent || '').split(/\r?\n/);
  const diff = [];
  diff.push(`diff --git a${filePath} b${filePath}`);
  if (oldContent != null) diff.push(`--- a${filePath}`);
  else diff.push(`--- /dev/null`);
  if (newContent != null) diff.push(`+++ b${filePath}`);
  else diff.push(`+++ /dev/null`);

  let i = 0;
  let j = 0;
  const context = 3;

  // Myers LCS simplified: scan for changes and emit hunks
  while (i < oldLines.length || j < newLines.length) {
    // Skip matching lines
    while (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
    }

    if (i >= oldLines.length && j >= newLines.length) break;

    // Start of a change region
    const oldStart = i;
    const newStart = j;

    // Collect change run
    while (
      (i < oldLines.length && j < newLines.length && oldLines[i] !== newLines[j]) ||
      (i < oldLines.length && j >= newLines.length) ||
      (i >= oldLines.length && j < newLines.length)
    ) {
      // Try to re-sync: find next matching pair
      let found = false;
      for (let k = 0; k <= context && !found; k++) {
        for (let l = 0; l <= context && !found; l++) {
          if (
            i + k < oldLines.length &&
            j + l < newLines.length &&
            oldLines[i + k] === newLines[j + l] &&
            (k > 0 || l > 0)
          ) {
            // Advance through deletions/insertions before the re-sync point
            for (let d = 0; d < k; d++) i++;
            for (let a = 0; a < l; a++) j++;
            found = true;
          }
        }
      }
      if (!found) {
        // Consume remaining as changes
        i = oldLines.length;
        j = newLines.length;
      }
    }

    const oldCount = i - oldStart;
    const newCount = j - newStart;

    // Compute context window
    const ctxOldStart = Math.max(0, oldStart - context);
    const ctxNewStart = Math.max(0, newStart - context);
    const ctxOldEnd = Math.min(oldLines.length, i + context);
    const ctxNewEnd = Math.min(newLines.length, j + context);

    const hunkOldStart = ctxOldStart;
    const hunkNewStart = ctxNewStart;
    const hunkOldCount = ctxOldEnd - ctxOldStart;
    const hunkNewCount = ctxNewEnd - ctxNewStart;

    diff.push(`@@ -${hunkOldStart + 1},${hunkOldCount} +${hunkNewStart + 1},${hunkNewCount} @@`);

    let o = ctxOldStart;
    let n = ctxNewStart;
    while (o < ctxOldEnd || n < ctxNewEnd) {
      if (o < oldStart && o < oldLines.length && n < newStart && n < newLines.length && oldLines[o] === newLines[n]) {
        diff.push(' ' + oldLines[o]);
        o++;
        n++;
      } else if (o >= oldStart && o < i) {
        diff.push('-' + oldLines[o]);
        o++;
      } else if (n >= newStart && n < j) {
        diff.push('+' + newLines[n]);
        n++;
      } else if (o < ctxOldEnd && n < ctxNewEnd && oldLines[o] === newLines[n]) {
        diff.push(' ' + oldLines[o]);
        o++;
        n++;
      } else if (o < ctxOldEnd && (n >= ctxNewEnd || oldLines[o] !== newLines[n])) {
        diff.push('-' + oldLines[o]);
        o++;
      } else if (n < ctxNewEnd) {
        diff.push('+' + newLines[n]);
        n++;
      } else {
        break;
      }
    }
  }

  return diff.join('\n');
}

function printPatches(files) {
  files.forEach(({ path: filePath, changeType, patch }) => {
    const marker = changeType === 'add' ? 'ADDED' : changeType === 'delete' ? 'DELETED' : 'MODIFIED';
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`[${marker}] ${filePath}`);
    console.log('─'.repeat(70));
    if (patch) {
      console.log(patch);
    } else {
      console.log('(no diff — file deleted or binary)');
    }
  });
}

module.exports = { printWorkItem, printPullRequest, printCommentThreads, printWorkItemComments, printAttachments, stripHtml, printBranchDiff, printFileContents, computeUnifiedDiff, printPatches };
