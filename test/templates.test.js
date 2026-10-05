import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, renderTemplate, describeTemplate, shiftDate } from '../server/templates.js';

const now = new Date(2026, 9, 5, 14, 7, 9); // Mon Oct 5 2026 14:07:09

test('formatDate supports common tokens and literals', () => {
  assert.equal(formatDate(now), '2026-10-05');
  assert.equal(formatDate(now, 'dddd, MMMM D, YYYY'), 'Monday, October 5, 2026');
  assert.equal(formatDate(now, 'ddd MMM D YY'), 'Mon Oct 5 26');
  assert.equal(formatDate(now, 'h:mm A'), '2:07 PM');
  assert.equal(formatDate(now, 'HH:mm:ss'), '14:07:09');
  assert.equal(formatDate(now, '[Week of] MMM D'), 'Week of Oct 5');
});

test('shiftDate handles day/week/month/year offsets', () => {
  assert.equal(formatDate(shiftDate(now, '+1d')), '2026-10-06');
  assert.equal(formatDate(shiftDate(now, '-1w')), '2026-09-28');
  assert.equal(formatDate(shiftDate(now, '+3m')), '2027-01-05');
  assert.equal(formatDate(shiftDate(now, '-1y')), '2025-10-05');
});

test('renderTemplate fills variables, prompts and cursor', () => {
  const tpl = '# {{title}}\nDate: {{date}} {{time}}\nTomorrow: [[{{tomorrow}}]] / {{date+2d:ddd}}\nWith: {{prompt:Attendees}}\nStatus: {{prompt:Status|open}}\n- {{cursor}}\n';
  const r = renderTemplate(tpl, { title: 'Kickoff', now, answers: { Attendees: 'Ana, Ben' } });
  assert.equal(r.title, 'Kickoff');
  assert.equal(r.content, '# Kickoff\nDate: 2026-10-05 14:07\nTomorrow: [[2026-10-06]] / Wed\nWith: Ana, Ben\nStatus: open\n- \n');
  assert.equal(r.cursor, r.content.indexOf('- \n') + 2);
});

test('template-name and template-folder are applied and stripped', () => {
  const tpl = '---\ntemplate-name: "{{date}} {{prompt:Meeting title}}"\ntemplate-folder: Meetings/{{date:YYYY}}\ntype: meeting\n---\n# {{prompt:Meeting title}}\n';
  const r = renderTemplate(tpl, { now, answers: { 'Meeting title': 'Design review' } });
  assert.equal(r.title, '2026-10-05 Design review');
  assert.equal(r.folder, 'Meetings/2026');
  assert.equal(r.content, '---\ntype: meeting\n---\n# Design review\n');
});

test('frontmatter containing only template settings is removed entirely', () => {
  const r = renderTemplate('---\ntemplate-folder: Projects\n---\n# {{title}}\n', { title: 'Apollo', now });
  assert.equal(r.content, '# Apollo\n');
  assert.equal(r.folder, 'Projects');
});

test('titles are sanitized into safe file names', () => {
  const r = renderTemplate('x', { title: 'Q3/Q4: plan?', now });
  assert.equal(r.title, 'Q3-Q4- plan-');
  assert.equal(renderTemplate('x', { title: '../../etc', now }).title, '..-..-etc'.replace(/^\.+/, ''));
});

test('describeTemplate lists unique prompts', () => {
  const d = describeTemplate('---\ntemplate-name: "{{prompt:A}}"\n---\n{{prompt:A}} {{prompt:B|x}} {{ prompt:B }}');
  assert.deepEqual(d.prompts, [{ label: 'A', default: '' }, { label: 'B', default: 'x' }]);
  assert.equal(d.namePattern, '{{prompt:A}}');
});
