// Business dashboard page. The UI is real HTML/CSS/JS source files under ./dashboard/
// (easier to read and edit than hundreds of lines of JS inside a JS string), imported
// as TEXT — wrangler.toml has a Text rule for them. They carry a .txt extension for
// the JS/CSS parts because Wrangler would otherwise try to BUNDLE a .js import as
// code, and has no loader for .css.
//
// Assembled once at startup into a single page: the shell with the CSS and the four
// script parts (core, charts, pages, pages2) concatenated in order. The page holds no
// business data — every number arrives through the key-gated /api/dashboard/* API.

import shell from "./dashboard/shell.html";
import css from "./dashboard/styles.txt";
import core from "./dashboard/app.core.txt";
import charts from "./dashboard/app.charts.txt";
import pages from "./dashboard/app.pages.txt";
import pages2 from "./dashboard/app.pages2.txt";

// replacer FUNCTIONS, not strings: a string replacement would interpret `$&` / `$1`
// sequences that legitimately appear in the client script.
const PAGE = shell.replace("@@CSS@@", () => css).replace("@@JS@@", () => [core, charts, pages, pages2].join("\n"));

export function dashboardPage() {
  return PAGE;
}
