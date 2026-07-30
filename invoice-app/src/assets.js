// Bundled binary assets — the Barlow Bold title font (Google Font, OFL-licensed,
// downloaded from Google's official fonts repo) and the BojioVenue logo. Imported
// as raw binary data per the `rules` entry in wrangler.toml (Workers have no
// filesystem access at runtime, so these have to be bundled in, not read from disk).

import barlowBoldFont from "../assets/Barlow-Bold.ttf";
import logoPng from "../assets/logo.png";

export { barlowBoldFont, logoPng };
