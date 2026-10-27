'use strict';

// Pure helpers for `wi create-task` and `wi create-tasks`: the fields of a Task under a parent,
// and the plan file that a batch create reads. No network — the commands in index.js do the I/O.

const DEFAULT_ACTIVITY = 'Development';

/**
 * Fields of a Task created under `parentFields`. Area and Iteration always come from the parent;
 * the assignee comes from the task, then the command, then the parent — a Task with nobody on it
 * is the usual result of forgetting, not a choice.
 */
function taskFields({ title, hours, desc, activity, assignee } = {}, parentFields = {}) {
  if (!String(title || '').trim()) throw new Error('task without a title');
  const fields = { 'System.Title': String(title).trim() };
  if (parentFields['System.AreaPath']) fields['System.AreaPath'] = parentFields['System.AreaPath'];
  if (parentFields['System.IterationPath']) fields['System.IterationPath'] = parentFields['System.IterationPath'];
  if (desc) fields['System.Description'] = desc;
  // Activity is required on Tasks in some processes (TF401320 without it).
  fields['Microsoft.VSTS.Common.Activity'] = activity || DEFAULT_ACTIVITY;
  if (hours != null && hours !== '') {
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 0) throw new Error(`invalid hours for "${title}": ${hours}`);
    fields['Microsoft.VSTS.Scheduling.OriginalEstimate'] = h;
    fields['Microsoft.VSTS.Scheduling.RemainingWork'] = h;
  }
  const pa = parentFields['System.AssignedTo'];
  const who = assignee || (pa && (pa.uniqueName || pa.displayName));
  if (who) fields['System.AssignedTo'] = who;
  return fields;
}

/**
 * Reads a plan: either a list of tasks, or an object keyed by parent id (one file for several
 * parents). Each task takes `title` (or `titulo`), `hours` (or `horas`), and optional `desc`,
 * `activity`, `assignee`. Every task is checked before anything is created: a plan that fails
 * halfway leaves a parent with half its tasks.
 */
function parsePlan(plan, parentId) {
  let list = plan;
  if (!Array.isArray(plan)) {
    if (!plan || typeof plan !== 'object') throw new Error('plan must be a list of tasks or an object keyed by parent id');
    list = plan[String(parentId)];
    if (!list) throw new Error(`plan has no tasks for parent #${parentId} (keys: ${Object.keys(plan).join(', ') || 'none'})`);
  }
  if (!Array.isArray(list) || !list.length) throw new Error(`plan for parent #${parentId} is empty`);
  const errors = [];
  const tasks = list.map((t, i) => {
    const title = t && (t.title ?? t.titulo);
    const hours = t && (t.hours ?? t.horas);
    if (!String(title || '').trim()) errors.push(`task ${i + 1}: missing title`);
    if (hours != null && (!Number.isFinite(Number(hours)) || Number(hours) < 0)) errors.push(`task ${i + 1}: invalid hours "${hours}"`);
    return { title: title && String(title).trim(), hours: hours == null ? null : Number(hours), desc: t && t.desc, activity: t && t.activity, assignee: t && t.assignee };
  });
  if (errors.length) throw new Error('plan rejected, nothing created:\n  ' + errors.join('\n  '));
  return tasks;
}

/** Total of the estimates that were given; tasks without hours do not count. */
function totalHours(tasks) {
  return tasks.reduce((sum, t) => sum + (t.hours == null ? 0 : t.hours), 0);
}

module.exports = { taskFields, parsePlan, totalHours, DEFAULT_ACTIVITY };
