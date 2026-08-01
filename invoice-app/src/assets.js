// Bundled binary assets, imported as raw binary data per the `rules` entry in
// wrangler.toml (Workers have no filesystem access at runtime, so these have to be
// bundled in, not read from disk):
//   - Barlow Bold: title font for the Agreement/Deduction Addendum identity
//     (branding.js) — Google Font, OFL-licensed, from Google's official fonts repo.
//   - Open Sans Regular/Bold (Addendum 6): body/title font for the Money Document
//     identity (brandingMoney.js) — Google Font, OFL-licensed, downloaded from the
//     canonical googlefonts/opensans source repo's static build (Google's own repo
//     only ships a variable-font instance, which pdf-lib/fontkit can't render at a
//     fixed weight — see assets/README note in the Addendum 6 commit).
//   - logo.png: the BojioVenue logo.
//   - mascot.png (Addendum 6): watermark used on money documents — downsized from
//     Kenneth's original "Sunglass on head.png" (2.4MB, 4000px+ source) to 500x500
//     with ImageMagick, alpha channel preserved, purely to keep the Worker bundle
//     small; a watermark doesn't need source resolution.

import barlowBoldFont from "../assets/Barlow-Bold.ttf";
import openSansFont from "../assets/OpenSans-Regular.ttf";
import openSansBoldFont from "../assets/OpenSans-Bold.ttf";
import logoPng from "../assets/logo.png";
import mascotPng from "../assets/mascot.png";

export { barlowBoldFont, openSansFont, openSansBoldFont, logoPng, mascotPng };
