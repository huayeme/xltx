import {createBrowser} from './tool.mjs';

// The extension registers the tool only. The browser process starts with the
// first browser call and is closed when Pi shuts the session down.
export default function browserExtension(pi) {
  const browser = createBrowser({cwd: process.cwd()});
  pi.registerTool(browser.definition);
  pi.on('session_shutdown', () => browser.close());
}
