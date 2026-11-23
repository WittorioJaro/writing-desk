// Copying out of the editor. Writers often leave a blank line between paragraphs while writing, but rich
// editors (like X's article editor) already space their paragraphs, so a blank line pasted there
// becomes an extra empty paragraph. When a copied selection spans paragraphs, the clipboard gets
// one paragraph per <p> (HTML) and one paragraph per line (plain text), with no empty lines.

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Clipboard forms for a copied selection, or null when it has no blank lines (copy as is). */
export function clipboardForms(text) {
  const t = text.replace(/\r\n?/g, '\n');
  if (!/\n[ \t]*\n/.test(t.trim())) return null;
  const paras = t.split(/\n[ \t]*(?:\n[ \t]*)+/).map((p) => p.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '')).filter((p) => p.trim());
  return {
    plain: paras.join('\n'),
    html: paras.map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`).join(''),
  };
}
