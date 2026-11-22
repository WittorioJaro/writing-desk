'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('clipboard: blank lines between paragraphs become single paragraph breaks', async () => {
  const { clipboardForms } = await import('../src/renderer/clipboard.js');
  assert.equal(clipboardForms('just a phrase'), null);
  assert.equal(clipboardForms('line one\nline two'), null, 'no blank line: copy unchanged');
  assert.equal(clipboardForms('one paragraph\n\n'), null, 'trailing blank line alone: unchanged');
  const f = clipboardForms('First <para>.\n\nSecond & more.\n  \n\n\nThird\nwith a soft break.  \n');
  assert.equal(f.plain, 'First <para>.\nSecond & more.\nThird\nwith a soft break.');
  assert.equal(f.html, '<p>First &lt;para&gt;.</p><p>Second &amp; more.</p><p>Third<br>with a soft break.</p>');
  assert.equal(clipboardForms('a\r\n\r\nb').plain, 'a\nb');
});
