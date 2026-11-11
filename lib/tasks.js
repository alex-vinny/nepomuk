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
 * Project a Task is created in: the parent's own project (`System.TeamProject`). A bare parent id
 * resolves against the configured default project, but reading a work item is org-level, so the
 * parent can live in another project; creating there would put the child in the default project
 * with the parent's Area/Iteration, refused only by luck (an Activity missing from that process)
 * and otherwise created cross-project. The resolved project is used only when the parent did not
 * report its own.
 */
function taskProject(resolvedProject, parentFields = {}) {
  return parentFields['System.TeamProject'] || resolvedProject;
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

/**
 * The PATCH ops of `wi complete`: the hours always, the assignee and the state only when
 * asked. One PATCH, so a board that gates the state on CompletedWork or on Assigned To sees
 * every field at once — two calls would leave the hours written and the state refused.
 */
function completeOps({ hours, state, assignee } = {}) {
  const h = Number(hours);
  if (hours == null || hours === '' || !Number.isFinite(h) || h < 0) throw new Error(`invalid hours: ${hours}`);
  const ops = [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: h },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: 0 },
  ];
  if (assignee != null && String(assignee).trim()) ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: String(assignee).trim() });
  if (state != null && String(state).trim()) ops.push({ op: 'add', path: '/fields/System.State', value: String(state).trim() });
  return ops;
}

/**
 * True when a rule rejection is about the empty Assigned To. Azure names the field in prose
 * ("Rule Error for field Assigned To"), in the org's language, and the generic scraper only
 * catches quoted labels — so this one is matched directly.
 */
function rejectsMissingAssignee(message) {
  return /System\.AssignedTo|\bAssigned To\b|Atribu[íi]do a/i.test(String(message || ''));
}

/**
 * True when the only rule broken is "Remaining Work must be empty". Some processes empty
 * RemainingWork in Done: on a transition the server clears it, but on a task already in Done
 * an explicit 0 is refused (InvalidNotEmpty, seen 2026-11-05). The caller then drops the
 * RemainingWork op and validates again — empty is what the 0 meant.
 */
function onlyRemainingWorkMustBeEmpty(message) {
  const text = String(message || '');
  const fields = new Set([...text.matchAll(/"fieldReferenceName":"([^"]+)"/g)].map((m) => m[1]));
  if (fields.size) return fields.size === 1 && fields.has('Microsoft.VSTS.Scheduling.RemainingWork') && /InvalidNotEmpty/i.test(text);
  const rules = [...text.matchAll(/Rule Error for field ([^.]+)\./g)].map((m) => m[1].trim());
  return rules.length > 0 && rules.every((r) => r === 'Remaining Work') && /InvalidNotEmpty/i.test(text);
}

module.exports = { taskFields, taskProject, parsePlan, totalHours, completeOps, rejectsMissingAssignee, onlyRemainingWorkMustBeEmpty, DEFAULT_ACTIVITY };
